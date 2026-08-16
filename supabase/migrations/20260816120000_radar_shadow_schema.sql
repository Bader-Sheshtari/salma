-- Fast News Radar — SHADOW MODE v1 (isolated, observation-only).
-- These tables exist ONLY to observe how a fast global news provider
-- (Event Registry / NewsAPI.ai) surfaces healthcare articles over time.
-- They do NOT touch content, ingestion_runs, news_sources, the Writer,
-- the Editorial Director, Fidelity, or publication. Nothing here feeds the
-- editorial pipeline. All tables are admin-only (RLS) and written by the
-- radar-shadow edge function via the service role.

-- One row per radar-shadow run (manual or, later, scheduled).
create table if not exists public.radar_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null default 'manual',
  status text not null default 'success',        -- 'success' | 'failure'
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  checkpoint_before timestamptz,                 -- last_poll_tm before this run
  checkpoint_after timestamptz,                  -- last_poll_tm after this run (only advanced on success)
  returned_count int not null default 0,         -- articles the provider returned
  inserted_count int not null default 0,         -- new unique articles stored
  duplicate_count int not null default 0,        -- already-seen provider articles skipped
  stale_skipped_count int not null default 0,    -- returned but older than freshness guard
  languages text[] not null default '{}',        -- distinct languages represented in returned set
  usage_info jsonb,                              -- free provider token/usage snapshot, if available
  error text
);

-- One row per distinct provider article observed (deduped by provider + provider_uri).
create table if not exists public.radar_shadow_articles (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'eventregistry',
  provider_uri text not null,                    -- stable provider article id (r.uri)
  event_uri text,                                -- provider event id (nullable — often null)
  title text,
  url text,
  source_title text,
  source_domain text,
  language text,
  country text,
  published_at timestamptz,                      -- article publication time (r.dateTimePub/dateTime)
  provider_seen_at timestamptz,                  -- when provider first added it (r.dateTimeAdded)
  first_seen_at timestamptz not null default now(), -- when Salma radar first observed it
  run_id uuid references public.radar_shadow_runs (id) on delete set null
);

-- Prevent storing the same provider article twice.
create unique index if not exists radar_shadow_articles_provider_uri_uniq
  on public.radar_shadow_articles (provider, provider_uri);

-- Fast "what did we see recently" queries.
create index if not exists radar_shadow_articles_first_seen_idx
  on public.radar_shadow_articles (first_seen_at desc);

-- Single-row-per-provider polling checkpoint (UTC). Advanced only after a successful run.
create table if not exists public.radar_shadow_state (
  provider text primary key default 'eventregistry',
  last_poll_tm timestamptz,
  updated_at timestamptz not null default now()
);

-- RLS: all three tables are admin-only. The edge function uses the service
-- role, which bypasses RLS; no public or authenticated access is granted.
alter table public.radar_shadow_runs enable row level security;
alter table public.radar_shadow_articles enable row level security;
alter table public.radar_shadow_state enable row level security;

drop policy if exists radar_shadow_runs_admin_all on public.radar_shadow_runs;
create policy radar_shadow_runs_admin_all on public.radar_shadow_runs
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists radar_shadow_articles_admin_all on public.radar_shadow_articles;
create policy radar_shadow_articles_admin_all on public.radar_shadow_articles
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists radar_shadow_state_admin_all on public.radar_shadow_state;
create policy radar_shadow_state_admin_all on public.radar_shadow_state
  for all using (public.is_admin()) with check (public.is_admin());
