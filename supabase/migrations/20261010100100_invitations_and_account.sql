-- U2 — Invitations, acceptance, password flows, basic account page
-- (approved 2026-10-10). DATABASE side only; applied as one unit.
--
--   1. profiles.phone (nullable text).
--   2. public.admin_invitations — hashed single-use links for kind 'invite'
--      (new staff account) and 'reset' (password reset of an existing account).
--      The plain token NEVER reaches the database: the app stores
--      token_hash = lower-hex SHA-256 of the UTF-8 bytes of the base64url token
--      string exactly as it appears in the URL.
--      Access: NO anon/authenticated privileges at all (not even SELECT — the
--      token_hash must never be client-readable). The app server writes via the
--      service client (service_role bypasses RLS). Managers read through
--      list_invitations(), which never returns token_hash.
--   3. pgcrypto ensured in schema extensions (Supabase default; no-op when
--      present). The RPCs hash with pg_catalog.sha256() — core PostgreSQL,
--      byte-identical to extensions.digest(x,'sha256'), immune to search_path
--      and to pgcrypto living in a different schema.
--   4. RPCs:
--        consume_admin_link(text)            → jsonb    service_role only
--        finalize_admin_link(uuid, uuid)     → boolean  service_role only
--        revoke_user_sessions(uuid, uuid)    → integer  service_role only
--        list_invitations()                  → setof    authenticated (manager guard)
--        log_admin_event(...)                → void     authenticated (staff guard) + service_role
--   5. admin_audit_log action CHECK widened with the 7 U2 values (every
--      existing value kept, incl. ownership_transfer). Pure widening; the
--      append-only immutability triggers are untouched (they guard UPDATE /
--      DELETE / TRUNCATE only — INSERT from SECURITY DEFINER code is the
--      designed write path).
--
-- NOT touched: guard_profile_changes / guard_profile_delete (owner wall,
-- hierarchy), salma_block_public_signup, profiles_admin_audit, content anything.

-- ===========================================================================
-- 1. profiles.phone
-- ===========================================================================
alter table public.profiles add column if not exists phone text;

-- ===========================================================================
-- 2. pgcrypto (Supabase installs it in schema extensions; no-op if present)
-- ===========================================================================
create extension if not exists pgcrypto with schema extensions;

-- ===========================================================================
-- 3. admin_invitations
-- ===========================================================================
-- Derived status (list_invitations computes it; never stored):
--   cancelled_at or superseded_by set → 'cancelled'
--   accepted_at set                    → 'accepted'
--   expires_at <= now()                → 'expired'
--   else                               → 'pending'
create table if not exists public.admin_invitations (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('invite','reset')),
  email            text not null check (btrim(email) <> '' and char_length(email) <= 320),
  role             text check (role in ('editor','admin','super_admin')),
  target_user_id   uuid references public.profiles(id) on delete cascade,
  token_hash       text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by       uuid references public.profiles(id) on delete set null,
  invited_by_name  text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  accepted_at      timestamptz,
  cancelled_at     timestamptz,
  superseded_by    uuid references public.admin_invitations(id) on delete set null,
  accepted_user_id uuid,   -- no FK on purpose: history outlives the account
  constraint admin_invitations_kind_shape check (
    (kind = 'invite' and role is not null and target_user_id is null)
    or
    (kind = 'reset'  and role is null     and target_user_id is not null)
  ),
  constraint admin_invitations_not_self_superseded check (superseded_by is distinct from id)
);

-- token_hash lookups are served by the UNIQUE constraint's index.
create index if not exists admin_invitations_email_kind_idx
  on public.admin_invitations (email, kind);
create index if not exists admin_invitations_created_idx
  on public.admin_invitations (created_at desc);

-- At most ONE open link per invited email / per reset target. "Open" = not
-- accepted, cancelled or superseded (an expired-but-unactioned row still counts,
-- so it must be reissued/cancelled rather than duplicated). The app marks the
-- old row superseded/cancelled BEFORE inserting its replacement.
create unique index if not exists admin_invitations_one_open_invite
  on public.admin_invitations (email)
  where kind = 'invite'
    and accepted_at is null and cancelled_at is null and superseded_by is null;
create unique index if not exists admin_invitations_one_open_reset
  on public.admin_invitations (target_user_id)
  where kind = 'reset'
    and accepted_at is null and cancelled_at is null and superseded_by is null;

-- ---- Access: no client privileges at all; service_role keeps its grants ----
alter table public.admin_invitations enable row level security;
-- Deliberately NO policies (authenticated/anon have no privileges anyway;
-- service_role bypasses RLS).
revoke all on table public.admin_invitations from public, anon, authenticated;

