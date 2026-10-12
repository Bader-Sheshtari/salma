-- ============================================================================
-- NEWSLETTER EDITORIAL CALIBRATION V1.1 (brief 2026-10-12).
--
-- Minimal schema support for the calibration — NOT a redesign (§15):
--  1. A 'opportunities' pool section («فرص تحريرية»): interesting-but-
--     incomplete items (needs source verification, promising-but-weak) live
--     there as editor-only suggestions and NEVER render in the reader-facing
--     issue (§4, §10). Everything else about newsletter_items is unchanged.
--  2. Primary-source snapshot columns (§5): when the escalation step finds a
--     stronger primary/official source behind a secondary media item, the
--     primary is recorded and drives verification + authority; the original
--     secondary URL stays as context in external_url.
-- ============================================================================

alter table public.newsletter_items
  drop constraint if exists newsletter_items_section_check;

alter table public.newsletter_items
  add constraint newsletter_items_section_check
  check (section in ('lead','top_missed','economy','gcc','research','qol',
                     'trend','expert','transfers','quick','opportunities'));

alter table public.newsletter_items
  add column if not exists primary_url text,
  add column if not exists primary_source_name text;
