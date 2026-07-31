-- Editorial policy (single-row, admin-editable) for the news-ingestion agent
create table if not exists public.editorial_policy (
  id uuid primary key default gen_random_uuid(),
  block_topics text[] not null default '{}',
  priority_topics text[] not null default '{}',
  trusted_sources text[] not null default '{}',
  regions text[] not null default '{kuwait,gulf,mena,world}',
  updated_at timestamptz not null default now()
);

-- Seed one default policy row reflecting agreed product requirements
insert into public.editorial_policy (block_topics, priority_topics, trusted_sources, regions)
select
  array[
    'sexual or explicit content',
    'illicit or recreational drugs',
    'positive portrayal of drug use',
    'gambling',
    'alcohol promotion',
    'politically inflammatory content'
  ],
  array[
    'new medications and drug approvals',
    'vitamins and supplements',
    'longevity and healthy aging',
    'menopause and perimenopause',
    'preventive health and screening',
    'nutrition and wellness',
    'mental health',
    'chronic disease management'
  ],
  array[
    'World Health Organization (who.int)',
    'CDC (cdc.gov)',
    'Reuters Health',
    'BBC Health',
    'Mayo Clinic',
    'The Lancet',
    'Nature',
    'NEJM',
    'Kuwait Ministry of Health (moh.gov.kw)',
    'KUNA (kuna.net.kw)',
    'Al Jazeera'
  ],
  array['kuwait','gulf','mena','world']
where not exists (select 1 from public.editorial_policy);

-- Extra columns on content for the agent (real-source provenance + scoring + dedupe)
alter table public.content add column if not exists relevance_score int;
alter table public.content add column if not exists original_title text;
alter table public.content add column if not exists original_url text;
alter table public.content add column if not exists source_lang text;
alter table public.content add column if not exists dedupe_key text;

-- Skip re-ingesting the same story: unique only when dedupe_key is set
create unique index if not exists content_dedupe_key_uniq
  on public.content (dedupe_key)
  where dedupe_key is not null;

-- Log of each ingestion run (manual or cron)
create table if not exists public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  trigger text not null default 'manual',
  status text not null default 'success',
  found int not null default 0,
  kept int not null default 0,
  filtered int not null default 0,
  duplicates int not null default 0,
  error text
);

-- RLS: both tables are admin-only (no public access)
alter table public.editorial_policy enable row level security;
alter table public.ingestion_runs enable row level security;

drop policy if exists editorial_policy_admin_all on public.editorial_policy;
create policy editorial_policy_admin_all on public.editorial_policy
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists ingestion_runs_admin_all on public.ingestion_runs;
create policy ingestion_runs_admin_all on public.ingestion_runs
  for all using (public.is_admin()) with check (public.is_admin());