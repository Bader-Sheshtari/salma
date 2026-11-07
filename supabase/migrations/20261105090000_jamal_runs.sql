-- Jamal (جمال) integration — audit sidecar (Rev 2, steps 1–3).
-- Additive and non-destructive: a NEW table only; no existing table, column,
-- policy or trigger is touched. One row per Jamal write attempt (accepted,
-- needs-review, rejected or transport failure) so every run is replayable:
-- the exact source snapshot the draft was written AND validated against, the
-- sanitized-input hash, Jamal's own selection/notes, and the validation result.
--
-- NOTE: provided for owner review and NOT applied by this change (owner
-- condition 2: no migration execution). It must be applied BEFORE any ingest
-- deploy that carries writer_mode:"jamal", because index.ts inserts here on
-- every Jamal run (best-effort: a missing table logs an error and never fails
-- the run or the mandatory ingestion_decisions audit).
create table if not exists public.jamal_runs (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  run_id             uuid null,
  content_id         uuid null references public.content(id) on delete set null,
  config_version     text not null,
  technique          text not null,
  model              text not null,
  source_url         text not null,
  source_snapshot    text not null,
  source_sha256      text not null,
  jamal_input_sha256 text not null,
  sanitizer_version  text not null,
  sanitizer_applied  boolean not null,
  selection          jsonb null,
  review_notes       jsonb not null default '[]'::jsonb,
  source_reference   text null,
  accepted           boolean not null,
  validation_result  text not null,
  usage              jsonb null
);

-- Service-role-only (same pattern as the other observability sidecars):
-- RLS enabled with NO policies — only the service role (which bypasses RLS)
-- can read or write; anon/authenticated clients get nothing.
alter table public.jamal_runs enable row level security;
