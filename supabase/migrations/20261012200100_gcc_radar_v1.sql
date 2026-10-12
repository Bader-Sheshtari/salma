-- ============================================================================
-- GCC RADAR V1 — additive GCC healthcare-intelligence layer (brief 2026-10-12).
--
-- Design (from the read-only audit):
--   * Collection: a NEW edge function (radar-gcc) fetches REGISTERED sources
--     (RSS where it exists, otherwise tolerant listing-page link extraction —
--     EventRegistry surfaces ~40 GCC items/15 days, Kuwait ≈ zero, so the GCC
--     layer needs its own retrieval).
--   * Collected items are inserted into the EXISTING radar_shadow_articles
--     with provider='gcc' — radar-rank, ESL, retention, inbox and Develop
--     Story pick them up automatically (verified: nothing downstream filters
--     by provider). country holds the English label ("Kuwait"), language is
--     ISO-639-3 — both match existing conventions (geoGuard / UI maps).
--   * Per-item intelligence (topic taxonomy, consequence signals, orgs,
--     strategic flag, «لماذا يهم», gcc_score) is 100% deterministic (zero new
--     LLM calls) and lives in a SIDECAR table keyed by the radar row id with
--     ON DELETE CASCADE, so radar retention stays untouched and correct.
--   * NOTHING here modifies news_sources, radar-rank scoring, ESL selection,
--     retention windows, or any existing cron (brief §7, §11, §29).
-- ============================================================================

-- --- 1. GCC source registry (separate from news_sources BY DESIGN: §7) ------

create table if not exists public.gcc_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_ar text,
  domain text not null unique,
  country_code text not null
    check (country_code in ('KW','SA','AE','QA','BH','OM')),
  source_class text not null
    check (source_class in ('government','regulator','provider','insurance',
                            'digital_health','pharma_medtech','investment','wire','media')),
  -- 1 = official/regulator, 2 = wire/major institution, 3 = quality media,
  -- 4 = aggregator/other (downgraded by design — brief §25).
  authority_tier smallint not null default 3 check (authority_tier between 1 and 4),
  language text not null default 'ara' check (language in ('ara','eng','mixed')),
  fetch_method text not null check (fetch_method in ('rss','listing')),
  fetch_url text not null,
  include_pattern text,                       -- listing only: href regex filter
  -- true = the fetched page/feed is already health-scoped (ministry newsroom,
  -- health section) → skip the healthcare keyword gate.
  healthcare_only boolean not null default false,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  -- Freshness signals (§20 — simple flagging, not a monitoring project).
  last_fetch_at timestamptz,
  last_fetch_ok boolean,
  last_error text,
  last_item_at timestamptz,                   -- newest item observed from this source
  consecutive_failures int not null default 0
);

-- --- 2. Per-article GCC intelligence sidecar --------------------------------

create table if not exists public.radar_gcc_intel (
  radar_article_id uuid primary key
    references public.radar_shadow_articles (id) on delete cascade,
  source_id uuid references public.gcc_sources (id) on delete set null,
  country_code text not null,
  topics text[] not null default '{}',        -- brief §9 taxonomy keys
  signals text[] not null default '{}',       -- brief §10 consequence signals
  orgs text[] not null default '{}',          -- brief §12 canonical org keys
  authority_tier smallint not null default 3,
  strategic boolean not null default false,   -- «تطور مهم» (§18)
  strategic_reasons text[] not null default '{}',
  gcc_score numeric not null default 0,       -- deterministic 0–100 (§11; view-only)
  why_ar text,                                -- «لماذا يهم؟» (§17)
  created_at timestamptz not null default now()
);

create index if not exists radar_gcc_intel_country_idx
  on public.radar_gcc_intel (country_code);
create index if not exists radar_gcc_intel_score_idx
  on public.radar_gcc_intel (gcc_score desc);

-- --- 3. Run log (own table: radar_shadow_runs stays EventRegistry-only so
--        pipeline-health profile bucketing is untouched) ---------------------

create table if not exists public.gcc_radar_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running',     -- running | success | failure
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  sources_attempted int not null default 0,
  sources_ok int not null default 0,
  returned_count int not null default 0,
  inserted_count int not null default 0,
  duplicate_count int not null default 0,
  filtered_count int not null default 0,      -- failed the healthcare gate
  backfill_skipped int not null default 0,    -- outside the 14-day backfill window (§28)
  per_source jsonb,                           -- [{domain, ok, returned, inserted, error}]
  error text
);

-- --- RLS: staff-only, written by the service role (mirrors radar tables) ----

