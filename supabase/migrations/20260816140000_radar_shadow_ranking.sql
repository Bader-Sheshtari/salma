-- Fast News Radar — SHADOW MODE: ranking + duplicate-status fields + run log.
--
-- Adds Radar-side editorial evaluation to the existing radar_shadow_articles
-- table, plus an isolated radar_rank_runs diagnostics table. STILL SHADOW MODE
-- ONLY. These fields/tables are an independent evaluation of shadow discoveries;
-- they do NOT touch content, publishing, ingest-news, the Writer, the Editorial
-- Director, Fidelity, or news_sources.
--
-- All ranking columns are nullable so a freshly-collected (not-yet-ranked) row
-- is a valid UNRANKED state (priority_level IS NULL) — never silently treated as
-- Low Priority.
--
-- matched_content_id is a plain nullable uuid WITHOUT a foreign key to content:
-- it is only a soft reference/link for the Radar Admin UI. We deliberately keep
-- Radar decoupled from content at the schema level for now.

alter table public.radar_shadow_articles
  add column if not exists priority_score int,                 -- 0..100 internal score
  add column if not exists priority_level text,                -- 'very_important' | 'important' | 'low' | null (unranked)
  add column if not exists editorial_value text,               -- final editorial classification (auditability)
  add column if not exists expected_category_slug text,        -- suggested Salma taxonomy slug (radar-side only)
  add column if not exists duplicate_status text,              -- 'new' | 'already_in_salma' | 'possible_duplicate' | null
  add column if not exists matched_content_id uuid,            -- soft link to public.content.id (NO FK on purpose)
  add column if not exists ranked_at timestamptz,              -- when this row was successfully evaluated (null => needs ranking)
  add column if not exists rank_error text,                    -- last ranking-error summary; set => UNRANKED_ERROR, still retryable
  add column if not exists rank_attempts int not null default 0; -- number of ranking attempts (diagnostic; avoids surprise on retries)

-- Value constraints (NULLs always allowed). Named so they are idempotent-safe
-- to reason about; this migration is applied exactly once.
do $$ begin
  alter table public.radar_shadow_articles
    add constraint radar_priority_level_chk
    check (priority_level is null or priority_level in ('very_important','important','low'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.radar_shadow_articles
    add constraint radar_editorial_value_chk
    check (editorial_value is null or editorial_value in
      ('newsworthy_new_development','editorial_opportunity','evergreen_generic','not_relevant'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.radar_shadow_articles
    add constraint radar_duplicate_status_chk
    check (duplicate_status is null or duplicate_status in ('new','already_in_salma','possible_duplicate'));
exception when duplicate_object then null; end $$;

-- "Needs ranking" work queue: never-ranked rows OR previously-errored rows
-- (both have ranked_at IS NULL). radar-rank pulls from here newest-first.
create index if not exists radar_shadow_articles_needs_rank_idx
  on public.radar_shadow_articles (first_seen_at desc)
  where ranked_at is null;

-- One row per radar-rank run (manual or scheduled) — minimal cost/diagnostics.
-- Isolated from radar_shadow_runs so ranking never touches collection state.
create table if not exists public.radar_rank_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null default 'manual',
  status text not null default 'success',          -- 'success' | 'failure'
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  attempted_count int not null default 0,          -- articles this run tried to rank
  ranked_count int not null default 0,             -- successfully ranked this run
  retry_count int not null default 0,              -- items sent to smaller retry batches
  unranked_error_count int not null default 0,     -- still unresolved after retries (stay retryable)
  duplicate_new_count int not null default 0,
  duplicate_already_count int not null default 0,
  duplicate_possible_count int not null default 0,
  model text,
  openrouter_calls int not null default 0,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  total_tokens int not null default 0,
  cost numeric,                                    -- OpenRouter reported cost (USD), if available
  duration_ms int,
  error text
);

-- RLS: run log is admin-only, mirroring the radar_shadow_* tables. The edge
-- function uses the service role (bypasses RLS); no public/authenticated grant.
alter table public.radar_rank_runs enable row level security;

drop policy if exists radar_rank_runs_admin_all on public.radar_rank_runs;
create policy radar_rank_runs_admin_all on public.radar_rank_runs
  for all using (public.is_admin()) with check (public.is_admin());
