-- ============================================================================
-- NEWSLETTER CURATION ENGINE V1 (brief 2026-10-12).
--
-- Editor-ready newsletter ISSUES curated inside Admin. The newsletter is an
-- editorial product of its own: issues mix published Salma articles, verified
-- EXTERNAL newsletter-only items (snapshotted — radar rows are retained only
-- 48h, so external candidates copy their source facts into the item row and
-- never reference radar_shadow_articles), and doctor transfers.
--
-- Deliberately NOT here (brief §35): sending, SMTP, campaigns, tracking,
-- unsubscribe delivery — the issue schema is delivery-READY (§33), nothing
-- more. Subscriber/survey tables are untouched.
-- ============================================================================

-- --- Issues -----------------------------------------------------------------

create table if not exists public.newsletter_issues (
  id uuid primary key default gen_random_uuid(),
  title text,                                  -- editor-ready issue title (editable)
  intro_ar text,                               -- optional opening (§24)
  status text not null default 'draft'
    check (status in ('draft','curated','ready','archived')),
  range_start timestamptz not null,
  range_end timestamptz not null,
  -- Per-issue section title overrides {section_key: "عنوان مخصص"} (§25).
  section_titles jsonb,
  -- Curation run summary: candidate counts, signal availability, zero-result
  -- search terms (editorial leads, §27), audience tallies used, LLM usage/cost.
  curation_meta jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists newsletter_issues_status_idx
  on public.newsletter_issues (status, created_at desc);

-- --- Items ------------------------------------------------------------------

create table if not exists public.newsletter_items (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.newsletter_issues (id) on delete cascade,
  -- 'article'  = published Salma content (content_id set; body NOT duplicated)
  -- 'external' = newsletter-only item from a verified external source (§14–15)
  -- 'transfer' = doctor move (transfer_id set) (§7)
  item_type text not null check (item_type in ('article','external','transfer')),
  content_id uuid references public.content (id) on delete cascade,
  transfer_id uuid references public.doctor_transfers (id) on delete cascade,
  -- External snapshot (nullable unless item_type='external').
  external_url text,
  external_source_name text,
  external_source_domain text,
  external_author text,                        -- future expert-articles ready (§10)
  external_published_at timestamptz,
  external_source_type text
    check (external_source_type in ('official','research','institution','media','expert','other')),
  verification_status text not null default 'needs_check'
    check (verification_status in ('verified','needs_check')),
  -- Editorial placement.
  section text not null
    check (section in ('lead','top_missed','economy','gcc','research','qol',
                       'trend','expert','transfers','quick')),
  position int not null default 0,
  -- Newsletter copy (reader-facing; concise by rule §22).
  newsletter_headline text,
  teaser text,                                 -- external: the 60–150 word brief (§15)
  short_analysis text,                         -- «ما معناه» (§23)
  why_ar text,                                 -- «لماذا يستحق وقتك؟» (§16)
  is_opinion boolean not null default false,   -- keeps رأي خبير distinct (§30)
  -- Explainability (§19, §26).
  reasons text[] not null default '{}',        -- badge keys (مصدر رسمي، بحث علمي، …)
  score numeric,                               -- composite curation score
  score_parts jsonb,                           -- per-signal breakdown
  editor_state text not null default 'suggested'
    check (editor_state in ('suggested','accepted','rejected','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Shape guard: each type carries its own reference.
  constraint newsletter_items_shape check (
    (item_type = 'article'  and content_id is not null) or
    (item_type = 'transfer' and transfer_id is not null) or
    (item_type = 'external' and external_url is not null)
  )
);

create index if not exists newsletter_items_issue_idx
  on public.newsletter_items (issue_id, section, position);

-- --- updated_at triggers (same helper the rest of the schema uses) ----------

drop trigger if exists newsletter_issues_updated_at on public.newsletter_issues;
create trigger newsletter_issues_updated_at
  before update on public.newsletter_issues
  for each row execute function public.set_updated_at();

drop trigger if exists newsletter_items_updated_at on public.newsletter_items;
create trigger newsletter_items_updated_at
  before update on public.newsletter_items
  for each row execute function public.set_updated_at();

-- --- RLS (§34): curation is for Owner/Super Admin/Admin/Editor = is_staff().
--     Subscriber PII stays under the existing stricter admin-only policies. ---

alter table public.newsletter_issues enable row level security;
alter table public.newsletter_items enable row level security;

drop policy if exists newsletter_issues_staff_all on public.newsletter_issues;
create policy newsletter_issues_staff_all on public.newsletter_issues
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists newsletter_items_staff_all on public.newsletter_items;
create policy newsletter_items_staff_all on public.newsletter_items
  for all using (public.is_staff()) with check (public.is_staff());
