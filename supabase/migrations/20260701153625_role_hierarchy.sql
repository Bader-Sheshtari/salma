-- expand role check
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('user','admin','super_admin','owner'));

-- new columns
alter table public.profiles
  add column if not exists created_by    uuid references public.profiles(id) on delete set null,
  add column if not exists last_login_at timestamptz,
  add column if not exists updated_at    timestamptz not null default now();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- promote the oldest admin to owner
update public.profiles set role = 'owner'
where id = (
  select id from public.profiles where role = 'admin' order by created_at limit 1
);

-- broaden is_admin() to include the whole hierarchy
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('admin','super_admin','owner')
      and disabled = false
  );
$function$;

-- rewrite the profile guard: owner protection + hierarchy + self-escalation block
create or replace function public.guard_profile_changes()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  is_service  boolean := coalesce(auth.role() = 'service_role', false)
                          or coalesce((auth.jwt() ->> 'role') = 'service_role', false);
  actor_admin boolean := public.is_admin();
begin
  -- (a)/(b) never demote or disable the last active owner
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

  -- (c) non-privileged authenticated users cannot change their own role/disabled (silent revert)
  if not is_service and not actor_admin then
    if new.role is distinct from old.role then new.role := old.role; end if;
    if new.disabled is distinct from old.disabled then new.disabled := old.disabled; end if;
  end if;

  -- only an owner (or service role) may elevate someone to owner
  if not is_service and new.role = 'owner' and old.role is distinct from 'owner'
     and not exists (select 1 from public.profiles
                     where id = auth.uid() and role = 'owner' and disabled = false) then
    new.role := old.role;
  end if;

  return new;
end;
$function$;

-- protect the last owner from deletion
create or replace function public.guard_profile_delete()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if old.role = 'owner'
     and (select count(*) from public.profiles
          where role = 'owner' and disabled = false and id <> old.id) = 0 then
    raise exception 'cannot delete the last owner';
  end if;
  return old;
end;
$function$;

drop trigger if exists guard_profile_delete_trg on public.profiles;
create trigger guard_profile_delete_trg
  before delete on public.profiles
  for each row execute function public.guard_profile_delete();