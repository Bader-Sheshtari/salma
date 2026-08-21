-- P0 SECURITY FIX — role-escalation guard (launch-readiness audit 2026-08-21).
--
-- Root cause: the previous guard_profile_changes() skipped its role-revert
-- branch for ANY caller where is_admin() was true — which includes plain
-- 'admin'. Only promotion to 'owner' was explicitly blocked, so a signed-in
-- plain admin could PATCH /rest/v1/profiles on their own row (allowed by the
-- profiles_update_own_or_manager RLS policy) and self-promote to
-- 'super_admin', gaining manager powers.
--
-- New policy (DB-authoritative — UI hiding is not relied on):
--   * last-owner protections unchanged: the last active owner can never be
--     demoted or disabled, by ANY caller including service_role.
--   * service_role: otherwise unrestricted (the sanctioned admin workflow in
--     src/app/admin/actions.ts uses the service-role client AFTER its own
--     requireAdmin() + canManage() checks).
--   * NOBODY may change their own role or their own disabled flag — no
--     self-promotion at any tier (user, admin, super_admin alike).
--   * only an ACTIVE super_admin or owner may change anyone's role/disabled.
--   * any transition involving 'owner' (from or to) requires an owner actor.
--   * a super_admin actor mirrors the app's canManage()/setAdminRole rules:
--     may act only on 'user'/'admin' targets and may assign only
--     'user'/'admin' (granting super_admin is owner-only).
-- Violations now RAISE (visible, testable) instead of silently reverting.

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
       and (old.role not in ('user', 'admin') or new.role not in ('user', 'admin')) then
      raise exception 'super_admin may only manage user/admin roles';
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
    if actor_role = 'super_admin' and old.role not in ('user', 'admin') then
      raise exception 'super_admin may only manage user/admin accounts';
    end if;
  end if;

  return new;
end;
$$;

-- Keep the existing hardening: the trigger function must not be RPC-callable.
revoke execute on function public.guard_profile_changes() from public, anon, authenticated;
