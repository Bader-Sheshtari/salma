-- P0 SECURITY FIX — block public self-signup at the database layer
-- (launch-readiness audit 2026-08-21).
--
-- Production GoTrue reported disable_signup=false: anyone holding the public
-- anon key could POST /auth/v1/signup and create an account, on a platform
-- whose auth model is admin-only (accounts are created exclusively by managers
-- via auth.admin.createUser({ email_confirm: true }) in
-- src/app/admin/actions.ts; there is no signup UI).
--
-- Defense in depth: a BEFORE INSERT trigger on auth.users rejects any new
-- user row that arrives UNCONFIRMED. Self-signup (with mailer_autoconfirm
-- off, as configured) inserts with email_confirmed_at NULL → rejected.
-- The sanctioned admin workflow passes email_confirm:true, so GoTrue sets
-- email_confirmed_at at insert time → allowed. Existing users are untouched
-- (INSERT-only trigger); login, sessions, and password updates are UPDATEs.
--
-- NOTE: the authoritative control — "Disable new user signups" in the
-- Supabase Auth dashboard — must ALSO be switched on (it is a hosted-config
-- toggle, not reachable from SQL). This trigger guarantees the boundary even
-- if that toggle is ever reverted.

create or replace function public.guard_auth_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email_confirmed_at is null
     and new.phone_confirmed_at is null
     and coalesce(new.is_anonymous, false) = false then
    raise exception 'public signup is disabled';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_auth_signup() from public, anon, authenticated;
grant execute on function public.guard_auth_signup() to supabase_auth_admin;

drop trigger if exists salma_block_public_signup on auth.users;
create trigger salma_block_public_signup
  before insert on auth.users
  for each row execute function public.guard_auth_signup();
