alter table public.profiles disable trigger guard_profile_changes_trg;

update public.profiles set role = 'owner'
where id = (
  select id from public.profiles where role = 'admin' order by created_at limit 1
);

alter table public.profiles enable trigger guard_profile_changes_trg;