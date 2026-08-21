-- Radar-rank reliability + observability (launch-readiness P1, 2026-08-21).
--
-- Context: radar-rank was 504-ing since ~08:10 UTC. Root cause = unbounded work
-- per invocation (MAX_PER_RUN=240 sequential LLM rows + a translate-retry
-- backfill of up to 240 MORE rows that GROWS with the backlog) → each run
-- exceeded the edge-function wall-clock limit and died BEFORE writing its
-- run row, so the failure was invisible. The function is being changed to do
-- bounded, budget-guarded, resumable work; this migration gives the run log
-- the columns that make a run observable and adds a compact health view.
--
-- Additive only: new nullable columns + one read-only view. No existing column,
-- policy, or row is altered. RLS on radar_rank_runs is unchanged (admin-only).

alter table public.radar_rank_runs
  add column if not exists backlog_before integer,
  add column if not exists backlog_after  integer,
  add column if not exists skipped_count   integer;  -- rows deferred to a later run (budget/cap)

comment on column public.radar_rank_runs.backlog_before is
  'Unranked radar_shadow_articles at run start (observability).';
comment on column public.radar_rank_runs.backlog_after is
  'Unranked radar_shadow_articles at run end (observability).';
comment on column public.radar_rank_runs.skipped_count is
  'Rows left for a later run because the per-run cap or wall-clock budget was reached.';

-- radar_rank_runs.status is a free-text column (no check constraint); the
-- function now writes: running | success | partial | failed. A row stuck in
-- 'running' with a finished_at IS NULL and an old started_at is a run that
-- crashed mid-flight (the previously-invisible failure mode).

-- Compact pipeline-health read surface (no dashboard, no alerting): a single
-- row an admin/query can read to see whether ranking is alive, when it last
-- succeeded, whether a run is stuck, and the current backlog.
create or replace view public.radar_rank_health
with (security_invoker = true) as
select
  (select max(finished_at) from public.radar_rank_runs where status = 'success')            as last_success_at,
  (select max(started_at)  from public.radar_rank_runs)                                       as last_run_started_at,
  (select status from public.radar_rank_runs order by started_at desc limit 1)                as last_run_status,
  -- runs stuck 'running' with no finish for > 15 min = crashed/never-completed.
  (select count(*) from public.radar_rank_runs
     where status = 'running' and finished_at is null
       and started_at < now() - interval '15 minutes')                                        as stale_running_runs,
  (select count(*) from public.radar_shadow_articles where ranked_at is null)                 as backlog_unranked,
  (select count(*) from public.radar_shadow_articles
     where ranked_at is null and first_seen_at > now() - interval '24 hours')                 as backlog_unranked_24h;

comment on view public.radar_rank_health is
  'One-row radar-rank health snapshot: last success, last run status, stale running runs, current unranked backlog. Read-only, admin (security_invoker).';
