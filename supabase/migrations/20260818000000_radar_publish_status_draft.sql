-- Fast News Radar — allow the 'draft' publish state (editorial preparation).
--
-- The new "تحرير في سلمى" (prepare-for-editing) workflow runs the SAME
-- source → Writer → Editorial Director → Fidelity pipeline as direct publish,
-- but instead of auto-publishing it creates the Salma Content row as `pending`
-- and leaves the Radar row in a terminal 'draft' state linked to that content
-- (published_content_id) so a human can edit title/body/category/cover/source in
-- the existing Content editor and then publish manually. Direct publish also
-- falls back to 'draft' when the produced article has no cover image, rather than
-- publishing an image-less article (graceful editorial fallback — NOT a failure).
--
-- 'draft' is terminal from the preparation pipeline's perspective (like
-- 'published' or a genuine 'needs_review' with content): the idempotency latch
-- never restarts it, so one Radar story maps to exactly one linked Content item.
-- Extend the value set to include 'draft'; every previously valid state (NULL,
-- processing, published, needs_review, failed) stays valid.

do $$ begin
  alter table public.radar_shadow_articles
    drop constraint if exists radar_publish_status_chk;
  alter table public.radar_shadow_articles
    add constraint radar_publish_status_chk
    check (publish_status is null or publish_status in ('processing','published','needs_review','failed','draft'));
end $$;
