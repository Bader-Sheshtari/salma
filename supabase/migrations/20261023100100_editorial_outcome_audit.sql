-- Phase 2 (editorial standard e2.2) — Editorial Director outcome audit.
-- Additive and non-destructive: two nullable text columns on
-- ingestion_decisions so every decision that reached the Editorial Director
-- records WHICH editor path decided the draft and under which editor prompt:
--   editor_outcome        accepted | repaired | kept_original | factual_rejected
--                         (salmaEditor.EditorialAudit.decision)
--   editor_prompt_version e.g. e2.2-salma-editor (EDITOR_PROMPT_VERSION)
-- No backfill (historical rows stay NULL), no index, no constraint (the value
-- set is enforced in code, like rejection_reason).
--
-- NOTE: provided for owner review and NOT applied by this change. It must be
-- applied BEFORE the ingest-news Edge Function carrying the P2 editor audit is
-- deployed, because logDecision writes these columns on every decision row.
alter table public.ingestion_decisions
  add column if not exists editor_outcome        text null,
  add column if not exists editor_prompt_version text null;
