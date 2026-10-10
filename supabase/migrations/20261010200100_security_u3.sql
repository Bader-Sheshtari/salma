-- U3 — MFA, session security, sensitive-action re-auth, security log
-- (approved 2026-10-10). DATABASE side only; applied as one unit.
--
--   1. profiles.password_changed_at (nullable timestamptz). NO backfill — an
--      unknown value stays NULL and the UI shows «غير معروف»; never fabricated.
--   2. public.session_reauth — one row per auth session that recently passed
--      the re-auth step (password [+ TOTP]). NO anon/authenticated privileges
--      at all; the app server reads/writes via the service client
--      (service_role bypasses RLS). Written only through record_reauth().
--   3. admin_audit_log action CHECK widened with the 6 U3 values (all 15
--      existing values kept). Pure widening; the append-only immutability
--      triggers are untouched.
--   4. log_admin_event re-created — body identical to
--      20261010100100_invitations_and_account.sql except:
--        * valid-action list += the 6 U3 values;
--        * authenticated staff self-target set += mfa_enabled, mfa_disabled,
--          mfa_reconfigured, sensitive_reauth_completed, sessions_revoked
--          (p_target forced to auth.uid());
--        * managers += security_setting_changed (any target; the app enforces
--          the hierarchy before calling);
--        * service_role unchanged (every valid action).
--   5. RPCs:
--        record_reauth(uuid, uuid)                       → void   service_role only
--        list_security_events(date, date, uuid, text,
--                             uuid, timestamptz, bigint, int) → setof admin_audit_log
--                                                         authenticated (owner / super_admin)
--        my_security_events(int)                         → setof admin_audit_log
--                                                         authenticated (staff)
--   6. public.mfa_satisfied() + is_staff() / is_admin() / is_admin_manager()
--      re-created with `and public.mfa_satisfied()` — DB-level MFA enforcement
--      (closes the PostgREST aal1 bypass: a session that has a verified TOTP
--      factor but is still aal1 gets NO staff/admin RLS access).
--   7. admin_audit_log direct SELECT → OWNER-ONLY (super_admins read only via
--      the scoped list_security_events RPC).
--   8. auth.mfa_factors AFTER INSERT/UPDATE/DELETE audit trigger — the DB is
--      the source of truth for mfa_enabled / mfa_disabled (never raises).
--   9. guard_profile_changes v4 — v3 (20261009100100) verbatim + ONE rule (e):
--      an authenticated actor changing role/disabled on ANOTHER user's row
--      needs a session_reauth marker for THIS session (≤ 15 minutes).
--
-- NOT touched: guard_profile_delete, owner wall / hierarchy rules (verbatim in
-- v4), salma_block_public_signup, profiles_admin_audit, admin_invitations +
-- consume/finalize/revoke/list RPCs, admin_audit_log immutability, content
-- policies (they inherit the MFA requirement through is_staff()/is_admin()).

-- ===========================================================================
-- 1. profiles.password_changed_at
-- ===========================================================================
alter table public.profiles add column if not exists password_changed_at timestamptz;

comment on column public.profiles.password_changed_at is
  'U3: last password change/reset (own change: actor session; reset: service client). NULL = unknown (no backfill).';

-- ===========================================================================
-- 2. session_reauth
-- ===========================================================================
-- A session counts as "recently re-authenticated" while
-- verified_at > now() - interval '15 minutes' (checked app-side, matching both
-- session_id AND user_id — and DB-side by guard_profile_changes rule (e), §9). Rows older than 1 day are pruned opportunistically
-- by record_reauth(); stale rows are harmless (they fail the 15-min window).
create table if not exists public.session_reauth (
  session_id  uuid primary key,
  user_id     uuid not null,
  verified_at timestamptz not null default now()
);

-- ---- Access: no client privileges at all; service_role keeps its grants ----
alter table public.session_reauth enable row level security;
-- Deliberately NO policies (authenticated/anon have no privileges anyway;
-- service_role bypasses RLS).
revoke all on table public.session_reauth from public, anon, authenticated;

comment on table public.session_reauth is
  'U3: per-session recent re-auth marker (sensitive actions, 15-min window enforced app-side and by guard_profile_changes for role/disabled changes). No client access — service client only, written via record_reauth().';

