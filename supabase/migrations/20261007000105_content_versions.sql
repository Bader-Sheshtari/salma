-- CMS lifecycle Phase 1 (5/6) — content version history.
--
-- Each row is a snapshot of an article's editable content AS IT WAS before a
-- content edit replaced it: version_no = the version being superseded,
-- edited_by/edited_at = the edit that superseded it. The live row in
-- public.content always holds the current version (content.version).
--
--   * Written ONLY by the content lifecycle AFTER UPDATE trigger
--     (SECURITY DEFINER, migration 106) — no client writes.
--   * Admin read-only (is_admin()).
--   * Full history is kept: NO pruning, NO cap. Retention can be made
--     configurable later (e.g. an app_config key where NULL = unlimited) —
--     intentionally no pruning code exists.
--   * ON DELETE CASCADE from content: versions only make sense for an existing
--     article. Articles are soft-deleted (deleted_at) and there is no purge, so
--     in practice versions are never removed. The audit log (no FK) survives
--     regardless.

create table if not exists public.content_versions (
  content_id        uuid not null references public.content(id) on delete cascade,
  version_no        integer not null,
  title             text not null,
  slug              text not null,
  excerpt           text,
  body              text,
  ai_summary        text,
  category_slug     text,
  type              text not null,
  cover_image_url   text,
  cover_credit_name text,
  cover_credit_url  text,
  source_name       text,
  source_url        text,
  video_url         text,
  edited_by         uuid references public.profiles(id) on delete set null,
  edited_at         timestamptz not null,
  created_at        timestamptz not null default now(),
  primary key (content_id, version_no)
);

alter table public.content_versions enable row level security;
drop policy if exists content_versions_admin_select on public.content_versions;
create policy content_versions_admin_select on public.content_versions
  for select using (public.is_admin());
-- Deliberately NO insert/update/delete policies.

revoke all on table public.content_versions from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.content_versions from authenticated, service_role;

-- ROLLBACK:
-- drop table if exists public.content_versions;
