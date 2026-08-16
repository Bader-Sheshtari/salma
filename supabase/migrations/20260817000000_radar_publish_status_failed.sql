-- Fast News Radar — allow the terminal 'failed' publish state.
--
-- The one-click publish state machine distinguishes two non-published outcomes:
--   • 'needs_review' — a real Content row was created but is not clean; it awaits
--     human review in the Content Inbox (published_content_id is set).
--   • 'failed'       — the pipeline stopped BEFORE any Content row (source
--     retrieval / Writer / Editorial Director / Fidelity / validation rejection,
--     or a stale-processing timeout). Nothing exists to review; the card shows an
--     editorial-validation failure and offers a retry.
--
-- The original constraint (20260816160000) predated the failed/needs_review split
-- and only allowed ('processing','published','needs_review'), so every attempt to
-- persist 'failed' raised check_violation (23514) — which is exactly why a
-- terminated one-click publish orphaned its row in 'processing'. Extend the value
-- set to include 'failed'. NULL (never attempted) stays valid.

do $$ begin
  alter table public.radar_shadow_articles
    drop constraint if exists radar_publish_status_chk;
  alter table public.radar_shadow_articles
    add constraint radar_publish_status_chk
    check (publish_status is null or publish_status in ('processing','published','needs_review','failed'));
end $$;
