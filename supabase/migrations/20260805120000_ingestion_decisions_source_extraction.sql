-- E1.3D — Salma verified-source extraction (audit metadata)
-- Non-destructive: adds nullable audit columns to ingestion_decisions so a
-- PILOT decision that reached the verified-source stage can record HOW the
-- source body was extracted (json-ld / article / main / paragraphs) and its
-- size (character and word counts). No historical rows are modified (new columns
-- default to NULL) and no existing content is touched. The final extracted
-- domain reuses the existing selected_final_domain column, so no new column is
-- needed for it. rejection_reason stays free text, so the E1.3D source-fetch
-- rejection strings (source_fetch_failed, source_fetch_timeout,
-- source_domain_mismatch, source_content_too_short, source_text_unavailable,
-- source_pdf_not_supported, source_format_not_supported) need no schema change.
--
-- NOTE: This migration is provided for review and is NOT applied in this
-- checkpoint. It — like 20260804120000_ingestion_decisions_writer_audit.sql —
-- must be applied BEFORE the Edge Function is deployed for the E1.3C+E1.3D
-- pending-only pilot, because a pilot decision writes these columns on every
-- candidate that reaches the source-text/writer stage.
alter table public.ingestion_decisions
  add column if not exists source_extraction_method text,
  add column if not exists source_char_count        integer,
  add column if not exists source_word_count         integer;
