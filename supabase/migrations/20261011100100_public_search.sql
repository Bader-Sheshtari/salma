-- ============================================================================
-- PUBLIC SEARCH + RELATED ARTICLES — V1
--
-- Reader-facing search and related-article recommendations move from
-- "fetch every published row and score it in JS" to database-driven,
-- relevance-ranked, paginated queries that REUSE the existing Arabic search
-- infrastructure from CMS Phase 2 (20261007100100_content_search.sql):
--   - ar_normalize()                 (the single Arabic normalizer)
--   - content.search_norm            (title+original_title+excerpt, trgm GIN)
--   - content.body_tsv               ('simple' tsvector of the body, GIN)
-- No second search engine, no new normalization, no AI.
--
-- Visibility is enforced at the DATABASE layer twice:
--   1. Explicit WHERE status = 'published' AND deleted_at IS NULL.
--   2. SECURITY INVOKER — an anon caller is additionally bound by the
--      content_public_read RLS policy (published + not deleted only), so even
--      a future bug in the WHERE clause cannot leak drafts/pending/trash.
-- Neither function ever returns admin metadata or body text.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. search_public_content — relevance-ranked public search, paginated.
--
-- Matching (all index-assisted):
--   a. substring on search_norm      (trgm GIN supports LIKE '%…%')
--   b. body full-text                (body_tsv @@ plainto_tsquery('simple'))
--   c. careful fuzzy                 (v_q <% search_norm — pg_trgm
--      word_similarity at its conservative default threshold 0.6)
--
-- Ranking (exact/strong always above fuzzy-only):
--   +4.0  normalized TITLE contains the query
--   +1.5  search_norm (title/original title/excerpt) contains the query
--   +≤1.5 body ts_rank (capped)
--   +≤1.0 fuzzy word-similarity above 0.5 (a fuzzy-only hit can never reach
--         the score of any exact hit)
--   ties → newest first.
--
-- total_count (window) lets the page show an honest result count and compute
-- pagination without a second query. Offset pagination is deliberate: the
-- relevance order has no stable keyset, page sizes are small, and the offset
-- is clamped (≤ 480) so deep scans are impossible.
-- ----------------------------------------------------------------------------
create or replace function public.search_public_content(
  p_q      text,
  p_limit  integer default 20,
  p_offset integer default 0
)
returns table (
  id               uuid,
  type             text,
  title            text,
  slug             text,
  excerpt          text,
  ai_summary       text,
  category_slug    text,
  category_name_ar text,
  cover_image_url  text,
  video_url        text,
  source_name      text,
  published_at     timestamptz,
  read_minutes     integer,
  rank             real,
  total_count      bigint
)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_q      text    := nullif(public.ar_normalize(p_q), '');
  v_limit  integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 480);
  v_tsq    tsquery;
begin
  if v_q is null or pg_catalog.length(v_q) < 2 then
    return;
  end if;
  v_tsq := pg_catalog.plainto_tsquery('simple'::regconfig, v_q);

  return query
  select c.id, c.type, c.title, c.slug, c.excerpt, c.ai_summary,
         c.category_slug, cat.name_ar,
         c.cover_image_url, c.video_url, c.source_name, c.published_at,
         c.read_minutes,
         (
           (case when pg_catalog.strpos(public.ar_normalize(c.title), v_q) > 0 then 4.0 else 0 end)
           + (case when c.search_norm like ('%' || v_q || '%') then 1.5 else 0 end)
           + least(pg_catalog.ts_rank(c.body_tsv, v_tsq) * 4.0, 1.5)
           + greatest(word_similarity(v_q, c.search_norm) - 0.5, 0) * 2.0
         )::real as rank,
         pg_catalog.count(*) over () as total_count
    from public.content c
    left join public.categories cat on cat.slug = c.category_slug
   where c.status = 'published'
     and c.deleted_at is null
     and (
       c.search_norm like ('%' || v_q || '%')
       or c.body_tsv @@ v_tsq
       or v_q <% c.search_norm
     )
   order by rank desc, c.published_at desc nulls last, c.id
   limit v_limit offset v_offset;
end;
$$;

comment on function public.search_public_content(text, integer, integer) is
  'Public site search: relevance-ranked, paginated, published-only (WHERE + anon RLS). Reuses ar_normalize/search_norm/body_tsv. Never returns body or admin metadata.';

revoke all on function public.search_public_content(text, integer, integer) from public;
grant execute on function public.search_public_content(text, integer, integer)
  to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. related_public_content — relevance-based related articles.
