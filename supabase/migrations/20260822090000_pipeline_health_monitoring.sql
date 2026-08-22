-- Pipeline health monitoring completion (launch-readiness P1, 2026-08-22).
--
-- Reuses the radar-rank run-log pattern (run row written 'running' BEFORE work,
-- finalized success/partial/failed; a stale 'running' row = a crashed run) to
-- close the remaining silent-failure risk on ESL and the collectors, and adds a
-- single unified health surface. No editorial/discovery logic changes here —
-- this migration only adds observability schema.

-- 1) ESL run log ------------------------------------------------------------
-- One lightweight row per radar-editorial-select invocation. Does NOT duplicate
-- the per-decision audit in radar_editorial_selection — just run-level health.
create table if not exists public.radar_esl_runs (
  id               uuid primary key default gen_random_uuid(),
  job              text not null default 'radar-editorial-select',
  mode             text,                 -- shadow | live
  editorial_day    date,
  status           text not null,        -- running | success | partial | failed
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  cap              integer,
  remaining_cap    integer,
  pool_size        integer,              -- candidates considered
  clusters         integer,              -- event clusters considered
  selected         integer,
  promoted         integer,
  promotion_failed integer,
  duration_ms      integer,
  error            text
);
comment on table public.radar_esl_runs is
  'Run-level health log for the ESL (radar-editorial-select). running-first; a stale running row reveals a crash. Not a substitute for radar_editorial_selection (per-decision audit).';
create index if not exists radar_esl_runs_started_idx on public.radar_esl_runs (started_at desc);

alter table public.radar_esl_runs enable row level security;
drop policy if exists radar_esl_runs_admin_read on public.radar_esl_runs;
create policy radar_esl_runs_admin_read on public.radar_esl_runs
  for select to authenticated using (public.is_admin());
-- Edge function writes with the service-role key (bypasses RLS). No anon access.

-- 2) Collector run log: add profile so medical vs Healthy-Life are separable --
-- radar_shadow_runs already logs status/counts/error; it only lacked the
-- profile and a 'running'-first record. Both intakes share this one table
-- (one generic collector run log, per the task's preference).
alter table public.radar_shadow_runs add column if not exists profile text;
comment on column public.radar_shadow_runs.profile is
  'Discovery profile for this collector run: medical | healthy_life (null = legacy medical rows before this column existed).';
-- status is free text; the collector now also writes running | success | failure.

-- 3) Unified health view ----------------------------------------------------
-- One row per critical pipeline stage. last_ok_at counts success AND partial
-- (partial is a HEALTHY, resumable outcome for radar-rank/ESL); only 'failed'
-- and stale 'running' are unhealthy. Read-only, admin (security_invoker).
create or replace view public.pipeline_health
with (security_invoker = true) as
with rank_latest as (
  select * from public.radar_rank_runs order by started_at desc limit 1
),
esl_latest as (
  select * from public.radar_esl_runs order by started_at desc limit 1
),
shadow_med as (
  select * from public.radar_shadow_runs
   where coalesce(profile,'medical') = 'medical' order by started_at desc limit 1
),
shadow_life as (
  select * from public.radar_shadow_runs
   where profile = 'healthy_life' order by started_at desc limit 1
)
-- medical Radar intake
select
  'radar-shadow:medical'::text as stage,
  'every 2h'::text as expected_cadence,
  (select started_at from shadow_med) as last_run_at,
  (select max(finished_at) from public.radar_shadow_runs
     where coalesce(profile,'medical')='medical' and status='success') as last_ok_at,
  (select status from shadow_med) as last_status,
  (select count(*) from public.radar_shadow_runs
     where coalesce(profile,'medical')='medical' and status='running'
       and finished_at is null and started_at < now() - interval '15 minutes') as stale_running,
  (select count(*) from public.radar_shadow_runs
     where coalesce(profile,'medical')='medical' and status='failure'
       and started_at > now() - interval '24 hours') as failures_24h,
  null::integer as backlog,
  interval '3 hours' as ok_tolerance
union all
-- Healthy-Life intake
select
  'radar-shadow:healthy_life', '3x/day (01:30/09:30/17:30 UTC)',
  (select started_at from shadow_life),
  (select max(finished_at) from public.radar_shadow_runs where profile='healthy_life' and status='success'),
  (select status from shadow_life),
  (select count(*) from public.radar_shadow_runs
     where profile='healthy_life' and status='running' and finished_at is null
       and started_at < now() - interval '15 minutes'),
  (select count(*) from public.radar_shadow_runs
     where profile='healthy_life' and status='failure' and started_at > now() - interval '24 hours'),
  null::integer,
  interval '10 hours'
union all
-- radar-rank (partial is a healthy outcome)
select
  'radar-rank', 'hourly',
  (select started_at from rank_latest),
  (select max(finished_at) from public.radar_rank_runs where status in ('success','partial')),
  (select status from rank_latest),
  (select count(*) from public.radar_rank_runs
     where status='running' and finished_at is null and started_at < now() - interval '15 minutes'),
  (select count(*) from public.radar_rank_runs where status='failed' and started_at > now() - interval '24 hours'),
  (select count(*)::integer from public.radar_shadow_articles where ranked_at is null),
  interval '2 hours'
union all
-- ESL (3 runs/day; overnight gap up to ~12h, so a wide tolerance)
select
  'esl', '3x/day (06/12/18 UTC)',
  (select started_at from esl_latest),
  (select max(finished_at) from public.radar_esl_runs where status in ('success','partial')),
  (select status from esl_latest),
  (select count(*) from public.radar_esl_runs
     where status='running' and finished_at is null and started_at < now() - interval '20 minutes'),
  (select count(*) from public.radar_esl_runs where status='failed' and started_at > now() - interval '24 hours'),
  null::integer,
  interval '14 hours';

comment on view public.pipeline_health is
  'One row per critical pipeline stage: last run, last OK (success|partial), last status, stale running count, 24h failures, backlog (radar-rank), and the no-success tolerance. Read-only, admin.';

-- 4) Active-alert view: rows are the conditions currently TRUE. This is the
-- detection surface a push channel would consume. Backlog-abnormal threshold
-- for radar-rank is deliberately high (steady-state is small; the incident hit
-- ~595) so it only fires on a real stall.
create or replace view public.pipeline_health_alerts
with (security_invoker = true) as
select stage, 'last_run_failed'::text as alert,
       ('last run status = ' || coalesce(last_status,'?'))::text as detail
  from public.pipeline_health where last_status = 'failed'
union all
select stage, 'stale_running_run',
       (stale_running || ' run(s) stuck in running')::text
  from public.pipeline_health where stale_running > 0
union all
select stage, 'no_recent_success',
       ('no success/partial since ' || coalesce(to_char(last_ok_at,'YYYY-MM-DD HH24:MI'),'never'))::text
  from public.pipeline_health
 where last_ok_at is null or last_ok_at < now() - ok_tolerance
union all
select stage, 'backlog_abnormal',
       ('unranked backlog = ' || backlog)::text
  from public.pipeline_health where stage = 'radar-rank' and backlog > 400;

comment on view public.pipeline_health_alerts is
  'Active operational alerts (one row per currently-true condition) across the pipeline. Empty = healthy. Ready to be consumed by a push channel once a delivery provider is chosen.';