-- ---- record_reauth — upsert the marker + prune (> 1 day) -----------------
create or replace function public.record_reauth(p_user uuid, p_session uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user is null or p_session is null then
    raise exception 'record_reauth: p_user and p_session are required'
      using errcode = '22023';
  end if;

  -- Opportunistic prune.
  delete from public.session_reauth r
   where r.verified_at < now() - interval '1 day';

  insert into public.session_reauth as r (session_id, user_id, verified_at)
  values (p_session, p_user, now())
  on conflict (session_id) do update
     set user_id     = excluded.user_id,
         verified_at = excluded.verified_at;
end;
$$;

comment on function public.record_reauth(uuid, uuid) is
  'U3: mark (user, session) as re-authenticated now (upsert) and prune markers older than 1 day. service_role only.';

revoke all on function public.record_reauth(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_reauth(uuid, uuid) to service_role;

-- ===========================================================================
-- 3. admin_audit_log action CHECK — + 6 U3 values (all 15 existing kept)
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
      'password_reset_completed',
      'mfa_enabled','mfa_disabled','mfa_reconfigured',
      'sensitive_reauth_completed','sessions_revoked','security_setting_changed'));
end $$;

-- ===========================================================================
-- 4. log_admin_event — app-side audit events (U2 flows + U3 security events)
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
      'password_reset_completed',
      'mfa_enabled','mfa_disabled','mfa_reconfigured',
      'sensitive_reauth_completed','sessions_revoked','security_setting_changed') then
    raise exception 'log_admin_event: invalid action %', quote_literal(left(p_action, 64))
      using errcode = '22023';
  end if;

  -- Per-caller-class action allowlist. Authenticated (non-service) callers can
  -- only record what the app writes through their own session:
  --   staff   : password_changed / profile_updated / mfa_enabled /
  --             mfa_disabled / mfa_reconfigured / sensitive_reauth_completed /
  --             sessions_revoked — own row only (p_target is forced to
  --             auth.uid(), whatever was passed);
  --   manager : additionally the link-management events and
  --             security_setting_changed, any target (the app enforces the
  --             manageable-target hierarchy before calling).
  -- Everything else (user_created, role_changed, user_suspended,
  -- user_reactivated, email_changed, ownership_transfer, invitation_accepted,
  -- password_reset_completed, denied_attempt) belongs to service_role or to the
  -- DB triggers / log_admin_denied(), never to a direct authenticated call.
  if not v_is_service then
    if v_action in ('password_changed','profile_updated',
                    'mfa_enabled','mfa_disabled','mfa_reconfigured',
                    'sensitive_reauth_completed','sessions_revoked') then
      p_target := v_uid;
    elsif v_action in ('invitation_created','invitation_reissued',
                       'invitation_cancelled','password_reset_link_created',
                       'security_setting_changed')
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
  'U2/U3: append an admin_audit_log event. Authenticated callers must be staff and are always the actor (p_actor ignored); service_role may name p_actor (details.via=service) else system.';