--
-- Candidates (bounded, index-assisted — never "rank the whole table"):
--   same category, OR body matches any significant word of the source title
--   (OR-tsquery over body_tsv).
-- Relevance = trgm similarity between the two search_norm strings (title/
-- excerpt overlap) + capped body ts_rank against the source-title words.
-- A row must clear a RELEVANCE floor on its own — the same-category boost
-- only orders qualified rows, it can never qualify an unrelated item. Fewer
-- strong matches than p_limit → fewer rows (no filler); zero → empty (the
-- app falls back to the old recent-in-category list so the section renders).
-- ----------------------------------------------------------------------------
create or replace function public.related_public_content(
  p_id    uuid,
  p_limit integer default 4
)
returns table (
  id              uuid,
  type            text,
  title           text,
  slug            text,
  excerpt         text,
  category_slug   text,
  cover_image_url text,
  video_url       text,
  video_duration  text,
  read_minutes    integer,
  published_at    timestamptz,
  is_breaking     boolean,
  relevance       real
)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_limit   integer := least(greatest(coalesce(p_limit, 4), 1), 12);
  s_norm    text;
  s_cat     text;
  s_titleq  text;
  v_tsq     tsquery;
begin
  select c.search_norm, c.category_slug, public.ar_normalize(c.title)
    into s_norm, s_cat, s_titleq
    from public.content c
   where c.id = p_id and c.status = 'published' and c.deleted_at is null;
  if s_norm is null then
    return; -- unknown or non-public source article → nothing
  end if;

  -- OR-tsquery over the source title's significant words (≥ 3 chars, ≤ 8 words).
  select pg_catalog.string_agg(w, ' | ')
    into s_titleq
    from (
      select distinct w
        from pg_catalog.regexp_split_to_table(s_titleq, '\s+') as w
       where pg_catalog.length(w) >= 3
       limit 8
    ) t;
  v_tsq := case when s_titleq is null or s_titleq = '' then null
                else pg_catalog.to_tsquery('simple'::regconfig, s_titleq) end;

  return query
  with scored as (
    select c.id, c.type, c.title, c.slug, c.excerpt, c.category_slug,
           c.cover_image_url, c.video_url, c.video_duration, c.read_minutes,
           c.published_at, c.is_breaking,
           (
             similarity(c.search_norm, s_norm) * 3.0
             + case when v_tsq is null then 0
                    else least(pg_catalog.ts_rank(c.body_tsv, v_tsq) * 2.0, 0.6) end
           )::real as rel,
           (c.category_slug is not distinct from s_cat and s_cat is not null) as same_cat
      from public.content c
     where c.status = 'published'
       and c.deleted_at is null
       and c.id <> p_id
       and (
         (s_cat is not null and c.category_slug = s_cat)
         or (v_tsq is not null and c.body_tsv @@ v_tsq)
       )
  )
  select sc.id, sc.type, sc.title, sc.slug, sc.excerpt, sc.category_slug,
         sc.cover_image_url, sc.video_url, sc.video_duration, sc.read_minutes,
         sc.published_at, sc.is_breaking,
         sc.rel as relevance
    from scored sc
   where sc.rel >= 0.30 -- relevance floor: category alone never qualifies
   order by (sc.rel + case when sc.same_cat then 0.3 else 0 end) desc,
            sc.published_at desc nulls last, sc.id
   limit v_limit;
end;
$$;

comment on function public.related_public_content(uuid, integer) is
  'Public related articles: trgm/full-text relevance with a qualification floor (category only boosts order). Published-only (WHERE + anon RLS); no filler rows.';

revoke all on function public.related_public_content(uuid, integer) from public;
grant execute on function public.related_public_content(uuid, integer)
  to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Search analytics foundation — privacy-respecting, minimal.
--    One row per executed public search: the NORMALIZED query, the result
--    count and a timestamp. No IPs, no user agents, no identifiers, no
--    sessions. Written only by the server (service role); admins may read.
-- ----------------------------------------------------------------------------
create table if not exists public.search_queries (
  id           bigint generated always as identity primary key,
  query_norm   text not null,
  result_count integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists search_queries_created_idx
  on public.search_queries (created_at desc);

alter table public.search_queries enable row level security;

drop policy if exists "admins can read search queries" on public.search_queries;
create policy "admins can read search queries"
  on public.search_queries
  for select
  to authenticated
  using (public.is_admin());
-- No insert/update/delete policies: service-role writes only.
