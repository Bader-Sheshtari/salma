-- Article-level credit/source on content
alter table public.content
  add column if not exists cover_credit_name text,
  add column if not exists cover_credit_url  text,
  add column if not exists source_name       text,
  add column if not exists source_url         text;

-- Per-article media gallery (images + videos)
create table if not exists public.content_media (
  id           uuid primary key default gen_random_uuid(),
  content_id   uuid not null references public.content(id) on delete cascade,
  type         text not null default 'image' check (type in ('image','video')),
  url          text not null,
  storage_path text,
  caption      text,
  credit_name  text,
  credit_url   text,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists content_media_content_id_idx
  on public.content_media (content_id, sort_order);

alter table public.content_media enable row level security;

create policy media_admin_read on public.content_media
  for select using (is_admin());

create policy media_admin_write on public.content_media
  for all using (is_admin()) with check (is_admin());

create policy media_public_read on public.content_media
  for select using (exists (
    select 1 from public.content c
    where c.id = content_media.content_id
      and c.status = 'published'
      and c.deleted_at is null
  ));
