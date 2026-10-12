-- ============================================================================
-- FIX v2: evaluate the anti-signup guard at COMMIT time.
--
-- 20261012100100 exempted inserts carrying the salma_admin_created
-- app_metadata marker — but a live GoTrue probe showed the INITIAL insert
-- carries NEITHER email_confirm NOR app_metadata: GoTrue creates a bare row
-- first and applies confirmation/metadata in later statements of the SAME
-- transaction. A BEFORE-INSERT check therefore cannot ever see them.
--
-- Fix: the guard becomes a DEFERRED AFTER-INSERT CONSTRAINT trigger that
-- re-reads the row at commit time, when the transaction's final state is
-- visible. Semantics preserved exactly:
--   - a user that COMMITS unconfirmed, non-anonymous and unmarked → the
--     whole transaction fails with "public signup is disabled" (the public
--     signup block, still defense-in-depth behind GoTrue's own
--     disable_signup=true);
--   - admin/invitation accounts (confirmed and/or carrying the server-only
--     salma_admin_created marker) commit normally.
-- ============================================================================

drop trigger if exists salma_block_public_signup on auth.users;

create or replace function public.guard_auth_signup()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  u record;
begin
  -- Deferred to commit: re-read the row so the SAME-transaction updates
  -- GoTrue applies after its bare insert (email_confirm, app_metadata) are
  -- visible to the check.
  select email_confirmed_at, phone_confirmed_at, is_anonymous, raw_app_meta_data
    into u
    from auth.users
   where id = new.id;
  if not found then
    return null; -- created and deleted within one transaction
  end if;
  if coalesce(u.raw_app_meta_data ->> 'salma_admin_created', '') = 'true' then
    return null; -- server-only admin/invitation marker (service API only)
  end if;
  if u.email_confirmed_at is null
     and u.phone_confirmed_at is null
     and coalesce(u.is_anonymous, false) = false then
    raise exception 'public signup is disabled';
  end if;
  return null;
end;
$$;

create constraint trigger salma_block_public_signup
  after insert on auth.users
  deferrable initially deferred
  for each row
  execute function public.guard_auth_signup();
