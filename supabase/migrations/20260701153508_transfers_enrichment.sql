alter table public.doctor_transfers
  add column if not exists specialty        text,
  add column if not exists doctor_photo_url text,
  add column if not exists summary          text,
  add column if not exists body             text,
  add column if not exists source_name      text,
  add column if not exists source_url       text,
  add column if not exists slug             text,
  add column if not exists published_at     timestamptz;

alter table public.doctor_transfers drop constraint if exists doctor_transfers_status_check;
alter table public.doctor_transfers
  add constraint doctor_transfers_status_check
  check (status in ('draft','pending','published'));

update public.doctor_transfers t
set slug = coalesce(
      nullif(regexp_replace(lower(trim(t.doctor_name)), '[^a-z0-9\u0621-\u064a]+', '-', 'g'), '-'),
      'transfer'
    ) || '-' || substr(t.id::text, 1, 8),
    published_at = case when t.status = 'published' then t.created_at else null end
where t.slug is null;

create unique index if not exists doctor_transfers_slug_unique
  on public.doctor_transfers (slug)
  where slug is not null and deleted_at is null;