revoke all on function public.log_admin_event(text, uuid, text, text, text, jsonb, uuid) from public, anon;
grant execute on function public.log_admin_event(text, uuid, text, text, text, jsonb, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 5a. list_security_events — security log viewer (/admin/security)
-- ===========================================================================
-- Scoping (caller = auth.uid(), must be an ACTIVE owner / super_admin):
--   owner       → every row;
--   super_admin → rows that neither have an owner/super_admin actor (actor_role
--                 snapshot) nor target a CURRENT owner/super_admin profile —
--                 plus, always, the caller's own rows (actor or target);
--   anyone else → 42501.
-- Filters are optional (NULL = no filter). p_from / p_to are Kuwait calendar
-- days, inclusive (same convention as search_content). p_action must be a
-- valid audit action (22023 otherwise). Keyset pagination on
-- (created_at desc, id desc): pass the last row's (created_at, id) as
-- (p_cursor_ts, p_cursor_id) — both or neither (22023 otherwise).
-- p_limit is clamped to 1..100 (NULL → 50).
create or replace function public.list_security_events(
  p_from      date        default null,
  p_to        date        default null,
  p_actor     uuid        default null,
  p_action    text        default null,
  p_target    uuid        default null,
  p_cursor_ts timestamptz default null,
  p_cursor_id bigint      default null,
  p_limit     int         default 50
)
returns setof public.admin_audit_log
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid    uuid := auth.uid();
  v_role   text;
  v_action text := nullif(btrim(coalesce(p_action, '')), '');
  v_from   timestamptz;
  v_to     timestamptz;
  v_limit  int  := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if v_uid is not null then
    select p.role into v_role
      from public.profiles p
     where p.id = v_uid
       and p.disabled = false;
  end if;

  if v_role is null or v_role not in ('owner','super_admin')
     or not coalesce(public.mfa_satisfied(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_action is not null and v_action not in (
      'user_created','role_changed','user_suspended','user_reactivated',
      'profile_updated','email_changed','denied_attempt','ownership_transfer',
      'invitation_created','invitation_reissued','invitation_cancelled',
      'invitation_accepted','password_changed','password_reset_link_created',
      'password_reset_completed',
      'mfa_enabled','mfa_disabled','mfa_reconfigured',
      'sensitive_reauth_completed','sessions_revoked','security_setting_changed') then
    raise exception 'list_security_events: invalid action %', quote_literal(left(p_action, 64))
      using errcode = '22023';
  end if;

  if (p_cursor_ts is null) <> (p_cursor_id is null) then
    raise exception 'list_security_events: p_cursor_ts and p_cursor_id go together'
      using errcode = '22023';
  end if;

  if p_from is not null then
    v_from := p_from::timestamp at time zone 'Asia/Kuwait';
  end if;
  if p_to is not null then
    v_to := (p_to + 1)::timestamp at time zone 'Asia/Kuwait';
  end if;

  return query
  select l.*
    from public.admin_audit_log l
   where (v_from    is null or l.created_at >= v_from)
     and (v_to      is null or l.created_at <  v_to)
     and (p_actor   is null or l.actor_id  = p_actor)
     and (v_action  is null or l.action    = v_action)
     and (p_target  is null or l.target_id = p_target)
     and (p_cursor_ts is null or (l.created_at, l.id) < (p_cursor_ts, p_cursor_id))
     and (
       v_role = 'owner'
       or l.actor_id  = v_uid
       or l.target_id = v_uid
       or not (
         coalesce(l.actor_role, '') in ('owner','super_admin')
         or exists (
           select 1 from public.profiles tp
            where tp.id = l.target_id
              and tp.role in ('owner','super_admin'))
       )
     )
   order by l.created_at desc, l.id desc
   limit v_limit;
end;
$$;

comment on function public.list_security_events(date, date, uuid, text, uuid, timestamptz, bigint, int) is
  'U3: admin_audit_log rows for the security log viewer. owner → all; super_admin → rows not involving an owner/super_admin actor or target, plus own rows; others 42501. Keyset (created_at desc, id desc); p_limit clamped 1..100.';

revoke all on function public.list_security_events(date, date, uuid, text, uuid, timestamptz, bigint, int) from public, anon;
grant execute on function public.list_security_events(date, date, uuid, text, uuid, timestamptz, bigint, int)
  to authenticated, service_role;

-- ===========================================================================
-- 5b. my_security_events — caller's own recent security activity
-- ===========================================================================
-- Any active staff member; only rows where the caller is the actor or the
-- target. Newest first; p_limit clamped to 1..100 (NULL → 10).
create or replace function public.my_security_events(p_limit int default 10)
returns setof public.admin_audit_log
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid   uuid := auth.uid();
  v_limit int  := least(greatest(coalesce(p_limit, 10), 1), 100);
begin
  if v_uid is null or not coalesce(public.is_staff(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select l.*
    from public.admin_audit_log l
   where l.actor_id = v_uid
      or l.target_id = v_uid
   order by l.created_at desc, l.id desc
   limit v_limit;
end;
$$;

comment on function public.my_security_events(int) is
  'U3: the caller''s own admin_audit_log rows (actor or target), newest first. Active staff only; p_limit clamped 1..100.';

revoke all on function public.my_security_events(int) from public, anon;
grant execute on function public.my_security_events(int) to authenticated, service_role;

-- ===========================================================================
-- 6. DB-level MFA enforcement — mfa_satisfied() + staff/admin helpers
-- ===========================================================================
-- The app enforces MFA in lib/auth.ts (requireStaff R1/R2), but a signed-in
-- aal1 session could call PostgREST directly. mfa_satisfied() is TRUE when:
--   * there is no auth.uid() (anon / service_role / SQL console — unchanged), or
--   * the JWT is aal2, or
--   * the user has NO verified TOTP factor (nothing to step up to; mandatory
--     enrollment for owner/super_admin stays an app rule — R2).
-- So: a user WITH a verified factor whose session is still aal1 fails it.
-- SECURITY DEFINER (reads auth.mfa_factors); executable by every client role
-- because it is also referenced directly in an RLS policy (§7).
create or replace function public.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select auth.uid() is null
      or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
           select 1
             from auth.mfa_factors f
            where f.user_id = auth.uid()
              and f.status::text = 'verified'
              and f.factor_type::text = 'totp');
$$;

comment on function public.mfa_satisfied() is
  'U3: true when no auth.uid(), the JWT is aal2, or the user has no verified TOTP factor. ANDed into is_staff/is_admin/is_admin_manager (closes the PostgREST aal1 bypass).';

revoke all on function public.mfa_satisfied() from public;
grant execute on function public.mfa_satisfied() to anon, authenticated, service_role;

-- Helpers: bodies verbatim from 20261009100100 (is_staff), 20260701153625
-- (is_admin), 20260701164252 (is_admin_manager) + `and public.mfa_satisfied()`.
-- service_role: unchanged (bypasses RLS; auth.uid() is null → false as before).
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('editor','admin','super_admin','owner')
      and disabled = false
  ) and public.mfa_satisfied();
$$;

grant execute on function public.is_staff() to anon, authenticated, service_role;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('admin','super_admin','owner')
      and disabled = false
  ) and public.mfa_satisfied();
$function$;

create or replace function public.is_admin_manager()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('super_admin','owner')
      and disabled = false
  ) and public.mfa_satisfied();
$$;

-- ===========================================================================
-- 7. admin_audit_log direct SELECT → OWNER-ONLY
-- ===========================================================================
-- Was is_admin_manager() (U1), which let a super_admin read owner/super_admin
-- rows directly through PostgREST, bypassing list_security_events' scoping.
-- Super admins now read exclusively via list_security_events / my_security_events
-- (SECURITY DEFINER, unchanged).
drop policy if exists admin_audit_log_manager_select on public.admin_audit_log;
drop policy if exists admin_audit_log_owner_select on public.admin_audit_log;
create policy admin_audit_log_owner_select on public.admin_audit_log
  for select using (
    exists (select 1 from public.profiles
             where id = auth.uid()
               and role = 'owner'
               and disabled = false)
    and public.mfa_satisfied()
  );

-- ===========================================================================
-- 8. auth.mfa_factors audit trigger — mfa_enabled / mfa_disabled
-- ===========================================================================
-- The DB is the source of truth for factor changes (GoTrue writes them, from
-- the browser enrollment, the admin API or a cascade). Events:
--   UPDATE status non-verified → verified  → 'mfa_enabled'
--   DELETE of a verified factor            → 'mfa_disabled'
--   INSERT / unverified DELETE / other UPDATEs → nothing (enrollment churn).
-- Actor AND target = the factor's user (GoTrue's connection carries no
-- auth.uid(); a manager removal is additionally recorded app-side as
-- security_setting_changed by that manager). Snapshots come from profiles;
-- users without a profiles row are recorded with null snapshots.
-- details = {source:'auth_factors', factor_type}.
-- 'mfa_reconfigured' stays app-side (the trigger cannot infer a re-setup).
-- SAFETY CONTRACT (profiles_admin_audit pattern): never raises — any error is
-- a WARNING and the audit row is skipped; the factor write always proceeds.
create or replace function public.mfa_factors_admin_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_action  text;
  v_user    uuid;
  v_type    text;
  v_name    text;
  v_label   text;
  v_role    text;
  v_email   text;
  v_known   boolean;
