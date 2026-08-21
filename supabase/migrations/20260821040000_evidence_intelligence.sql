-- Evidence Intelligence V1 — per-cluster evidence analysis sidecar.
--
-- One row per canonical ESL cluster: the structured Evidence Card produced by
-- the ONE bounded analysis of the strongest editorial source (post Primary
-- Source Escalation), plus its audit metadata. Written only by the edge
-- function (service role); admins read it in the Content editor and the
-- feedback overview. It never feeds back into ESL ranking/scoring, never
-- publishes anything, and its absence/failure never blocks editorial review.

create table if not exists public.radar_evidence_intelligence (
  id                  uuid primary key default gen_random_uuid(),
  cluster_key         text not null unique,      -- canonical ESL cluster (cache key)
  content_id          uuid references public.content(id) on delete set null,
  story_type          text,
  analyzed_url        text,                      -- the exact source the card describes
  analyzed_domain     text,
  analysis_status     text not null check (analysis_status in
                        ('complete','not_applicable','insufficient_source','analysis_failed')),
  -- Denormalized card facets for metadata queries (feedback overview etc.).
  applicability       text check (applicability in ('applicable','partial','not_applicable')),
  evidence_type       text,
  peer_review_status  text,
  subject_type        text,
  claim_relationship  text,
  evidence_strength   text check (evidence_strength in
                        ('high','moderate','limited','very_limited','unclear')),
  source_independence text,
  sample_size         integer,
  card                jsonb,                     -- the full validated Evidence Card
  reason              text,                      -- compact gate/failure reason
  model               text,
  prompt_version      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists radar_evidence_intelligence_content_idx
  on public.radar_evidence_intelligence (content_id)
  where content_id is not null;

-- Admins read; only the service role writes (same posture as the other sidecars).
alter table public.radar_evidence_intelligence enable row level security;
drop policy if exists radar_evidence_intelligence_admin_select on public.radar_evidence_intelligence;
create policy radar_evidence_intelligence_admin_select on public.radar_evidence_intelligence
  for select using (public.is_admin());

-- Feedback overview: expose the evidence metadata (READ-ONLY observational
-- linkage — so future analysis can ask e.g. "are limited-evidence stories
-- rejected more often?"). Same view with the evidence columns appended.
create or replace view public.editorial_feedback_overview
with (security_invoker = true) as
select
  c.id                                   as content_id,
  c.title,
  c.status,
  c.category_slug,
  c.created_at,
  c.published_at,
  (sel.id is not null)                   as esl_selected,
  coalesce(sel.lane, rr.esl_lane)        as lane,
  coalesce(sel.story_type, rr.esl_story_type)         as story_type,
  coalesce(sel.evidence_class, rr.esl_evidence_class) as evidence_class,
  coalesce(sel.gcc, rr.esl_gcc)          as gcc,
  sel.source_tier,
  sel.source_role,
  sel.chosen_source_domain,
  sel.composite_score,
  sel.selection_reason,
  coalesce(sel.cluster_key, rr.esl_canonical_key)     as cluster_key,
  coalesce(sel.esc_status, esc.status)   as esc_status,
  coalesce(sel.esc_method, esc.method)   as esc_method,
  coalesce(sel.esc_editorial_tier, esc.editorial_tier) as esc_editorial_tier,
  esc.discovery_tier                     as esc_discovery_tier,
  coalesce(rsa.esl_usefulness, rr.esl_usefulness)     as usefulness,
  (bl.content_id is not null)            as was_edited,
  te.edit_ratio                          as title_edit_ratio,
  te.edit_magnitude                      as title_edit_magnitude,
  te.before_value                        as ai_title,
  te.after_value                         as final_title,
  be.edit_ratio                          as body_edit_ratio,
  be.edit_magnitude                      as body_edit_magnitude,
  rj.reason                              as reject_reason,
  (cc.id is not null)                    as category_corrected,
  cc.before_value                        as category_before,
  cc.after_value                         as category_after,
  (sc.id is not null)                    as source_changed,
  sc.before_value                        as source_before,
  sc.after_value                         as source_after,
  (ic.id is not null)                    as image_changed,
  -- Evidence Intelligence metadata (appended columns; observational only)
  ei.analysis_status                     as ei_status,
  ei.evidence_type                       as ei_evidence_type,
  ei.evidence_strength                   as ei_strength,
  ei.claim_relationship                  as ei_claim_relationship,
  ei.peer_review_status                  as ei_peer_review,
  ei.subject_type                        as ei_subject_type,
  ei.source_independence                 as ei_source_independence
from public.content c
left join lateral (
  select * from public.radar_editorial_selection s
  where s.promoted_content_id = c.id
  order by s.created_at desc limit 1
) sel on true
left join public.radar_shadow_articles rsa on rsa.id = sel.radar_article_id
left join lateral (
  select * from public.radar_shadow_articles r
  where r.published_content_id = c.id limit 1
) rr on true
left join public.radar_source_escalation esc
  on esc.cluster_key = coalesce(sel.cluster_key, rr.esl_canonical_key)
left join public.radar_evidence_intelligence ei
  on ei.content_id = c.id
  or (ei.content_id is null
      and ei.cluster_key = coalesce(sel.cluster_key, rr.esl_canonical_key))
left join public.editorial_ai_baseline bl on bl.content_id = c.id
left join lateral (
  select * from public.editorial_feedback_events e
  where e.content_id = c.id and e.action = 'title_edit'
  order by e.created_at desc limit 1
) te on true
left join lateral (
  select * from public.editorial_feedback_events e
  where e.content_id = c.id and e.action = 'body_edit'
  order by e.created_at desc limit 1
) be on true
left join lateral (
  select * from public.editorial_feedback_events e
  where e.content_id = c.id and e.action = 'reject'
  order by e.created_at desc limit 1
) rj on true
left join lateral (
  select * from public.editorial_feedback_events e
  where e.content_id = c.id and e.action = 'category_change'
  order by e.created_at desc limit 1
) cc on true
left join lateral (
  select * from public.editorial_feedback_events e
  where e.content_id = c.id and e.action = 'source_change'
  order by e.created_at desc limit 1
) sc on true
left join lateral (
  select * from public.editorial_feedback_events e
  where e.content_id = c.id and e.action = 'image_change'
  order by e.created_at desc limit 1
) ic on true
where c.origin = 'ai' and c.deleted_at is null;
