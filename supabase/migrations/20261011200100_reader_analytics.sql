-- ============================================================================
-- READER ANALYTICS — V1
--
-- First-party, privacy-conscious editorial analytics: anonymous events only.
-- No IPs, no identity, no fingerprinting, no cross-session identifiers — the
-- only client-side state is a random per-tab-session id in sessionStorage,
-- used purely for view deduplication, and it never reaches any third party.
-- This keeps the public privacy policy's "no external analytics tools" and
-- "no tracking cookies" statements true.
--
-- Shape:
--   reader_events        — raw anonymous events, 90-day retention.
--   reader_daily_stats   — per-article daily rollups, kept long-term.
--   reader_daily_sources — per-source daily rollups, kept long-term.
--   rollup_reader_events()        — daily cron: rollup + prune (03:50 UTC).
--   reader_analytics_dashboard()  — admin dashboard, one JSON round trip.
--   reader_article_stats()        — per-article panel (staff: editors see the
--                                   stats of articles they already work on;
--                                   the full dashboard stays admin+).
--
-- Writes go ONLY through the /api/track route with the service role (the
-- route validates the event, filters obvious bots, and verifies the target
-- article is published & not deleted — draft/pending/unpublished/rejected/
-- trashed content can never accumulate public analytics). Clients have no
-- write path; see RLS below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Raw events
-- ----------------------------------------------------------------------------
create table if not exists public.reader_events (
  id              bigint generated always as identity primary key,
  content_id      uuid not null references public.content(id) on delete cascade,
  event           text not null check (event in ('view', 'engaged', 'completed')),
  session_key     text not null,
  -- High-level traffic source group (client-classified, server-validated):
  source          text check (source in (
    'direct', 'search_engine', 'instagram', 'whatsapp', 'x', 'facebook',
    'telegram', 'internal', 'other'
  )),
  -- Where inside Salma the reader came from (internal traffic only):
  internal_source text check (internal_source in (
    'homepage', 'category', 'search', 'related', 'other'
  )),
  -- External referrer HOSTNAME only (never a full URL/path), for diagnosing
  -- the "other" bucket. Optional.
  referrer_domain text,
  created_at      timestamptz not null default now()
);

-- THE deduplication rule: one row per (article, anonymous session, event
-- kind). Refreshes and repeat scrolls in the same tab session can never
-- inflate any metric — the API inserts with ON CONFLICT DO NOTHING.
create unique index if not exists reader_events_dedup_uniq
  on public.reader_events (content_id, session_key, event);

create index if not exists reader_events_created_idx
  on public.reader_events (created_at desc);
