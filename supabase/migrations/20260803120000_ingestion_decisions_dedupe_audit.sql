-- E1.2 — Semantic Story Deduplication (audit metadata)
-- Non-destructive: adds nullable audit columns to ingestion_decisions so a
-- semantic-duplicate decision can record WHAT it matched and HOW confidently.
-- No historical rows are modified (new columns default to NULL) and no existing
-- content is touched. rejection_reason stays a free-text column, so the new
-- duplicate_semantic_* reasons need no schema change.
alter table public.ingestion_decisions
  add column if not exists duplicate_of_content_id uuid references public.content(id) on delete set null,
  add column if not exists similarity_score        real,
  add column if not exists dedupe_method           text,
  add column if not exists matched_title           text,
  add column if not exists selected_final_domain   text;

-- Helps audit "what did story X get collapsed into" lookups without scanning.
create index if not exists ingestion_decisions_duplicate_of
  on public.ingestion_decisions (duplicate_of_content_id);
