-- Prevent non-admins from changing their own role or disabled flag.
create or replace function public.guard_profile_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if new.role is distinct from old.role then
      new.role := old.role;
    end if;
    if new.disabled is distinct from old.disabled then
      new.disabled := old.disabled;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_changes_trg on public.profiles;
create trigger guard_profile_changes_trg
  before update on public.profiles
  for each row execute function public.guard_profile_changes();