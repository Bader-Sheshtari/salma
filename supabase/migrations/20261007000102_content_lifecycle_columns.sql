-- CMS lifecycle Phase 1 (2/6) — lifecycle metadata columns on content.
--
-- All new columns are nullable (or carry a constant default), so on Postgres
-- 11+ this is a metadata-only change: no table rewrite, no row UPDATE, no
-- trigger fires, updated_at is untouched. Values are backfilled by
-- 20261007000103_content_lifecycle_backfill.sql and maintained afterwards by
-- the triggers in 20261007000106_content_lifecycle_triggers.sql.
--
--   created_by          who created the row (NULL = pipeline/system)
--   last_edited_by/at   last CONTENT edit (title/body/... — not status flips);
--                       drives the public «آخر تحديث» line
--   reviewed_by/at      editorial review (distinct from publishing)
--   published_by        who performed the latest publish
--   first_published_at  ORIGINAL publication date — never overwritten once set
--   last_published_at   most recent (re)publish
--   unpublished_by/at   who/when took it off the public site
--   deleted_by          who soft-deleted it (deleted_at already exists)
--   version             current content version number (history rows live in
--                       content_versions)

alter table public.content
  add column if not exists created_by         uuid references public.profiles(id) on delete set null,
  add column if not exists last_edited_by     uuid references public.profiles(id) on delete set null,
  add column if not exists last_edited_at     timestamptz,
  add column if not exists reviewed_by        uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at        timestamptz,
  add column if not exists published_by       uuid references public.profiles(id) on delete set null,
  add column if not exists first_published_at timestamptz,
  add column if not exists last_published_at  timestamptz,
  add column if not exists unpublished_by     uuid references public.profiles(id) on delete set null,
  add column if not exists unpublished_at     timestamptz,
  add column if not exists deleted_by         uuid references public.profiles(id) on delete set null,
  add column if not exists version            integer not null default 1;

-- ROLLBACK:
-- alter table public.content
--   drop column if exists created_by, drop column if exists last_edited_by,
--   drop column if exists last_edited_at, drop column if exists reviewed_by,
--   drop column if exists reviewed_at, drop column if exists published_by,
--   drop column if exists first_published_at, drop column if exists last_published_at,
--   drop column if exists unpublished_by, drop column if exists unpublished_at,
--   drop column if exists deleted_by, drop column if exists version;
