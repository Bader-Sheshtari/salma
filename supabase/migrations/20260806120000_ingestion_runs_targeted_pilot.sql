-- E1.3F — targeted single-article pilot (run-level provenance)
-- Non-destructive: adds ONE nullable column to ingestion_runs so a TARGETED
-- pilot run (an authorized manual pilot that supplied a registered
-- pilot_source_url) records WHICH registered domain it targeted. Discovery
-- pilots, legacy runs, and the scheduled cron leave it NULL. Only the registered
-- domain is stored here — never the full URL, any request header/secret, or any
-- extracted source body. The selected source URL/domain, extraction method and
-- counts, writing profile, models used, and validation result / rejection reason
-- are already recorded per candidate on ingestion_decisions, so no other schema
-- change is needed. No historical rows are modified (new column defaults to NULL)
-- and no existing content is touched.
--
-- NOTE: This migration is provided for review and is NOT applied in this
-- checkpoint. It must be applied BEFORE the Edge Function is deployed with the
-- E1.3F targeted-pilot code, because a targeted pilot's run row writes this
-- column on finalize. The Edge Function references the column ONLY for a targeted
-- run, so legacy/cron/ordinary-pilot runs are unaffected whether or not it is
-- applied.
alter table public.ingestion_runs
  add column if not exists pilot_source_domain text;