alter table public.gcc_sources enable row level security;
alter table public.radar_gcc_intel enable row level security;
alter table public.gcc_radar_runs enable row level security;

drop policy if exists gcc_sources_admin_all on public.gcc_sources;
create policy gcc_sources_admin_all on public.gcc_sources
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists radar_gcc_intel_admin_all on public.radar_gcc_intel;
create policy radar_gcc_intel_admin_all on public.radar_gcc_intel
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists gcc_radar_runs_admin_all on public.gcc_radar_runs;
create policy gcc_radar_runs_admin_all on public.gcc_radar_runs
  for all using (public.is_admin()) with check (public.is_admin());

-- --- Cron entrypoint (same pattern + secret as run_radar_shadow) ------------

create or replace function public.run_gcc_radar()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_secret text;
begin
  select value into v_secret from public.app_config where key = 'cron_secret';
  if v_secret is null or v_secret = '' then
    return; -- never call the collector unauthenticated
  end if;
  perform net.http_post(
    url := 'https://ukraltlejlfkqbcifgcq.supabase.co/functions/v1/radar-gcc',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcmFsdGxlamxma3FiY2lmZ2NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk1MDAsImV4cCI6MjA5ODMxNTUwMH0.dgTWGjHELu8BML_pNWdtCb0bmagD2KKBr97Rwv4yFl8',
      'x-ingest-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
end;
$$;

revoke all on function public.run_gcc_radar() from public, anon, authenticated;

-- Every 3 hours at :25 (offset from radar-shadow :00 and radar-rank :10 so the
-- hourly rank pass picks fresh GCC rows up within ~45 minutes).
select cron.unschedule('salma-gcc-radar')
where exists (select 1 from cron.job where jobname = 'salma-gcc-radar');

select cron.schedule('salma-gcc-radar', '25 */3 * * *', $$ select public.run_gcc_radar(); $$);

-- --- Seed registry (curated; feed URLs verified by live probe 2026-10-12;
--     listing patterns are data — adjustable without a deploy) ---------------
-- Kuwait first (priority 1), then Saudi Arabia, then UAE (§22–24).

insert into public.gcc_sources
  (name, name_ar, domain, country_code, source_class, authority_tier, language,
   fetch_method, fetch_url, include_pattern, healthcare_only, notes)
values
  -- ---------------- Kuwait ----------------
  ('Ministry of Health Kuwait', 'وزارة الصحة الكويتية', 'moh.gov.kw', 'KW', 'government', 1, 'ara',
   'listing', 'https://www.moh.gov.kw/ar/Pages/Media.aspx', 'NewsDetail\.aspx', true,
   'SharePoint newsroom; server-rendered links verified locally, but TIMES OUT from the edge region (likely geo/IP filtering) — watch coverage report.'),
  ('KUNA — Health', 'كونا — الصحة', 'kuna.net.kw', 'KW', 'wire', 2, 'ara',
   'listing', 'https://www.kuna.net.kw/CategoryPage.aspx?language=ar&category=Health', 'ArticleDetails\.aspx', true,
   'Official Kuwait news agency, health category (16 links verified locally); TIMES OUT from the edge region (likely geo/IP filtering) — watch coverage report.'),
  ('Al Qabas', 'القبس', 'alqabas.com', 'KW', 'media', 3, 'ara',
   'listing', 'https://www.alqabas.com/', '/article/', false,
   'JS-rendered homepage — produces 0 items until a feed/section URL is found.'),
  ('Al Jarida', 'الجريدة', 'aljarida.com', 'KW', 'media', 3, 'ara',
   'listing', 'https://www.aljarida.com/', '/(article|news)/', false, null),
  ('Al Anba', 'الأنباء', 'alanba.com.kw', 'KW', 'media', 3, 'ara',
   'listing', 'https://www.alanba.com.kw/', '/[0-9]{6,}', false, null),
  ('Arab Times', 'أراب تايمز', 'arabtimesonline.com', 'KW', 'media', 3, 'eng',
   'listing', 'https://www.arabtimesonline.com/', '/news/', false, null),
  ('Kuwait Times', 'كويت تايمز', 'kuwaittimes.com', 'KW', 'media', 3, 'eng',
   'listing', 'https://kuwaittimes.com/top-stories', '/article/', false, null),

  -- ---------------- Saudi Arabia ----------------
  ('Saudi FDA', 'الهيئة العامة للغذاء والدواء', 'sfda.gov.sa', 'SA', 'regulator', 1, 'ara',
   'rss', 'https://www.sfda.gov.sa/ar/rss.xml', null, true,
   'Working RSS verified 2026-10-12.'),
  ('Ministry of Health Saudi Arabia', 'وزارة الصحة السعودية', 'moh.gov.sa', 'SA', 'government', 1, 'ara',
   'listing', 'https://www.moh.gov.sa/Ministry/MediaCenter/News/Pages/default.aspx', 'MediaCenter/News', true,
   'SharePoint; may render lazily — watch freshness flag.'),
  ('Council of Health Insurance', 'مجلس الضمان الصحي', 'chi.gov.sa', 'SA', 'insurance', 1, 'ara',
   'listing', 'https://chi.gov.sa/', '(news|News)', true, null),
  ('Saudi Press Agency', 'واس', 'spa.gov.sa', 'SA', 'wire', 2, 'ara',
   'listing', 'https://www.spa.gov.sa/ar/health', '/w[0-9]+', true,
   'May be client-rendered — watch freshness flag.'),
  ('Argaam', 'أرقام', 'argaam.com', 'SA', 'media', 3, 'ara',
   'listing', 'https://www.argaam.com/ar', '/articledetail/', false,
   'Financial/market coverage of listed healthcare companies.'),
  ('Asharq Al-Awsat', 'الشرق الأوسط', 'aawsat.com', 'SA', 'media', 3, 'ara',
   'rss', 'https://aawsat.com/feed', null, false,
   'Working RSS verified 2026-10-12.'),
  ('Arab News', 'أراب نيوز', 'arabnews.com', 'SA', 'media', 3, 'eng',
   'rss', 'https://www.arabnews.com/rss.xml', null, false,
   'Working RSS verified 2026-10-12.'),
  ('Al Riyadh', 'الرياض', 'alriyadh.com', 'SA', 'media', 3, 'ara',
   'listing', 'https://www.alriyadh.com/', '/[0-9]{6,}', false, null),

  -- ---------------- UAE ----------------
  ('MoHAP UAE', 'وزارة الصحة ووقاية المجتمع', 'mohap.gov.ae', 'AE', 'government', 1, 'ara',
   'listing', 'https://mohap.gov.ae/ar/media-center/news', '/news/', true,
   'May be client-rendered — watch freshness flag.'),
  ('Dubai Health Authority', 'هيئة الصحة بدبي', 'dha.gov.ae', 'AE', 'government', 1, 'ara',
   'listing', 'https://www.dha.gov.ae/ar/press-releases', '(press-release|news)', true, null),
  ('Department of Health Abu Dhabi', 'دائرة الصحة أبوظبي', 'doh.gov.ae', 'AE', 'government', 1, 'eng',
   'listing', 'https://www.doh.gov.ae/en/news', '/news/', true, null),
  ('WAM', 'وام', 'wam.ae', 'AE', 'wire', 2, 'ara',
   'listing', 'https://www.wam.ae/ar', '/ar(ticle)?/', false,
   'Bot-protected (F5) — likely stale; kept to surface via coverage report.'),
  ('Khaleej Times — UAE', 'خليج تايمز', 'khaleejtimes.com', 'AE', 'media', 3, 'eng',
   'rss', 'https://www.khaleejtimes.com/api/v1/collections/uae.rss', null, false,
   'Working RSS (autodiscovered) verified 2026-10-12.'),
  ('Gulf News — Health', 'جلف نيوز — الصحة', 'gulfnews.com', 'AE', 'media', 3, 'eng',
   'listing', 'https://gulfnews.com/uae/health', '/uae/health/', true, null),
  ('The National — Health', 'ذا ناشيونال — الصحة', 'thenationalnews.com', 'AE', 'media', 3, 'eng',
   'listing', 'https://www.thenationalnews.com/health/', '/health/', true, null),
  ('Al Bayan', 'البيان', 'albayan.ae', 'AE', 'media', 3, 'ara',
   'listing', 'https://www.albayan.ae/', '/[0-9]{5,}', false, null),
  ('Emarat Al Youm', 'الإمارات اليوم', 'emaratalyoum.com', 'AE', 'media', 3, 'ara',
   'listing', 'https://www.emaratalyoum.com/', '/[0-9]{4}-[0-9]{2}-[0-9]{2}-', false, null),
  ('Zawya — Health', 'زاوية — الصحة', 'zawya.com', 'AE', 'media', 4, 'eng',
   'listing', 'https://www.zawya.com/en/life/health', '/(health|press-release)', true,
   'Aggregator/press-release heavy → tier 4 (downgraded by design, §25).')
on conflict (domain) do nothing;
