-- Editorial Feedback Loop V1 — OBSERVATIONAL ONLY.
--
-- Captures real human editorial decisions (publish / reject / edits /
-- corrections) as an append-only event log plus a one-time "AI original"
-- baseline snapshot, and links them back to the ESL decision at READ time
-- through a view (radar_editorial_selection already snapshots lane /
-- story_type / tier / score / escalation — nothing is duplicated).
--
-- NOTHING here feeds back into Radar ranking, ESL scoring, lane weights,
-- source weights or the Writer. It is a measurement layer.
--
-- Also fixes two pre-existing issues found while wiring this up:
--  (1) content_status_check did not allow 'rejected', so the admin Reject
--      button silently failed (0 rejected rows in prod). Publishing rules are
--      untouched: publish still only happens from 'pending' via human action.
--  (2) radar_editorial_selection / radar_source_escalation had RLS DISABLED
--      (anon-writable through PostgREST). RLS is enabled with admin
--      read-only policies; edge functions write via service role (bypasses
--      RLS) so nothing operational changes.

-- (1) Allow the 'rejected' editorial outcome ---------------------------------
do $$ begin
  alter table public.content drop constraint if exists content_status_check;
  alter table public.content
    add constraint content_status_check
    check (status in ('draft','pending','published','rejected'));
end $$;

-- (2) Append-only editorial feedback event log -------------------------------
create table if not exists public.editorial_feedback_events (
  id             bigint generated always as identity primary key,
  content_id     uuid not null references public.content(id) on delete cascade,
  action         text not null check (action in
                   ('publish','unpublish','reject','title_edit','body_edit',
                    'category_change','source_change','image_change')),
  actor_id       uuid references public.profiles(id) on delete set null,
  origin         text,                -- content.origin snapshot ('ai' | 'manual')
  reason         text,                -- structured rejection reason code
  before_value   text,                -- compact: old title / old category / old source url / old status
  after_value    text,                -- compact: new value
  edit_ratio     real,                -- deterministic 0..1 difference ratio (title/body edits)
  edit_magnitude text check (edit_magnitude in ('none','minor','moderate','major')),
  meta           jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists editorial_feedback_events_content_idx
  on public.editorial_feedback_events (content_id);
create index if not exists editorial_feedback_events_action_idx
  on public.editorial_feedback_events (action, created_at desc);

-- Immutable audit log: admins may read; only the service role writes.
alter table public.editorial_feedback_events enable row level security;
drop policy if exists editorial_feedback_events_admin_select on public.editorial_feedback_events;
create policy editorial_feedback_events_admin_select on public.editorial_feedback_events
  for select using (public.is_admin());

-- (3) One-time AI-original baseline snapshot ---------------------------------
-- Captured LAZILY right before the FIRST human edit of an origin='ai' content
-- row: until a human edits it, the stored row IS the AI original (the pipeline
-- writes it once and never updates it afterwards). This covers every existing
-- pending AI article with no backfill and no fabricated history. Publish-time
-- title/body edit magnitude is measured against this snapshot; a missing
-- snapshot means the article was never edited (magnitude = none).
create table if not exists public.editorial_ai_baseline (
  content_id      uuid primary key references public.content(id) on delete cascade,
  title           text not null,
  body            text,
  category_slug   text,
  source_name     text,
  source_url      text,
  cover_image_url text,
  captured_at     timestamptz not null default now()
);

alter table public.editorial_ai_baseline enable row level security;
drop policy if exists editorial_ai_baseline_admin_select on public.editorial_ai_baseline;
create policy editorial_ai_baseline_admin_select on public.editorial_ai_baseline
  for select using (public.is_admin());

-- (4) Close the RLS gap on the ESL sidecars (read-only for admins) -----------
alter table public.radar_editorial_selection enable row level security;
drop policy if exists radar_editorial_selection_admin_select on public.radar_editorial_selection;
create policy radar_editorial_selection_admin_select on public.radar_editorial_selection
  for select using (public.is_admin());

alter table public.radar_source_escalation enable row level security;
drop policy if exists radar_source_escalation_admin_select on public.radar_source_escalation;
create policy radar_source_escalation_admin_select on public.radar_source_escalation
  for select using (public.is_admin());

-- Fast content → ESL decision lookups for the feedback view.
create index if not exists radar_editorial_selection_promoted_content_idx
  on public.radar_editorial_selection (promoted_content_id)
  where promoted_content_id is not null;
create index if not exists radar_shadow_articles_published_content_idx
  on public.radar_shadow_articles (published_content_id)
  where published_content_id is not null;

-- (5) Read-time linkage: one row per AI article with its editorial outcome ---
-- Joins content → ESL selection audit (promoted_content_id) with a fallback to
-- the radar row's own esl_* classification cache (published_content_id, i.e.
-- manual "تحرير في سلمى" promotions), plus the latest feedback event of each
-- kind. security_invoker: readers see only what their own RLS allows.
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
  (ic.id is not null)                    as image_changed
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
