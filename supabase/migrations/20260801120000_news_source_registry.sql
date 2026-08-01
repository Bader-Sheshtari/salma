-- E1.1 — Source Registry & Editorial Selection Foundation
-- Non-destructive: adds a structured, admin-editable news_sources registry that
-- becomes authoritative for source ranking, plus a per-candidate decision audit
-- log (ingestion_decisions). editorial_policy.trusted_sources is preserved as-is
-- but is no longer the authority for source selection.

-- ---------------------------------------------------------------------------
-- Host normalization: lowercase, strip scheme, leading "www.", and any
-- path/port/query/fragment. Used by the registry trigger and available to code.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_host(input text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(coalesce(input, ''))), '^[a-z][a-z0-9+.-]*://', ''),
        '^www\.', ''
      ),
      '[/:?#].*$', ''
    ),
    ''
  );
$$;

-- ---------------------------------------------------------------------------
-- news_sources registry
-- ---------------------------------------------------------------------------
create table if not exists public.news_sources (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  domain               text not null,
  region               text not null check (region in ('kuwait','gulf','mena','world')),
  source_type          text not null check (source_type in ('official','research','medical_institution','media','reference')),
  tier                 text not null default '3' check (tier in ('1','2','3','blocked')),
  trust_score          int  not null default 50 check (trust_score between 0 and 100),
  discovery_enabled    boolean not null default true,
  final_source_allowed boolean not null default true,
  active               boolean not null default true,
  feed_url             text,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Always store the normalized registered host, so matching is case-insensitive
-- and www-insensitive regardless of what the admin typed.
create or replace function public.news_sources_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.domain := public.normalize_host(new.domain);
  if new.domain is null then
    raise exception 'news_sources.domain must be a valid host';
  end if;
  return new;
end;
$$;

drop trigger if exists news_sources_normalize on public.news_sources;
create trigger news_sources_normalize
  before insert or update on public.news_sources
  for each row execute function public.news_sources_normalize();

drop trigger if exists news_sources_set_updated_at on public.news_sources;
create trigger news_sources_set_updated_at
  before update on public.news_sources
  for each row execute function public.set_updated_at();

create unique index if not exists news_sources_domain_uniq on public.news_sources (domain);
create index if not exists news_sources_lookup on public.news_sources (active, tier, region);

-- Trigger-only function: not callable via REST RPC (mirrors existing hardening).
revoke execute on function public.news_sources_normalize() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ingestion_decisions: one row per evaluated candidate, for auditing why an
-- item was accepted or rejected (source ranking + editorial/PR scoring).
-- ---------------------------------------------------------------------------
create table if not exists public.ingestion_decisions (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid references public.ingestion_runs(id) on delete cascade,
  created_at             timestamptz not null default now(),
  title                  text,
  source_domain          text,
  source_url             text,
  source_tier            text,
  source_trust_score     int,
  editorial_value_score  int,
  institutional_pr_score int,
  accepted               boolean not null default false,
  rejection_reason       text,
  model                  text,
  prompt_version         text
);

create index if not exists ingestion_decisions_run on public.ingestion_decisions (run_id);
create index if not exists ingestion_decisions_domain on public.ingestion_decisions (source_domain);

-- ---------------------------------------------------------------------------
-- RLS. The edge function writes via the service role, which bypasses RLS.
--   - news_sources: full admin CRUD (editable registry).
--   - ingestion_decisions: IMMUTABLE audit log — admins get SELECT only; no
--     admin/anon insert/update/delete. Only the service role can write.
-- ---------------------------------------------------------------------------
alter table public.news_sources enable row level security;
alter table public.ingestion_decisions enable row level security;

drop policy if exists news_sources_admin_all on public.news_sources;
create policy news_sources_admin_all on public.news_sources
  for all using (public.is_admin()) with check (public.is_admin());

-- Read-only for admins; drop the older all-access policy if a prior version of
-- this migration created it. No insert/update/delete policies exist, so those
-- commands are denied for every RLS-bound role (service role bypasses RLS).
drop policy if exists ingestion_decisions_admin_all on public.ingestion_decisions;
drop policy if exists ingestion_decisions_admin_select on public.ingestion_decisions;
create policy ingestion_decisions_admin_select on public.ingestion_decisions
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Seed: initial editable registry. Tier 1 = primary/authoritative,
-- Tier 2 = strong discovery/context. Domains are normalized by the trigger.
-- Idempotent: existing domains are left untouched.
-- ---------------------------------------------------------------------------
insert into public.news_sources
  (name, domain, region, source_type, tier, trust_score, final_source_allowed)
values
  -- Tier 1 — Kuwait (primary / authoritative)
  ('Kuwait Ministry of Health',                 'moh.gov.kw',        'kuwait', 'official',            '1', 95, true),
  ('Kuwait News Agency (KUNA)',                 'kuna.net.kw',       'kuwait', 'media',               '1', 85, true),
  ('Kuwait University',                          'ku.edu.kw',         'kuwait', 'research',            '1', 90, true),
  ('Dasman Diabetes Institute',                  'dasmaninstitute.org','kuwait','medical_institution', '1', 90, true),
  ('Kuwait Foundation for the Advancement of Sciences', 'kfas.org',  'kuwait', 'research',            '1', 88, true),
  -- Tier 1 — GCC (primary / authoritative)
  ('Gulf Health Council',                        'ghc.sa',            'gulf',   'official',            '1', 92, true),
  ('Saudi Ministry of Health',                   'moh.gov.sa',        'gulf',   'official',            '1', 93, true),
  ('Saudi Food & Drug Authority',                'sfda.gov.sa',       'gulf',   'official',            '1', 93, true),
  ('UAE Ministry of Health & Prevention',        'mohap.gov.ae',      'gulf',   'official',            '1', 92, true),
  ('Abu Dhabi Department of Health',             'doh.gov.ae',        'gulf',   'official',            '1', 92, true),
  ('Dubai Health Authority',                     'dha.gov.ae',        'gulf',   'official',            '1', 92, true),
  ('Emirates Health Services',                   'ehs.gov.ae',        'gulf',   'official',            '1', 90, true),
  ('Hamad Medical Corporation',                  'hamad.qa',          'gulf',   'medical_institution', '1', 91, true),
  ('Sidra Medicine',                             'sidra.org',         'gulf',   'medical_institution', '1', 90, true),
  ('Oman Ministry of Health',                    'moh.gov.om',        'gulf',   'official',            '1', 91, true),
  ('Bahrain Ministry of Health',                 'moh.gov.bh',        'gulf',   'official',            '1', 91, true),
  -- Tier 1 — Global official & research
  ('World Health Organization',                  'who.int',           'world',  'official',            '1', 96, true),
  ('WHO Eastern Mediterranean (EMRO)',           'emro.who.int',      'mena',   'official',            '1', 95, true),
  ('U.S. Food & Drug Administration',            'fda.gov',           'world',  'official',            '1', 95, true),
  ('U.S. National Institutes of Health',         'nih.gov',           'world',  'research',            '1', 95, true),
  ('U.S. Centers for Disease Control',           'cdc.gov',           'world',  'official',            '1', 95, true),
  ('European Medicines Agency',                  'ema.europa.eu',     'world',  'official',            '1', 94, true),
  ('New England Journal of Medicine',            'nejm.org',          'world',  'research',            '1', 96, true),
  ('The Lancet',                                 'thelancet.com',     'world',  'research',            '1', 96, true),
  ('JAMA Network',                               'jamanetwork.com',   'world',  'research',            '1', 95, true),
  ('The BMJ',                                    'bmj.com',           'world',  'research',            '1', 94, true),
  ('Nature',                                     'nature.com',        'world',  'research',            '1', 93, true),
  -- Tier 2 — strong discovery & context
  ('Reuters',                                    'reuters.com',       'world',  'media',               '2', 80, true),
  ('BBC',                                        'bbc.com',           'world',  'media',               '2', 78, true),
  ('STAT News',                                  'statnews.com',      'world',  'media',               '2', 78, true),
  ('MobiHealthNews',                             'mobihealthnews.com','world',  'media',               '2', 72, true),
  ('Fierce Healthcare',                          'fiercehealthcare.com','world','media',               '2', 72, true),
  ('Euronews',                                   'euronews.com',      'world',  'media',               '2', 70, true)
on conflict (domain) do nothing;