create index if not exists reader_events_content_created_idx
  on public.reader_events (content_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 2. Long-term daily rollups (retention: raw 90 days, rollups indefinitely)
-- ----------------------------------------------------------------------------
create table if not exists public.reader_daily_stats (
  day        date not null,            -- Asia/Kuwait calendar day
  content_id uuid not null references public.content(id) on delete cascade,
  views      integer not null default 0,
  engaged    integer not null default 0,
  completed  integer not null default 0,
  primary key (day, content_id)
);

create table if not exists public.reader_daily_sources (
  day             date not null,
  source          text not null,
  internal_source text not null default '',  -- '' = external/unknown ('' keeps the PK total)
  views           integer not null default 0,
  primary key (day, source, internal_source)
);

-- ----------------------------------------------------------------------------
-- 3. Rollup + retention (daily cron)
--    Idempotent: recomputes every Kuwait day that still has raw events and is
--    already over (never today), then prunes raw events older than 90 days.
--    Rollups are never pruned by this function.
-- ----------------------------------------------------------------------------
create or replace function public.rollup_reader_events()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Kuwait')::date;
  v_rolled integer := 0;
  v_pruned integer := 0;
begin
  insert into public.reader_daily_stats as s (day, content_id, views, engaged, completed)
  select (e.created_at at time zone 'Asia/Kuwait')::date,
         e.content_id,
         count(*) filter (where e.event = 'view'),
         count(*) filter (where e.event = 'engaged'),
         count(*) filter (where e.event = 'completed')
    from public.reader_events e
   where (e.created_at at time zone 'Asia/Kuwait')::date < v_today
   group by 1, 2
  on conflict (day, content_id) do update
    set views = excluded.views, engaged = excluded.engaged, completed = excluded.completed;
  get diagnostics v_rolled = row_count;

  insert into public.reader_daily_sources as s (day, source, internal_source, views)
  select (e.created_at at time zone 'Asia/Kuwait')::date,
         coalesce(e.source, 'other'),
         coalesce(e.internal_source, ''),
         count(*)
    from public.reader_events e
   where e.event = 'view'
     and (e.created_at at time zone 'Asia/Kuwait')::date < v_today
   group by 1, 2, 3
  on conflict (day, source, internal_source) do update
    set views = excluded.views;

  delete from public.reader_events where created_at < now() - interval '90 days';
  get diagnostics v_pruned = row_count;

  return jsonb_build_object('rolled_rows', v_rolled, 'pruned_events', v_pruned);
end;
$$;

revoke all on function public.rollup_reader_events() from public, anon, authenticated;
grant execute on function public.rollup_reader_events() to service_role;

-- ----------------------------------------------------------------------------
-- 4. Dashboard RPC — admin-gated, one JSON round trip. Windows ≤ 30 days
--    always sit inside the 90-day raw retention, so it reads raw events
--    (indexed) and search_queries directly.
--    p_days: 1 = "اليوم" (since Kuwait midnight), else a trailing N-day
--    window (clamped 1..30).
-- ----------------------------------------------------------------------------
create or replace function public.reader_analytics_dashboard(p_days integer default 7)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 7), 1), 30);
  v_from timestamptz;
  v_out  jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_from := case when v_days = 1
                 then (date_trunc('day', now() at time zone 'Asia/Kuwait')) at time zone 'Asia/Kuwait'
                 else now() - make_interval(days => v_days) end;

  with ev as (
    select * from public.reader_events where created_at >= v_from
  ),
  per_article as (
    select e.content_id,
           count(*) filter (where e.event = 'view')      as views,
           count(*) filter (where e.event = 'engaged')   as engaged,
           count(*) filter (where e.event = 'completed') as completed
      from ev e group by e.content_id
  ),
  totals as (
    select coalesce(sum(views), 0) as views,
           coalesce(sum(engaged), 0) as engaged,
           coalesce(sum(completed), 0) as completed
      from per_article
  ),
  top_read as (
    select c.id, c.title, c.slug, c.category_slug, c.published_at,
           p.views, p.engaged, p.completed
      from per_article p join public.content c on c.id = p.content_id
     order by p.views desc, c.published_at desc nulls last limit 8
  ),
  top_engaged as (
    select c.id, c.title, c.slug, c.published_at, p.views,
           round(p.engaged::numeric / p.views, 3) as rate
      from per_article p join public.content c on c.id = p.content_id
     where p.views >= 10
     order by rate desc, p.views desc limit 8
  ),
  top_completed as (
    select c.id, c.title, c.slug, c.published_at, p.views,
           round(p.completed::numeric / p.views, 3) as rate
      from per_article p join public.content c on c.id = p.content_id
     where p.views >= 10
     order by rate desc, p.views desc limit 8
  ),
  sources as (
    select coalesce(e.source, 'other') as source, count(*) as views
      from ev e where e.event = 'view' group by 1 order by views desc
  ),
  internal as (
    select e.internal_source, count(*) as views
      from ev e
     where e.event = 'view' and e.internal_source is not null
     group by 1 order by views desc
  ),
  cats as (
    select c.category_slug, cat.name_ar,
           count(distinct c.id)                            as articles,
           sum(p.views)                                    as views,
           sum(p.engaged)                                  as engaged,
           round(sum(p.engaged)::numeric / nullif(sum(p.views), 0), 3) as engagement_rate
      from per_article p
      join public.content c on c.id = p.content_id
      left join public.categories cat on cat.slug = c.category_slug
     group by 1, 2 order by views desc
  ),
  sq as (
    select * from public.search_queries where created_at >= v_from
  ),
  top_terms as (
    select s.query_norm, count(*) as searches, max(s.result_count) as results
      from sq s group by 1 order by searches desc limit 10
  ),
  zero_terms as (
    select s.query_norm, count(*) as searches
      from sq s where s.result_count = 0 group by 1 order by searches desc limit 10
  )
  select jsonb_build_object(
    'overview', (select jsonb_build_object(
        'views', t.views, 'engaged', t.engaged, 'completed', t.completed,
        'engagement_rate', round(t.engaged::numeric / nullif(t.views, 0), 3),
        'completion_rate', round(t.completed::numeric / nullif(t.views, 0), 3),
        'published_in_period',
          (select count(*) from public.content c
            where c.status = 'published' and c.deleted_at is null
              and c.first_published_at >= v_from)
      ) from totals t),
    'top_read',      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from top_read r),
    'top_engaged',   (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from top_engaged r),
    'top_completed', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from top_completed r),
    'sources',       (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from sources r),
    'internal',      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from internal r),
    'categories',    (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from cats r),
    'search', jsonb_build_object(
        'volume', (select count(*) from sq),
        'zero_count', (select count(*) from sq where result_count = 0),
        'top_terms',  (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from top_terms r),
        'zero_terms', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from zero_terms r)
      )
  ) into v_out;
  return v_out;
