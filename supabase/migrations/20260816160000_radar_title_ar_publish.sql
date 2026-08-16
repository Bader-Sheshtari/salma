-- Fast News Radar — Arabic headline + one-click publish authorization/idempotency.
--
-- Two additions to radar_shadow_articles, both isolated from the ranking/priority
-- logic already in place:
--   1. title_ar — a faithful Arabic translation of the ORIGINAL headline (Arabic
--      originals keep their text verbatim). Reading aid only; the original `title`
--      is never modified, and the Writer NEVER grounds on title_ar.
--   2. publish_* — state for the admin "publish to Salma" one-click action: an
--      idempotency latch (publish_status), the soft link to the created Content,
--      and an authorization audit (who authorized, when). No FK to content on
--      purpose, mirroring matched_content_id (Radar stays schema-decoupled).
--
-- Nothing here touches the collector, the ranker, editorial_value, geo/dedupe
-- thresholds, or the two cron schedules. All columns are nullable so existing
-- rows remain valid (unranked/untranslated/unpublished are all valid states).

alter table public.radar_shadow_articles
  add column if not exists title_ar text,                       -- faithful Arabic translation of ORIGINAL headline (or verbatim for Arabic)
  add column if not exists publish_status text,                 -- null | 'processing' | 'published' | 'needs_review'
  add column if not exists published_content_id uuid,           -- soft link to public.content.id created by one-click publish (NO FK on purpose)
  add column if not exists publish_error text,                  -- last publish-attempt failure summary (diagnostic)
  add column if not exists publish_authorized_by uuid,          -- admin profile id that authorized the one-click publish
  add column if not exists publish_authorized_at timestamptz;   -- when authorization was granted

-- publish_status value constraint (NULL = never attempted, always allowed).
do $$ begin
  alter table public.radar_shadow_articles
    add constraint radar_publish_status_chk
    check (publish_status is null or publish_status in ('processing','published','needs_review'));
exception when duplicate_object then null; end $$;

-- Idempotency backstop for the one-click publish compare-and-swap: at most one
-- row per article may sit in a terminal 'published' state pointing at content.
-- The server action latches publish_status to 'processing' via a conditional
-- UPDATE (WHERE publish_status IS NULL OR publish_status='needs_review'); this
-- partial index simply makes the published-state lookups cheap for the UI.
create index if not exists radar_shadow_articles_publish_status_idx
  on public.radar_shadow_articles (publish_status)
  where publish_status is not null;