begin
  begin
    if tg_op = 'UPDATE' then
      if new.status::text = 'verified'
         and old.status::text is distinct from 'verified' then
        v_action := 'mfa_enabled';
        v_user   := new.user_id;
        v_type   := new.factor_type::text;
      end if;
    elsif tg_op = 'DELETE' then
      if old.status::text = 'verified' then
        v_action := 'mfa_disabled';
        v_user   := old.user_id;
        v_type   := old.factor_type::text;
      end if;
    end if;

    if v_action is null or v_user is null then
      return null;
    end if;

    select p.full_name, coalesce(nullif(btrim(p.full_name), ''), p.email), p.role, p.email
      into v_name, v_label, v_role, v_email
      from public.profiles p where p.id = v_user;
    v_known := found;  -- actor_id has an FK to profiles: only set when the row exists

    insert into public.admin_audit_log
      (action, actor_id, actor_name, actor_role, actor_kind,
       target_id, target_name, target_email, before_value, after_value, details)
    values
      (v_action,
       case when v_known then v_user end,
       v_label, v_role, 'user',
       v_user, v_name, v_email, null, null,
       jsonb_strip_nulls(jsonb_build_object(
         'source', 'auth_factors', 'factor_type', v_type)));

    return null;
  exception when others then
    raise warning 'mfa_factors_admin_audit skipped (user %): %', v_user, sqlerrm;
    return null;
  end;
