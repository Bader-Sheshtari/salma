-- Editorial Selection Layer (ESL) V1 — schema.
--
-- Two responsibilities, kept separate:
--  (1) A small classification CACHE on radar_shadow_articles (lane / story_type /
--      evidence_class / usefulness). Produced by the ESL (bounded, once per row)
--      so re-runs are free and the selection math stays deterministic. These are
--      intrinsic editorial attributes of the article, hence stored on the row.
--  (2) A dedicated audit SIDECAR (radar_editorial_selection) that records every
--      selection/skip decision so we can later answer "why was this chosen?" and
--      "why was that one skipped?" without bloating radar_shadow_articles.

-- (1) Classification cache -------------------------------------------------
alter table public.radar_shadow_articles
  add column if not exists esl_lane text,             -- L1..L5
  add column if not exists esl_story_type text,       -- regulatory_decision | scientific_study | public_health | corporate_business | product_claim | guidance_explainer | general
  add column if not exists esl_evidence_class text,   -- research | guidance | none  (relevant for L5 gating)
  add column if not exists esl_gcc boolean,           -- cross-cutting Kuwait/GCC relevance
  add column if not exists esl_usefulness int,        -- 0..100 reader-usefulness signal
  add column if not exists esl_classified_at timestamptz;

-- (2) Selection/audit sidecar ---------------------------------------------
create table if not exists public.radar_editorial_selection (
  id                bigint generated always as identity primary key,
  editorial_day     date not null,
  run_id            text not null,               -- ESL run identifier (timestamp-based)
  mode              text not null default 'live', -- 'shadow' | 'live'
  cluster_key       text not null,               -- event_uri or derived title key
  radar_article_id  uuid not null,               -- chosen representative row
  lane              text,
  lane_confidence   real,
  story_type        text,
  evidence_class    text,
  gcc               boolean,
  source_tier       int,                         -- 1 (strongest) .. 5 (weakest)
  source_role       text,                        -- regulator | journal | wire | company | institution | general
  chosen_source_domain text,
  chosen_source_title  text,
  composite_score   real,
  selected          boolean not null default false,
  selection_reason  text,                        -- concise, why selected
  skip_reason       text,                        -- e.g. already_covered | lane_full | duplicate_cluster | low_score | evidence_failed | cap_reached
  promotion_status  text,                        -- null | pending | promoted | failed
  promoted_content_id uuid,
  created_at        timestamptz not null default now()
);

create index if not exists radar_editorial_selection_day_idx
  on public.radar_editorial_selection (editorial_day desc);
create index if not exists radar_editorial_selection_cluster_idx
  on public.radar_editorial_selection (cluster_key);
create index if not exists radar_editorial_selection_article_idx
  on public.radar_editorial_selection (radar_article_id);
-- Fast "how many promoted / selected today (live only)" lookups.
create index if not exists radar_editorial_selection_day_selected_idx
  on public.radar_editorial_selection (editorial_day, mode, selected);
