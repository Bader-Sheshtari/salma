-- ============================================================
-- A1: manager-only confidential source for doctor transfers
-- ============================================================

-- ---- 1. Private table -------------------------------------------------
create table if not exists public.doctor_transfer_private (
  transfer_id uuid primary key
    references public.doctor_transfers(id) on delete cascade,
  internal_source_note text,
  updated_at timestamptz not null default now()
);

alter table public.doctor_transfer_private enable row level security;

-- ---- 2. Explicit privilege reset, then grant --------------------------
revoke all on public.doctor_transfer_private from public, anon, authenticated;
grant select, insert, update, delete on public.doctor_transfer_private to authenticated;

-- ---- 3. Manager-only RLS ---------------------------------------------
drop policy if exists dtp_manager_read  on public.doctor_transfer_private;
drop policy if exists dtp_manager_write on public.doctor_transfer_private;
create policy dtp_manager_read  on public.doctor_transfer_private
  for select using (public.is_admin_manager());
create policy dtp_manager_write on public.doctor_transfer_private
  for all using (public.is_admin_manager()) with check (public.is_admin_manager());

drop trigger if exists set_dtp_updated_at on public.doctor_transfer_private;
create trigger set_dtp_updated_at before update on public.doctor_transfer_private
  for each row execute function public.set_updated_at();

-- ---- 4. Verified migrate + scrub (atomic; RAISE => full rollback) ------
do $$
declare
  expected int;
  migrated int;
begin
  select count(*) into expected
  from public.doctor_transfers
  where nullif(btrim(coalesce(source_name,'')),'') is not null
     or nullif(btrim(coalesce(source_url ,'')),'') is not null;

  insert into public.doctor_transfer_private (transfer_id, internal_source_note)
  select id,
         btrim(concat_ws(' — ',
           nullif(btrim(coalesce(source_name,'')),''),
           nullif(btrim(coalesce(source_url ,'')),'')))
  from public.doctor_transfers
  where nullif(btrim(coalesce(source_name,'')),'') is not null
     or nullif(btrim(coalesce(source_url ,'')),'') is not null
  on conflict (transfer_id) do update
    set internal_source_note = excluded.internal_source_note;

  select count(*) into migrated
  from public.doctor_transfer_private p
  where exists (
    select 1 from public.doctor_transfers t
    where t.id = p.transfer_id
      and ( nullif(btrim(coalesce(t.source_name,'')),'') is not null
         or nullif(btrim(coalesce(t.source_url ,'')),'') is not null )
  );

  if migrated <> expected then
    raise exception
      'A1 source migration mismatch: expected %, migrated % — rolling back',
      expected, migrated;
  end if;

  update public.doctor_transfers
     set source_name = null, source_url = null
   where source_name is not null or source_url is not null;
end $$;

-- ---- 5. Atomic new-transfer RPC --------------------------------------
create or replace function public.create_transfer_with_private(
  p_payload jsonb,
  p_internal_source text default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_note text := nullif(btrim(coalesce(p_internal_source,'')),'');
begin
  insert into public.doctor_transfers (
    doctor_name, specialty, doctor_photo_url, from_hospital, to_hospital,
    transfer_date, summary, body, status, published_at, slug
  ) values (
    nullif(btrim(coalesce(p_payload->>'doctor_name','')),''),
    nullif(p_payload->>'specialty',''),
    nullif(p_payload->>'doctor_photo_url',''),
    nullif(p_payload->>'from_hospital',''),
    nullif(p_payload->>'to_hospital',''),
    nullif(p_payload->>'transfer_date','')::date,
    nullif(p_payload->>'summary',''),
    nullif(p_payload->>'body',''),
    coalesce(nullif(p_payload->>'status',''),'published'),
    nullif(p_payload->>'published_at','')::timestamptz,
    nullif(p_payload->>'slug','')
  )
  returning id into v_id;

  if v_note is not null then
    insert into public.doctor_transfer_private (transfer_id, internal_source_note)
    values (v_id, v_note);
  end if;

  return v_id;
end;
$$;

revoke all on function public.create_transfer_with_private(jsonb, text) from public, anon;
grant execute on function public.create_transfer_with_private(jsonb, text) to authenticated;

-- ---- 6. Legacy-column force-null protection --------------------------
create or replace function public.force_transfer_source_null()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.source_name := null;
  new.source_url  := null;
  return new;
end;
$$;

drop trigger if exists trg_force_transfer_source_null on public.doctor_transfers;
create trigger trg_force_transfer_source_null
  before insert or update on public.doctor_transfers
  for each row execute function public.force_transfer_source_null();
