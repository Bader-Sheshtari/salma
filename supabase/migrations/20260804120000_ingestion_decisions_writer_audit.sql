-- E1.3C — Salma Writer Routing (audit metadata)
-- Non-destructive: adds nullable audit columns to ingestion_decisions so a
-- decision that reached the writing stage can record which profile/model wrote
-- it, whether the technical fallback was used, the writer prompt version, and
-- any factual-validation rejection reason. No historical rows are modified (new
-- columns default to NULL) and no existing content is touched. rejection_reason
-- stays free text, so the new writer rejection strings (writer_unavailable,
-- writer_error, unsupported_number:*, association_as_causation, malformed_output:*)
-- need no schema change.
--
-- NOTE: This migration is provided for review and is NOT applied in this
-- checkpoint. It must be applied before the E1.3C pending-only pilot, because
-- the ingestion function writes these columns on every decision that reaches
-- the writer.
alter table public.ingestion_decisions
  add column if not exists writing_profile          text,
  add column if not exists writer_primary_model     text,
  add column if not exists writer_model_used        text,
  add column if not exists writer_fallback_used     boolean,
  add column if not exists writer_prompt_version    text,
  add column if not exists writer_validation_reason text;