end;
$$;

revoke all on function public.reader_analytics_dashboard(integer) from public, anon;
grant execute on function public.reader_analytics_dashboard(integer) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. Per-article panel RPC — staff-gated (editors already see these articles;
--    the full dashboard stays admin+).
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER (with an explicit is_staff() guard): editors must see the
-- per-article panel, but raw reader_events stays admin-only at the RLS layer —
-- an invoker function would read zero rows for editors.
create or replace function public.reader_article_stats(p_content_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with win as (
    select 7 as days, now() - interval '7 days' as since
    union all
    select 30, now() - interval '30 days'
  ),
  agg as (
    select w.days,
           count(*) filter (where e.event = 'view')      as views,
           count(*) filter (where e.event = 'engaged')   as engaged,
           count(*) filter (where e.event = 'completed') as completed,
           (select e2.source from public.reader_events e2
             where e2.content_id = p_content_id and e2.event = 'view'
               and e2.created_at >= w.since and e2.source is not null
             group by e2.source order by count(*) desc limit 1) as top_source
      from win w
      left join public.reader_events e
        on e.content_id = p_content_id and e.created_at >= w.since
     group by w.days, w.since
  )
  select jsonb_object_agg('d' || a.days::text, jsonb_build_object(
           'views', a.views, 'engaged', a.engaged, 'completed', a.completed,
           'completion_rate', round(a.completed::numeric / nullif(a.views, 0), 3),
           'top_source', a.top_source))
    into v_out from agg a;
  return coalesce(v_out, '{}'::jsonb);
end;
$$;

revoke all on function public.reader_article_stats(uuid) from public, anon;
grant execute on function public.reader_article_stats(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. RLS — clients cannot write anywhere; admins may read raw events and
--    rollups directly (dashboards use the RPCs, but direct reads are safe).
-- ----------------------------------------------------------------------------
alter table public.reader_events        enable row level security;
alter table public.reader_daily_stats   enable row level security;
alter table public.reader_daily_sources enable row level security;

drop policy if exists "admins read reader events" on public.reader_events;
create policy "admins read reader events"
  on public.reader_events for select to authenticated using (public.is_admin());
drop policy if exists "admins read reader daily stats" on public.reader_daily_stats;
create policy "admins read reader daily stats"
  on public.reader_daily_stats for select to authenticated using (public.is_admin());
drop policy if exists "admins read reader daily sources" on public.reader_daily_sources;
create policy "admins read reader daily sources"
  on public.reader_daily_sources for select to authenticated using (public.is_admin());

-- ----------------------------------------------------------------------------
-- 7. Daily rollup/retention cron (03:50 UTC, after the radar cleanup at 03:40).
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'salma-analytics-rollup';
    perform cron.schedule('salma-analytics-rollup', '50 3 * * *',
      $job$ select public.rollup_reader_events(); $job$);
  end if;
end $$;