comment on table public.admin_invitations is
  'U2: hashed single-use invite / password-reset links. token_hash = sha256 hex of the URL token; plain token never stored. No client access — service client writes, managers read via list_invitations().';

-- ===========================================================================
-- 4. admin_audit_log action CHECK — + 7 U2 values (all existing kept)
-- ===========================================================================
do $$ begin
  alter table public.admin_audit_log drop constraint if exists admin_audit_log_action_check;
  alter table public.admin_audit_log
    add constraint admin_audit_log_action_check
    check (action in (
      'user_created','role_changed','user_suspended','user_reactivated',
      'profile_updated','email_changed','denied_attempt','ownership_transfer',
      'invitation_created','invitation_reissued','invitation_cancelled',
      'invitation_accepted','password_changed','password_reset_link_created',
      'password_reset_completed'));
end $$;

-- ===========================================================================
-- 5a. consume_admin_link — NON-DESTRUCTIVE validation (peek + pre-accept)
-- ===========================================================================
-- Reports whether the link is usable. It never marks anything: acceptance is
-- finalize_admin_link. NOTE: the FOR UPDATE below is released when this RPC
-- returns (each PostgREST call is its own transaction), so it does NOT hold the
-- link across the caller's later steps. Real single-use safety comes from
-- (a) GoTrue's unique email constraint (a second createUser for the same
-- invite fails) and (b) finalize_admin_link re-checking "still pending" under
-- its own row lock — the app finalizes BEFORE elevating/changing anything.
-- Reason codes (checked in this order):
--   'not_found'  no row for that hash (or empty / oversized input)
--   'used'       accepted_at set
--   'cancelled'  cancelled_at set, or superseded_by set (reissued)
--   'expired'    expires_at <= now()
create or replace function public.consume_admin_link(p_token_plain text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.admin_invitations;
begin
  if p_token_plain is null or p_token_plain = '' or char_length(p_token_plain) > 512 then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select i.* into v_row
    from public.admin_invitations i
   where i.token_hash = pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(p_token_plain, 'UTF8')), 'hex')
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_row.accepted_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;
  if v_row.cancelled_at is not null or v_row.superseded_by is not null then
    return jsonb_build_object('ok', false, 'reason', 'cancelled');
  end if;
  if v_row.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  return jsonb_build_object(
    'ok',             true,
    'id',             v_row.id,
    'kind',           v_row.kind,
    'email',          v_row.email,
    'role',           v_row.role,
    'target_user_id', v_row.target_user_id,
    'invited_by',     v_row.invited_by,
    'expires_at',     v_row.expires_at);
end;
$$;

comment on function public.consume_admin_link(text) is
  'U2: validate a plain link token (sha256 lookup) WITHOUT consuming it. {ok:true,id,kind,email,role,target_user_id,invited_by,expires_at} | {ok:false,reason:not_found|used|cancelled|expired}. service_role only.';

revoke all on function public.consume_admin_link(text) from public, anon, authenticated;
grant execute on function public.consume_admin_link(text) to service_role;

