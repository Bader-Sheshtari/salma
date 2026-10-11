-- ============================================================================
-- DEVELOP STORY V2 — AUTHORITATIVE SOURCES + STORY EVOLUTION (schema)
--
-- One ADDITIVE migration for all four V2 stages. Nothing destructive:
-- every V1 job, developed story and relationship is preserved; V1 briefs
-- (research_prompt_version 'ds1') keep rendering unchanged.
--
-- Deliberately NOT here (owner adjustment #1): no rows or columns in
-- news_sources. Active news_sources rows feed Radar discovery, ESL and the
-- escalation registry, so the Authoritative Source Network's classification
-- lives in CODE (develop-story/sourceNetwork.ts) — zero Radar impact.
--
-- Pieces:
--   development_evidence   — per-job evidence items with full provenance
--                            (URL/publisher/date/class/tier/DOI/PMID/NCT,
--                            fetch status). The brief may cite ONLY these.
--   external_lookup_cache  — PubMed / ClinicalTrials / openFDA lookup cache
--                            (TTL enforced at read time by the function).
--   story_threads(+members)— minimal story-evolution relationship model.
--   story_developments     — cluster-mode + adaptive depth + thread link;
--                            original_content_id becomes nullable with an
--                            XOR check (article-mode vs cluster-mode).
--   find_prior_coverage()  — archive retrieval for story evolution, reusing
--                            the existing ar_normalize/trgm/tsv infra.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. development_evidence
-- ----------------------------------------------------------------------------
create table if not exists public.development_evidence (
  id             bigint generated always as identity primary key,
  development_id uuid not null references public.story_developments(id) on delete cascade,
  kind           text not null check (kind in ('web', 'pubmed', 'trial', 'regulator', 'salma_archive')),
  url            text,
  title          text,
  publisher      text,
  published_date date,
  source_class   text,            -- ASN class (code-defined vocabulary)
  tier           integer,         -- 1 strongest .. 5 weakest
  is_primary     boolean not null default false,
  doi            text,
  pmid           text,
  nct_id         text,
  fetched        boolean not null default false,
  fetch_status   text,            -- ok | blocked | timeout | not_attempted | ...
  excerpt        text,            -- bounded extract actually shown/used
  confidence     text,            -- high | medium | low (human-readable tiering)
  meta           jsonb,           -- structured extras (trial fields, pub types…)
  created_at     timestamptz not null default now()
);

create index if not exists development_evidence_dev_idx
  on public.development_evidence (development_id, id);

alter table public.development_evidence enable row level security;
drop policy if exists "staff read development evidence" on public.development_evidence;
create policy "staff read development evidence"
  on public.development_evidence for select to authenticated using (public.is_staff());
-- writes: service role only (the develop-story function).

-- ----------------------------------------------------------------------------
-- 2. external_lookup_cache
-- ----------------------------------------------------------------------------
create table if not exists public.external_lookup_cache (
  provider   text not null,       -- pubmed | ctgov | openfda
  query_hash text not null,       -- sha256 of the normalized query
  payload    jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (provider, query_hash)
);

alter table public.external_lookup_cache enable row level security;
-- no policies: service role only.

-- ----------------------------------------------------------------------------
-- 3. Story threads (evolution relationship model)
-- ----------------------------------------------------------------------------
create table if not exists public.story_threads (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.story_thread_members (
  thread_id  uuid not null references public.story_threads(id) on delete cascade,
  content_id uuid not null references public.content(id) on delete cascade,
  role       text not null check (role in ('original', 'developed', 'update', 'prior_coverage')),
  created_at timestamptz not null default now(),
  primary key (thread_id, content_id)
);

create index if not exists story_thread_members_content_idx
  on public.story_thread_members (content_id);

alter table public.story_threads enable row level security;
alter table public.story_thread_members enable row level security;
drop policy if exists "staff read story threads" on public.story_threads;
create policy "staff read story threads"
  on public.story_threads for select to authenticated using (public.is_staff());
drop policy if exists "staff read story thread members" on public.story_thread_members;
create policy "staff read story thread members"
  on public.story_thread_members for select to authenticated using (public.is_staff());

-- ----------------------------------------------------------------------------
-- 4. story_developments — cluster mode, adaptive depth, thread link
-- ----------------------------------------------------------------------------
alter table public.story_developments
  add column if not exists cluster_key    text,
  add column if not exists research_depth text not null default 'standard'
    check (research_depth in ('standard', 'deep')),
  add column if not exists thread_id      uuid references public.story_threads(id) on delete set null;

-- Cluster-mode jobs have no original article: exactly one of
-- (original_content_id, cluster_key) must be set. Every existing V1 row has
-- original_content_id, so the new CHECK is satisfied retroactively.
alter table public.story_developments
  alter column original_content_id drop not null;
do $$ begin
  alter table public.story_developments
    add constraint story_developments_origin_xor
    check (
      (original_content_id is not null and cluster_key is null)
      or (original_content_id is null and cluster_key is not null)
    );
exception when duplicate_object then null; end $$;

-- The V1 one-active-job index was per original article; cluster jobs need the
-- same guard per cluster.
create unique index if not exists story_developments_active_cluster_uniq
  on public.story_developments (cluster_key)
  where cluster_key is not null and status in ('researching', 'brief_ready', 'drafting');

-- ----------------------------------------------------------------------------
-- 5. find_prior_coverage — Salma-archive retrieval for story evolution.
--    SECURITY DEFINER with an explicit guard (service role or staff): the
--    develop-story function calls it with the service key; the admin UI may
--    reuse it later. Published-only by construction. Reuses search_norm
--    (trgm) + body_tsv exactly like related_public_content.
-- ----------------------------------------------------------------------------
create or replace function public.find_prior_coverage(
  p_text    text,
  p_exclude uuid default null,
  p_limit   integer default 6
)
returns table (
  id            uuid,
  title         text,
  slug          text,
  excerpt       text,
  category_slug text,
  original_url  text,
  published_at  timestamptz,
  relevance     real
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 6), 1), 12);
  v_norm   text    := nullif(public.ar_normalize(p_text), '');
  v_wordsq text;
  v_tsq    tsquery;
