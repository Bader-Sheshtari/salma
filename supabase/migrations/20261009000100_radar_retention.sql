-- Radar retention (owner-approved policy, 2026-10-09).
--
-- Salma Radar is a fresh-news discovery system, not a historical archive.
-- A daily cron deletes stale radar_shadow_articles rows in bounded batches,
-- logging every run to radar_cleanup_runs.
--
-- RETENTION RULES (delete only when ALL protections below have lapsed):
--   general / low / important / very_important ... 48 hours
--     (ESL breaking pool looks back 30h → 48h gives operational margin;
--      unselected important items are NOT kept for topic mining — owner call)
--   ranked lifestyle ............................. 15 days (L5 lane lookback = 14d)
--   duplicates (already_in_salma / possible_
--     duplicate / matched_content_id) ............ 7 days
--   promoted / mid-workflow / failed-publish
--     (publish_status set or published_content_id) 90 days
--     (permanent provenance lives in content, radar_editorial_selection,
--      ingestion_decisions and Evidence Cards)
--   referenced by radar_editorial_selection ...... NEVER deleted (this implementation)
--   run logs / health / audit / content history .. never touched here
--
-- Safety properties:
--   * Idempotent: pure predicate-based; re-running deletes nothing extra.
--   * Bounded: deletes in batches (default 5000), max batches per run, so it
--     can never hold long locks against ingestion/ranking/ESL.
--   * No FKs reference radar_shadow_articles (verified 2026-10-09), so deletes
--     cannot cascade; the selection soft-reference is explicitly protected.
--   * Zero interference: scheduled 03:40 UTC — collectors run at :00, ranking
--     at :10, ESL at 06:00.

create table if not exists public.radar_cleanup_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running','success','failed')),
  examined    bigint,
  deleted     bigint,
  batches     integer,
  duration_ms integer,
  error       text,
  details     jsonb
);

alter table public.radar_cleanup_runs enable row level security;
drop policy if exists radar_cleanup_runs_admin_select on public.radar_cleanup_runs;
create policy radar_cleanup_runs_admin_select on public.radar_cleanup_runs
  for select using (public.is_admin());
revoke all on table public.radar_cleanup_runs from anon;
revoke insert, update, delete, truncate on table public.radar_cleanup_runs from authenticated, service_role;

create or replace function public.radar_cleanup(
  p_batch_limit integer default 5000,
  p_max_batches integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id    bigint;
  v_started   timestamptz := clock_timestamp();
  v_examined  bigint;
  v_deleted   bigint := 0;
  v_batch     bigint;
  v_batches   integer := 0;
  v_limit     integer := least(greatest(coalesce(p_batch_limit, 5000), 100), 20000);
  v_max       integer := least(greatest(coalesce(p_max_batches, 20), 1), 100);
begin
  insert into public.radar_cleanup_runs (status) values ('running') returning id into v_run_id;

  -- Rows currently eligible under the retention rules (see header).
  select count(*) into v_examined
    from public.radar_shadow_articles r
   where r.first_seen_at <= now() - interval '48 hours'
     and r.id not in (select s.radar_article_id from public.radar_editorial_selection s
                       where s.radar_article_id is not null)
     and not ((r.publish_status is not null or r.published_content_id is not null)
              and r.first_seen_at > now() - interval '90 days')
     and not (r.ranked_at is not null and r.expected_category_slug = 'lifestyle'
              and r.first_seen_at > now() - interval '15 days')
     and not ((r.duplicate_status in ('already_in_salma','possible_duplicate')
               or r.matched_content_id is not null)
              and r.first_seen_at > now() - interval '7 days');

  while v_batches < v_max loop
    delete from public.radar_shadow_articles r
     where r.id in (
       select r2.id from public.radar_shadow_articles r2
        where r2.first_seen_at <= now() - interval '48 hours'
          and r2.id not in (select s.radar_article_id from public.radar_editorial_selection s
                             where s.radar_article_id is not null)
          and not ((r2.publish_status is not null or r2.published_content_id is not null)
                   and r2.first_seen_at > now() - interval '90 days')
          and not (r2.ranked_at is not null and r2.expected_category_slug = 'lifestyle'
                   and r2.first_seen_at > now() - interval '15 days')
          and not ((r2.duplicate_status in ('already_in_salma','possible_duplicate')
                    or r2.matched_content_id is not null)
                   and r2.first_seen_at > now() - interval '7 days')
        order by r2.first_seen_at
        limit v_limit);
    get diagnostics v_batch = row_count;
    v_batches := v_batches + 1;
    v_deleted := v_deleted + v_batch;
    exit when v_batch < v_limit;
  end loop;

  update public.radar_cleanup_runs
     set finished_at = now(), status = 'success',
         examined = v_examined, deleted = v_deleted, batches = v_batches,
         duration_ms = (extract(epoch from clock_timestamp() - v_started) * 1000)::integer,
         details = jsonb_build_object('batch_limit', v_limit, 'max_batches', v_max,
                                      'remaining', greatest(v_examined - v_deleted, 0))
   where id = v_run_id;

  return jsonb_build_object('ok', true, 'run_id', v_run_id,
                            'examined', v_examined, 'deleted', v_deleted, 'batches', v_batches);
exception when others then
  update public.radar_cleanup_runs
     set finished_at = now(), status = 'failed',
         examined = v_examined, deleted = v_deleted, batches = v_batches,
         duration_ms = (extract(epoch from clock_timestamp() - v_started) * 1000)::integer,
         error = sqlerrm
   where id = v_run_id;
  return jsonb_build_object('ok', false, 'run_id', v_run_id, 'error', sqlerrm);
end;
$$;

comment on function public.radar_cleanup(integer, integer) is
  'Daily Radar retention: deletes stale radar_shadow_articles per the owner-approved windows (48h general, 15d lifestyle, 7d duplicates, 90d promoted/failed, selection-referenced never). Bounded batches, logged to radar_cleanup_runs, idempotent.';

revoke execute on function public.radar_cleanup(integer, integer) from public, anon, authenticated, service_role;

-- Daily at 03:40 UTC — off the pipeline's schedule (collectors :00, rank :10, ESL 06:00).
select cron.schedule('salma-radar-cleanup', '40 3 * * *', $$select public.radar_cleanup();$$);

-- ROLLBACK:
-- select cron.unschedule('salma-radar-cleanup');
-- drop function if exists public.radar_cleanup(integer, integer);
-- drop table if exists public.radar_cleanup_runs;