-- ===========================================================================
-- 5b. finalize_admin_link — single-use burn
-- ===========================================================================
-- Marks the link accepted only if it is STILL pending (not accepted, not
-- cancelled, not superseded, not expired) under a row lock; false otherwise.
create or replace function public.finalize_admin_link(p_id uuid, p_accepted_user uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.admin_invitations;
begin
  if p_id is null or p_accepted_user is null then
    raise exception 'finalize_admin_link: p_id and p_accepted_user are required'
      using errcode = '22023';
  end if;

  select i.* into v_row
    from public.admin_invitations i
   where i.id = p_id
   for update;

  if not found
     or v_row.accepted_at  is not null
     or v_row.cancelled_at is not null
     or v_row.superseded_by is not null
     or v_row.expires_at <= now() then
    return false;
  end if;

  update public.admin_invitations
     set accepted_at = now(),
         accepted_user_id = p_accepted_user
   where id = p_id;

  return true;
end;
$$;

comment on function public.finalize_admin_link(uuid, uuid) is
  'U2: mark a still-pending link accepted (FOR UPDATE). Returns false if not pending. service_role only.';

revoke all on function public.finalize_admin_link(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_admin_link(uuid, uuid) to service_role;

-- ===========================================================================
-- 5c. revoke_user_sessions — kill a user's sessions (optionally keep one)
-- ===========================================================================
-- Revokes every un-revoked refresh token of the user (except those of the kept
-- session), then deletes the user's auth.sessions rows (except the kept one).
-- Returns the number of refresh tokens revoked. Access tokens already issued
-- stay valid until their JWT expiry (GoTrue limitation); the app's per-request
-- profile checks remain the wall for suspension.
create or replace function public.revoke_user_sessions(
  p_user_id         uuid,
  p_keep_session_id uuid default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_revoked integer := 0;
begin
  if p_user_id is null then
    raise exception 'revoke_user_sessions: p_user_id is required' using errcode = '22023';
  end if;

  update auth.refresh_tokens rt
     set revoked = true,
         updated_at = now()
   where rt.user_id = p_user_id::text
     and rt.revoked = false
     and (p_keep_session_id is null or rt.session_id is distinct from p_keep_session_id);
  get diagnostics v_revoked = row_count;

  delete from auth.sessions s
   where s.user_id = p_user_id
     and (p_keep_session_id is null or s.id <> p_keep_session_id);

  return v_revoked;
end;
$$;

comment on function public.revoke_user_sessions(uuid, uuid) is
  'U2: revoke a user''s refresh tokens + delete auth.sessions, optionally keeping one session. Returns refresh tokens revoked. service_role only.';

revoke all on function public.revoke_user_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid, uuid) to service_role;

-- ===========================================================================
-- 5d. list_invitations — manager read path (NEVER returns token_hash)
-- ===========================================================================
create or replace function public.list_invitations()
returns table (
  id               uuid,
  kind             text,
  email            text,
  role             text,
  target_user_id   uuid,
  invited_by       uuid,
  invited_by_name  text,
  created_at       timestamptz,
  expires_at       timestamptz,
  accepted_at      timestamptz,
  cancelled_at     timestamptz,
  superseded_by    uuid,
  accepted_user_id uuid,
  status           text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not coalesce(public.is_admin_manager(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select i.id, i.kind, i.email, i.role, i.target_user_id,
         i.invited_by, i.invited_by_name, i.created_at, i.expires_at,
         i.accepted_at, i.cancelled_at, i.superseded_by, i.accepted_user_id,
         (case
            when i.cancelled_at is not null or i.superseded_by is not null then 'cancelled'
            when i.accepted_at  is not null then 'accepted'
            when i.expires_at  <= now()     then 'expired'
            else 'pending'
          end)::text
    from public.admin_invitations i
   order by i.created_at desc, i.id;
end;
$$;

comment on function public.list_invitations() is
  'U2: all invitation/reset rows (both kinds) with derived status; every column EXCEPT token_hash. Managers only (owner / super_admin).';

revoke all on function public.list_invitations() from public, anon;
grant execute on function public.list_invitations() to authenticated, service_role;

-- ===========================================================================
-- 5e. log_admin_event — app-side audit events (U2 flows)
-- ===========================================================================
-- Actor resolution:
--   * authenticated (non-service) caller: must be is_staff(); actor is ALWAYS
--     auth.uid() — p_actor is ignored, so a signed-in user cannot spoof one.
--   * service_role caller: auth.uid() profile if any; else p_actor naming an
--     existing profile → that profile, details.via = 'service'; else
--     actor_kind 'system', actor_name 'النظام' (details.unresolved_actor holds
--     an unknown p_actor, if one was given).
-- Inputs are whitelisted / length-bounded; details must be ≤ 4000 chars of
-- JSON (otherwise replaced by {"truncated": true}); a non-object details value
-- is wrapped as {"value": ...}. The caller cannot override 'via'.
create or replace function public.log_admin_event(
  p_action       text,
  p_target       uuid,
  p_target_email text,
  p_before       text,
  p_after        text,
  p_details      jsonb,
  p_actor        uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_is_service boolean := coalesce(auth.role() = 'service_role', false)
                          or coalesce((auth.jwt() ->> 'role') = 'service_role', false);
  v_uid        uuid    := auth.uid();
  v_action     text    := btrim(coalesce(p_action, ''));
  v_actor_id   uuid;
  v_actor_name text;
  v_actor_role text;
  v_kind       text;
  v_via        text;
  v_unresolved uuid;
  v_t_name     text;
  v_t_email    text;
  v_details    jsonb;
begin
  -- Guard: service_role, or an active staff member.
  if not v_is_service and not coalesce(public.is_staff(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_action not in (
      'user_created','role_changed','user_suspended','user_reactivated',
      'profile_updated','email_changed','denied_attempt','ownership_transfer',
      'invitation_created','invitation_reissued','invitation_cancelled',
      'invitation_accepted','password_changed','password_reset_link_created',
      'password_reset_completed') then
    raise exception 'log_admin_event: invalid action %', quote_literal(left(p_action, 64))
      using errcode = '22023';
  end if;

  -- Per-caller-class action allowlist. Authenticated (non-service) callers can
  -- only record what the app writes through their own session:
  --   staff   : password_changed / profile_updated — own row only (p_target is
  --             forced to auth.uid(), whatever was passed);
  --   manager : additionally the link-management events, any target.
  -- Everything else (user_created, role_changed, user_suspended,
  -- user_reactivated, email_changed, ownership_transfer, invitation_accepted,
  -- password_reset_completed, denied_attempt) belongs to service_role or to the
  -- DB triggers / log_admin_denied(), never to a direct authenticated call.
  if not v_is_service then
    if v_action in ('password_changed','profile_updated') then
      p_target := v_uid;
    elsif v_action in ('invitation_created','invitation_reissued',
                       'invitation_cancelled','password_reset_link_created')
          and coalesce(public.is_admin_manager(), false) then
      null;  -- manager-only events: any target allowed
    else
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  -- 1. Signed-in actor (always wins; the only path for authenticated callers).
  if v_uid is not null then
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email), p.role
      into v_actor_id, v_actor_name, v_actor_role
      from public.profiles p where p.id = v_uid;
  end if;

  -- 2. Service-role supplied actor.
  if v_actor_id is null and v_is_service and p_actor is not null then
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email), p.role
      into v_actor_id, v_actor_name, v_actor_role
      from public.profiles p where p.id = p_actor;
    if v_actor_id is not null then
      v_via := 'service';
    else
      v_unresolved := p_actor;
    end if;
  end if;

  -- 3. System.
  if v_actor_id is null then
    v_kind       := 'system';
    v_actor_name := 'النظام';
    v_actor_role := null;
  else
    v_kind := 'user';
  end if;

  -- Target snapshot.
  if p_target is not null then
    select p.full_name, p.email into v_t_name, v_t_email
      from public.profiles p where p.id = p_target;
  end if;

  -- Details: object only, bounded, server keys win.
  if p_details is null or jsonb_typeof(p_details) = 'null' then
    v_details := '{}'::jsonb;
  elsif jsonb_typeof(p_details) <> 'object' then
    v_details := jsonb_build_object('value', p_details);
  else
    v_details := p_details;
  end if;
  if char_length(v_details::text) > 4000 then
    v_details := jsonb_build_object('truncated', true);
  end if;
  v_details := (v_details - 'via' - 'unresolved_actor')
               || jsonb_strip_nulls(jsonb_build_object(
                    'via', v_via, 'unresolved_actor', v_unresolved));

  insert into public.admin_audit_log
    (action, actor_id, actor_name, actor_role, actor_kind,
     target_id, target_name, target_email, before_value, after_value, details)
  values
    (v_action, v_actor_id, v_actor_name, v_actor_role, v_kind,
     p_target,
     left(v_t_name, 200),
     left(coalesce(nullif(btrim(p_target_email), ''), v_t_email), 320),
     left(p_before, 500),
     left(p_after, 500),
     nullif(v_details, '{}'::jsonb));
end;
$$;

comment on function public.log_admin_event(text, uuid, text, text, text, jsonb, uuid) is
  'U2: append an admin_audit_log event. Authenticated callers must be staff and are always the actor (p_actor ignored); service_role may name p_actor (details.via=service) else system.';

revoke all on function public.log_admin_event(text, uuid, text, text, text, jsonb, uuid) from public, anon;
grant execute on function public.log_admin_event(text, uuid, text, text, text, jsonb, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- ROLLBACK (manual, in this order):
-- 1. drop function if exists public.log_admin_event(text, uuid, text, text, text, jsonb, uuid);
--    drop function if exists public.list_invitations();
--    drop function if exists public.revoke_user_sessions(uuid, uuid);
--    drop function if exists public.finalize_admin_link(uuid, uuid);
--    drop function if exists public.consume_admin_link(text);
-- 2. drop table if exists public.admin_invitations;   -- discards pending links
-- 3. CHECK narrowing ONLY while no admin_audit_log row uses a U2 action
--    (append-only: such rows cannot be removed) — otherwise leave it widened:
--    re-run step 1 of 20261010000100_ownership_transfer.sql.
-- 4. alter table public.profiles drop column if exists phone;   -- discards data
-- 5. pgcrypto: leave installed (Supabase default; other code may rely on it).
-- ===========================================================================