begin
  if not (coalesce(public.is_staff(), false) or current_setting('request.jwt.claims', true) is null
          or coalesce(current_setting('request.jwt.claims', true), '') = ''
          or (current_setting('request.jwt.claims', true))::jsonb ->> 'role' = 'service_role') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_norm is null then
    return;
  end if;

  select pg_catalog.string_agg(w, ' | ')
    into v_wordsq
    from (
      select distinct w
        from pg_catalog.regexp_split_to_table(v_norm, '\s+') as w
       where pg_catalog.length(w) >= 3
       limit 10
    ) t;
  v_tsq := case when v_wordsq is null or v_wordsq = '' then null
                else pg_catalog.to_tsquery('simple'::regconfig, v_wordsq) end;

  return query
  select c.id, c.title, c.slug, c.excerpt, c.category_slug, c.original_url,
         c.published_at,
         (
           similarity(c.search_norm, v_norm) * 3.0
           + case when v_tsq is null then 0
                  else least(pg_catalog.ts_rank(c.body_tsv, v_tsq) * 2.0, 0.8) end
         )::real as relevance
    from public.content c
   where c.status = 'published'
     and c.deleted_at is null
     and (p_exclude is null or c.id <> p_exclude)
     and (
       c.search_norm % v_norm
       or (v_tsq is not null and c.body_tsv @@ v_tsq)
     )
   order by relevance desc, c.published_at desc nulls last
   limit v_limit;
end;
$$;

revoke all on function public.find_prior_coverage(text, uuid, integer) from public, anon;
grant execute on function public.find_prior_coverage(text, uuid, integer)
  to authenticated, service_role;
