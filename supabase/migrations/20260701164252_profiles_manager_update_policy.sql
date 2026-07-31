-- Managers (owner / super_admin) may manage other admins; everyone may edit self.
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
  );
$$;

-- Tighten the profiles UPDATE policy: previously ANY admin (incl. plain 'admin')
-- could update ANY profile via the anon API. Now only managers may update others.
-- Service-role admin actions bypass RLS entirely, so they are unaffected.
drop policy if exists profiles_update_own_or_admin on public.profiles;
create policy profiles_update_own_or_manager on public.profiles
  for update
  using ((auth.uid() = id) or public.is_admin_manager())
  with check ((auth.uid() = id) or public.is_admin_manager());
