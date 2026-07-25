-- ============================================================
-- A2: replace the permissive jsonb transfer-create RPC with a
-- minimal, self-validating one. Named params make the removed
-- fields (transfer_date/summary/body/slug/manual published_at)
-- physically unrepresentable as inputs. status is validated to
-- draft|published; published_at is set in-function. A1 private
-- source permissions + atomicity are preserved (security invoker).
-- ============================================================

drop function if exists public.create_transfer_with_private(jsonb, text);

create or replace function public.create_transfer_with_private(
  p_doctor_name      text,
  p_specialty        text default null,
  p_doctor_photo_url text default null,
  p_from_hospital    text default null,
  p_to_hospital      text default null,
  p_status           text default 'draft',
  p_internal_source  text default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id     uuid;
  v_name   text := nullif(btrim(coalesce(p_doctor_name,'')),'');
  v_status text := lower(btrim(coalesce(p_status,'')));
  v_note   text := nullif(btrim(coalesce(p_internal_source,'')),'');
begin
  if v_name is null or length(v_name) < 3 then
    raise exception 'invalid doctor_name';
  end if;
  if v_status not in ('draft','published') then
    raise exception 'invalid status: %', coalesce(p_status,'<null>');
  end if;

  insert into public.doctor_transfers (
    doctor_name, specialty, doctor_photo_url, from_hospital, to_hospital,
    status, published_at
  ) values (
    v_name,
    nullif(btrim(coalesce(p_specialty,'')),''),
    nullif(btrim(coalesce(p_doctor_photo_url,'')),''),
    nullif(btrim(coalesce(p_from_hospital,'')),''),
    nullif(btrim(coalesce(p_to_hospital,'')),''),
    v_status,
    case when v_status = 'published' then now() else null end
  )
  returning id into v_id;

  if v_note is not null then
    insert into public.doctor_transfer_private (transfer_id, internal_source_note)
    values (v_id, v_note);
  end if;

  return v_id;
end;
$$;

revoke all on function public.create_transfer_with_private(text,text,text,text,text,text,text) from public, anon;
grant execute on function public.create_transfer_with_private(text,text,text,text,text,text,text) to authenticated;
