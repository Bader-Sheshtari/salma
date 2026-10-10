-- ============================================================================
-- AFTER THE NEWS / DEVELOP STORY — V1
--
-- A human-triggered editorial workflow: existing article → research brief →
-- editor-confirmed direction → deeper AI draft that enters the NORMAL pending
-- review flow. Never auto-publishes; never overwrites the original article.
--
-- Two pieces:
--   1. content.developed_from_content_id — the original ↔ developed story
--      relationship (first content→content self-reference).
--   2. story_developments — the job + audit + editorial-output + cost record.
--      One row per development attempt. The row IS the develop-story audit
--      trail (started / brief ready / direction confirmed / draft created /
--      failed, each with its timestamp and the real authenticated editor);
--      the developed article additionally gets its normal 'created' event in
--      content_audit_log via the existing lifecycle trigger.
--
-- content_audit_log is intentionally untouched: its event CHECK, trigger-only
-- writes and immutability stay exactly as shipped.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Original ↔ developed relationship
-- ----------------------------------------------------------------------------
alter table public.content
  add column if not exists developed_from_content_id uuid
    references public.content(id) on delete set null;

create index if not exists content_developed_from_idx
  on public.content (developed_from_content_id)
  where developed_from_content_id is not null;

-- ----------------------------------------------------------------------------
-- 2. story_developments — job, audit, editorial outputs, observability
-- ----------------------------------------------------------------------------
create table if not exists public.story_developments (
  id uuid primary key default gen_random_uuid(),
  original_content_id uuid not null references public.content(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,

  -- Editorial intent. 'auto' = «دع سلمى تقترح الاتجاه الأنسب». The direction
  -- actually used for the draft may differ from the one requested at start
  -- (the editor can switch after reading the brief); both are kept.
  direction text not null check (direction in (
    'deeper_explainer', 'behind_the_news', 'evidence_analysis',
    'context_background', 'reader_impact', 'follow_up', 'auto'
  )),
  draft_direction text check (draft_direction in (
    'deeper_explainer', 'behind_the_news', 'evidence_analysis',
    'context_background', 'reader_impact', 'follow_up', 'auto'
  )),
  editor_note text,

  -- Job state machine. researching → brief_ready → drafting → draft_ready;
  -- failed may occur in either phase (a failed draft phase KEEPS the brief so
  -- retry does not repeat the research); cancelled is editor-initiated.
  status text not null default 'researching' check (status in (
    'researching', 'brief_ready', 'drafting', 'draft_ready', 'failed', 'cancelled'
  )),
  -- Fine-grained progress label for the UI (e.g. fetching_sources,
  -- escalating, analyzing_evidence, building_brief, writing, editing).
  phase text,
  -- Which phase a failure happened in, plus a safe category + message.
  error_category text,
  error_message text,

  -- Research outputs (phase 1).
  research_brief jsonb,
  brief_sources jsonb,
  evidence_cluster_key text,
  escalation jsonb,
  -- Verified grounding material assembled at research time ({corpus,
  -- must_preserve, source_name, source_url, profile}) so the draft phase —
  -- including a retry after a failure — grounds against EXACTLY what the
  -- brief was built from, with no refetch drift.
  draft_inputs jsonb,
  research_model text,
  research_prompt_version text,
  research_duration_ms integer,
  research_completed_at timestamptz,

  -- Draft outputs (phase 2).
  result_content_id uuid references public.content(id) on delete set null,
  writing_profile text,
  writer_model text,
  writer_prompt_version text,
  editor_model text,
  editor_prompt_version text,
  -- Persisted editorial outputs (the backlog finding: these were previously
  -- computed and discarded on the ingest path — Develop Story keeps them).
  editor_verdict text,
  editorial_audit jsonb,
  fidelity_audit jsonb,
  validation_warnings jsonb,
  needs_human_review boolean,
  draft_duration_ms integer,
  draft_completed_at timestamptz,

  -- AI cost observability (summed across every call of both phases).
  openrouter_calls integer not null default 0,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  cost numeric not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists story_developments_original_idx
  on public.story_developments (original_content_id, created_at desc);
create index if not exists story_developments_result_idx
  on public.story_developments (result_content_id)
  where result_content_id is not null;

-- Accidental-duplicate guard: at most ONE in-flight development per original
-- article (researching / brief_ready / drafting). Intentionally developing the
-- same article again — any direction — stays possible once the active job
-- finishes, fails, or is cancelled.
create unique index if not exists story_developments_active_uniq
  on public.story_developments (original_content_id)
  where status in ('researching', 'brief_ready', 'drafting');

drop trigger if exists story_developments_set_updated_at on public.story_developments;
create trigger story_developments_set_updated_at
  before update on public.story_developments
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. RLS — staff read (the workflow is a content-authority feature, editors
--    included); ALL writes go through the develop-story edge function with the
--    service role after its own staff check. No client write policies.
-- ----------------------------------------------------------------------------
alter table public.story_developments enable row level security;

drop policy if exists "staff can read story developments" on public.story_developments;
create policy "staff can read story developments"
  on public.story_developments
  for select
  to authenticated
  using (public.is_staff());