end;
$$;

comment on function public.mfa_factors_admin_audit() is
  'U3: AFTER trigger on auth.mfa_factors → admin_audit_log mfa_enabled (verified) / mfa_disabled (verified factor deleted). Never raises.';

-- Trigger-only function: no direct RPC execution.
revoke execute on function public.mfa_factors_admin_audit() from public, anon, authenticated;

drop trigger if exists mfa_factors_admin_audit on auth.mfa_factors;
create trigger mfa_factors_admin_audit
  after insert or update or delete on auth.mfa_factors
  for each row execute function public.mfa_factors_admin_audit();

-- ===========================================================================
-- 9. guard_profile_changes v4 — v3 verbatim + rule (e) DB-level re-auth
-- ===========================================================================
-- Body copied verbatim from 20261009100100 §5 (v3: owner wall, last-owner
-- protections, service bypass, (b2), (c), (d)). The ONLY addition is rule (e),
-- after (c)/(d) so unauthorized actors keep their specific errors:
--   (e) an authenticated (non-service) actor changing role or disabled on
--       ANOTHER user's row must have re-authenticated THIS session within 15
--       minutes: a public.session_reauth row matching the JWT session_id AND
--       auth.uid() with verified_at > now() - 15 min (same marker / window as
--       the app's requireRecentAuth). Otherwise 'sensitive action requires
--       recent re-authentication'. Self-changes are already refused by (c)/(d);
--       the owner wall precedes; service_role returns before this rule.
create or replace function public.guard_profile_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_service  boolean := coalesce(auth.role() = 'service_role', false)
                          or coalesce((auth.jwt() ->> 'role') = 'service_role', false);
  actor_id       uuid := auth.uid();
  actor_role     text;
  actor_disabled boolean;
begin
  -- (0a) OWNER WALL — the owner role can never be granted, by anyone.
  if tg_op = 'INSERT' then
    if new.role = 'owner' then
      raise exception 'owner role cannot be granted';
    end if;
    return new;
  end if;

  if new.role = 'owner' and old.role is distinct from 'owner' then
    raise exception 'owner role cannot be granted';
  end if;

  -- (0b) OWNER WALL — the owner row is untouchable by anyone but the owner.
  if old.role = 'owner' then
    if new.role is distinct from old.role then
      raise exception 'the owner role cannot be changed';
    end if;
    if new.disabled = true and old.disabled = false then
      raise exception 'the owner account cannot be suspended';
    end if;
    if actor_id is distinct from old.id
       and not (old.created_by is not null and new.created_by is null
                and (to_jsonb(new) - 'created_by' - 'updated_at')
                    = (to_jsonb(old) - 'created_by' - 'updated_at')
                and pg_trigger_depth() > 1) then
      raise exception 'the owner account is protected: only the owner may modify it';
    end if;
  end if;

  -- (a)/(b) never demote or disable the last active owner — applies to ALL
  -- callers, service role included.
  if old.role = 'owner' and new.role is distinct from 'owner'
     and (select count(*) from public.profiles
          where role = 'owner' and disabled = false and id <> old.id) = 0 then
    raise exception 'cannot demote the last owner';
  end if;
  if old.role = 'owner' and new.disabled = true and old.disabled = false
     and (select count(*) from public.profiles
          where role = 'owner' and disabled = false and id <> old.id) = 0 then
    raise exception 'cannot disable the last owner';
  end if;

  if is_service then
    return new;
  end if;

  select p.role, p.disabled into actor_role, actor_disabled
  from public.profiles p where p.id = actor_id;

  -- (b2) a super_admin may only modify user/admin/editor rows (any field):
  -- peer super_admins and above are off-limits. Own-row self-edits fall
  -- through to the per-field rules below (role/status self-changes are refused).
  if actor_role = 'super_admin' and not coalesce(actor_disabled, true)
     and actor_id is distinct from old.id
     and old.role not in ('user', 'admin', 'editor') then
    raise exception 'super admins cannot modify peer or higher accounts';
  end if;

  -- (c) role changes
  if new.role is distinct from old.role then
    if actor_id is not distinct from new.id then
      raise exception 'cannot change your own role';
    end if;
    if actor_role is null or coalesce(actor_disabled, true)
       or actor_role not in ('super_admin', 'owner') then
      raise exception 'not authorized to change roles';
    end if;
    if (old.role = 'owner' or new.role = 'owner') and actor_role <> 'owner' then
      raise exception 'only an owner may grant or change the owner role';
    end if;
    if actor_role = 'super_admin'
       and (old.role not in ('user', 'admin', 'editor')
            or new.role not in ('user', 'admin', 'editor')) then
      raise exception 'super_admin may only manage user/admin/editor roles';
    end if;
  end if;

  -- (d) disabled changes
  if new.disabled is distinct from old.disabled then
    if actor_id is not distinct from new.id then
      raise exception 'cannot change your own account status';
    end if;
    if actor_role is null or coalesce(actor_disabled, true)
       or actor_role not in ('super_admin', 'owner') then
      raise exception 'not authorized to change account status';
    end if;
    if old.role = 'owner' and actor_role <> 'owner' then
      raise exception 'only an owner may change an owner account';
    end if;
    if actor_role = 'super_admin' and old.role not in ('user', 'admin', 'editor') then
      raise exception 'super_admin may only manage user/admin/editor accounts';
    end if;
  end if;

  -- (e) U3: role/disabled change on ANOTHER user's row needs a recent re-auth
  -- of THIS session (session_reauth marker, 15-minute window).
  if actor_id is distinct from old.id
     and (new.role is distinct from old.role
          or new.disabled is distinct from old.disabled) then
    declare
      v_session uuid;
    begin
      begin
        v_session := nullif(btrim(auth.jwt() ->> 'session_id'), '')::uuid;
      exception when others then
        v_session := null;  -- missing / malformed claim → treated as no re-auth
      end;
      if v_session is null
         or actor_id is null
         or not exists (
              select 1 from public.session_reauth r
               where r.session_id  = v_session
                 and r.user_id     = actor_id
                 and r.verified_at > now() - interval '15 minutes') then
        raise exception 'sensitive action requires recent re-authentication';
      end if;
    end;
  end if;

  return new;
end;
$$;

-- Trigger-only function: must not be RPC-callable. (Trigger binding from
-- 20261009100100 — BEFORE INSERT OR UPDATE — is unchanged; not re-created.)
revoke execute on function public.guard_profile_changes() from public, anon, authenticated;

-- ===========================================================================
-- ROLLBACK (manual, in this order):
-- 0a. guard_profile_changes: re-run 20261009100100 §5 function body only
--     (restores v3; required BEFORE dropping session_reauth in step 4).
-- 0b. drop trigger if exists mfa_factors_admin_audit on auth.mfa_factors;
--     drop function if exists public.mfa_factors_admin_audit();
-- 0c. drop policy if exists admin_audit_log_owner_select on public.admin_audit_log;
--     create policy admin_audit_log_manager_select on public.admin_audit_log
--       for select using (public.is_admin_manager());
-- 0d. Re-create is_staff (20261009100100 §2), is_admin (20260701153625),
--     is_admin_manager (20260701164252) from their original bodies, THEN
--     drop function if exists public.mfa_satisfied();
-- 1. drop function if exists public.my_security_events(int);
--    drop function if exists public.list_security_events(date, date, uuid, text, uuid, timestamptz, bigint, int);
--    drop function if exists public.record_reauth(uuid, uuid);
-- 2. log_admin_event: re-run section 5e of 20261010100100_invitations_and_account.sql
--    (restores the U2 allowlist).
-- 3. CHECK narrowing ONLY while no admin_audit_log row uses a U3 action
--    (append-only: such rows cannot be removed) — otherwise leave it widened:
--    re-run section 4 of 20261010100100_invitations_and_account.sql.
-- 4. drop table if exists public.session_reauth;   -- only forces re-auth again
-- 5. alter table public.profiles drop column if exists password_changed_at;   -- discards data
-- ===========================================================================
