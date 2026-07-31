alter table public.categories enable row level security;
alter table public.content enable row level security;
alter table public.content_sources enable row level security;
alter table public.comments enable row level security;

-- ===== Categories: public read, admin write =====
create policy "categories_public_read" on public.categories
  for select using (true);
create policy "categories_admin_write" on public.categories
  for all using (public.is_admin()) with check (public.is_admin());

-- ===== Content: public reads published (non-deleted); admin full =====
create policy "content_public_read" on public.content
  for select using (status = 'published' and deleted_at is null);
create policy "content_admin_read" on public.content
  for select using (public.is_admin());
create policy "content_admin_write" on public.content
  for all using (public.is_admin()) with check (public.is_admin());

-- ===== Sources: public read when parent is published; admin full =====
create policy "sources_public_read" on public.content_sources
  for select using (
    exists (
      select 1 from public.content c
      where c.id = content_id and c.status = 'published' and c.deleted_at is null
    )
  );
create policy "sources_admin_read" on public.content_sources
  for select using (public.is_admin());
create policy "sources_admin_write" on public.content_sources
  for all using (public.is_admin()) with check (public.is_admin());

-- ===== Comments: public reads approved; anyone may post (forced pending); admin moderates =====
create policy "comments_public_read_approved" on public.comments
  for select using (status = 'approved');
create policy "comments_admin_read" on public.comments
  for select using (public.is_admin());
create policy "comments_public_insert" on public.comments
  for insert with check (
    exists (
      select 1 from public.content c
      where c.id = content_id and c.status = 'published' and c.deleted_at is null
    )
  );
create policy "comments_admin_update" on public.comments
  for update using (public.is_admin()) with check (public.is_admin());
create policy "comments_admin_delete" on public.comments
  for delete using (public.is_admin());