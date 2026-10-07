-- CMS lifecycle Phase 1 (1/6) — add the 'unpublished' content status.
--
-- Unpublish ≠ delete ≠ draft: an article taken off the public site keeps its
-- own explicit status so it can be republished later with its ORIGINAL
-- publication date (see 20261007000106_content_lifecycle_triggers.sql).
--
-- Public visibility is unchanged and automatically correct: the public RLS
-- policy is `status = 'published' and deleted_at is null`, so any
-- non-'published' status (including 'unpublished') is hidden.
--
-- Pure constraint widening: every existing value stays valid, no row is
-- touched. Drop + re-add happen in one statement block (atomic).

do $$ begin
  alter table public.content drop constraint if exists content_status_check;
  alter table public.content
    add constraint content_status_check
    check (status in ('draft','pending','published','rejected','unpublished'));
end $$;

-- ROLLBACK (only valid while no row has status 'unpublished'):
-- do $$ begin
--   alter table public.content drop constraint if exists content_status_check;
--   alter table public.content add constraint content_status_check
--     check (status in ('draft','pending','published','rejected'));
-- end $$;
