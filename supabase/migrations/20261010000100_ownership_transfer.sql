-- ONE-TIME controlled ownership transfer (owner-approved 2026-10-10).
--
-- WHY: the production Owner (`admin@salma.news`) is a legacy bootstrap artifact
-- from initial setup (2026-06-29): an unreachable mailbox on an unowned domain,
-- zero operational history, promoted to Owner on 2026-07-01 purely as "the
-- oldest admin" (20260701153725_promote_owner.sql selected by created_at, not
-- by identity). The real operator is `bader@dawi.com` (admin).
--
-- WHAT (atomic, single transaction; everything rolls back on any failed check):
--   bader@dawi.com      admin -> owner   (active, same user id, history intact)
--   admin@salma.news    owner -> user    (least-privileged existing role:
--                                         'user' is not staff, so it cannot even
--                                         sign in to the dashboard) + suspended.
--                                         The account is PRESERVED (never
--                                         deleted) for historical attribution.
--   + auth-level: bootstrap account banned (blocks login + token refresh) and
--     its refresh tokens revoked. Password untouched. Auth user untouched.
--
-- GUARD INTERACTION (U1 owner wall, 20261009100100): the wall intentionally has
-- NO application path into/out of Owner — this migration IS the separate
-- high-security workflow the design reserved. The guard trigger is disabled for
-- the swap in the NARROWEST possible scope:
--   * inside this one transaction only;
--   * ALTER TABLE ... DISABLE TRIGGER takes an ACCESS EXCLUSIVE lock on
--     profiles, so no concurrent session can write an unguarded row;
--   * re-enabled before commit; a failure anywhere rolls back the disable too.
-- The guard function itself is NOT modified — all U1 protections continue
-- unchanged and immediately protect the NEW owner.
--
-- AUDIT: the profiles audit trigger stays ENABLED during the swap, so the
-- granular role_changed / user_suspended events are recorded with the system
-- actor (no fabricated human). Additionally one explicit 'ownership_transfer'
-- summary event is written (new action value — a pure CHECK widening; the
-- append-only immutability of admin_audit_log is untouched).

-- 1. Allow the migration-level summary event type.
do $$ begin
  alter table public.admin_audit_log drop constraint if exists admin_audit_log_action_check;
  alter table public.admin_audit_log
    add constraint admin_audit_log_action_check
    check (action in (
      'user_created','role_changed','user_suspended','user_reactivated',
      'profile_updated','email_changed','denied_attempt','ownership_transfer'));
end $$;

-- 2. The transfer itself.
do $$
declare
  v_old_owner uuid;
  v_new_owner uuid;
  v_n int;
begin
  -- ---- PRE-APPLY CHECKS (abort = full rollback if production differs) ----
  select id into v_old_owner from public.profiles
   where role = 'owner' and email = 'admin@salma.news';
  if v_old_owner is null then
    raise exception 'ownership transfer aborted: current owner is not admin@salma.news';
  end if;
  select count(*) into v_n from public.profiles where role = 'owner';
  if v_n <> 1 then
    raise exception 'ownership transfer aborted: expected exactly 1 owner, found %', v_n;
  end if;
  select id into v_new_owner from public.profiles
   where email = 'bader@dawi.com' and role = 'admin' and disabled = false;
  if v_new_owner is null then
    raise exception 'ownership transfer aborted: bader@dawi.com is not an active admin';
  end if;
  select count(*) into v_n
    from auth.users u join public.profiles p on p.id = u.id and p.email = u.email
   where u.id in (v_old_owner, v_new_owner);
  if v_n <> 2 then
    raise exception 'ownership transfer aborted: auth/profile mismatch';
  end if;

  -- ---- Narrow, transaction-scoped guard bypass (see header) ----
  alter table public.profiles disable trigger guard_profile_changes_trg;

  -- Promote first (never zero owners, even transiently), then retire the
  -- bootstrap account to the least-privileged existing role and suspend it.
  update public.profiles set role = 'owner' where id = v_new_owner;
  update public.profiles set role = 'user', disabled = true where id = v_old_owner;

  alter table public.profiles enable trigger guard_profile_changes_trg;

  -- ---- POST-SWAP VALIDATION (abort = full rollback, guard restored) ----
  select count(*) into v_n from public.profiles where role = 'owner';
  if v_n <> 1 then
    raise exception 'ownership transfer aborted: owner count after swap = %', v_n;
  end if;
  if not exists (select 1 from public.profiles
                  where id = v_new_owner and role = 'owner' and disabled = false) then
    raise exception 'ownership transfer aborted: new owner state invalid';
  end if;
  if not exists (select 1 from public.profiles
                  where id = v_old_owner and role = 'user' and disabled = true) then
    raise exception 'ownership transfer aborted: bootstrap account state invalid';
  end if;

  -- ---- Migration-level summary audit event (system actor, append-only) ----
  insert into public.admin_audit_log
    (action, actor_id, actor_name, actor_role, actor_kind,
     target_id, target_name, target_email, before_value, after_value, details)
  values
    ('ownership_transfer', null, 'migration 20261010000100', null, 'system',
     v_new_owner, 'bader', 'bader@dawi.com', 'admin', 'owner',
     jsonb_build_object(
       'reason', 'controlled ownership correction of legacy/bootstrap account',
       'previous_owner_id', v_old_owner,
       'previous_owner_email', 'admin@salma.news',
       'previous_owner_final_role', 'user',
       'previous_owner_final_status', 'suspended',
       'approved_by', 'owner instruction 2026-10-10'));

  -- ---- Auth-level lockout of the bootstrap account (preserved, not deleted) ----
  update auth.users
     set banned_until = now() + interval '100 years'
   where id = v_old_owner;
  update auth.refresh_tokens
     set revoked = true
   where user_id = v_old_owner::text and revoked = false;

  raise notice 'ownership transfer OK: % is sole owner; bootstrap % retired+suspended',
    v_new_owner, v_old_owner;
end $$;

-- ROLLBACK (manual, only if ever needed — requires the same supervised pattern):
-- a second migration disabling guard_profile_changes_trg in-transaction, swapping
-- the roles back, re-enabling, and logging another ownership_transfer event.
