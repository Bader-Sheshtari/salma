# Salma Master Roadmap — Canonical Source of Truth

> **Read this roadmap before starting any substantial Salma task. Update it after every meaningful milestone. Never silently remove, forget, or redefine a postponed item.**

This is the permanent, canonical roadmap for the entire Salma project. It supersedes ad‑hoc notes. When a fact cannot be established from the repository or a confirmed decision, it is marked **NEEDS CONFIRMATION** rather than guessed.

- **Last updated:** 2026-08-19
- **Product:** Salma — Arabic‑first (RTL) health & treatment news platform for Kuwait/GCC public + healthcare professionals.
- **Stack (from `package.json`):** Next.js 16.2.9 (App Router), React 19.2.4, Supabase (`@supabase/ssr`, `@supabase/supabase-js`), TailwindCSS v4, `@dnd-kit` for admin ordering. AI ingestion runs inside the Supabase Edge Function `ingest-news` (Deno). AI via OpenRouter.
- **Production Supabase project ref:** `ukraltlejlfkqbcifgcq`.

## Status legend

| Status | Meaning |
|---|---|
| **DONE** | Implemented and in the deployed/committed state. |
| **IN PROGRESS** | Actively being worked; partially complete. |
| **NEXT** | Immediate priority, not yet started. |
| **LATER** | Planned but deliberately deferred. |
| **BLOCKED** | Cannot proceed until a dependency/decision clears. |
| **NEEDS CONFIRMATION** | Detail not established from repo/decisions; must be verified before relied upon. |

Priority tags: **before launch** / **after launch** / **optional**.

---

## Current Production Milestone (authoritative snapshot — 2026-08-10)

| Item | Value |
|---|---|
| Edge Function `ingest-news` | **v27, ACTIVE** |
| Deployed commit | `8b60487ee6bd547b3d1e2c002c4dfa1465459433` (fix(ingestion): enforce full fidelity repair schema) |
| Production web (Vercel) commit | `67c3c7e415128627129c3d2b0ff5bb977a529333` (feat(design): Apple‑design browser defaults, ≥44px hit targets, subtle card feedback) — **Vercel Production deployment `success` on `main`, 2026‑08‑19** (supersedes `556965b`; intervening Radar commits up to `31f8f3a` were already deployed) |
| Editorial AI pipeline | trusted‑source → writer → Editorial Director → fidelity validation → constrained repair (≤1 LLM call) → final validation → **pending** |
| BBC end‑to‑end production pilot | **Completed successfully** on v27 — accepted article ID `e1138d51-6bea-4c9c-953a-f5a27a5b7ac8` |
| `verify_jwt` | **false** (function does its own auth) |
| Cron | **Unchanged** — jobid 1, `0 */6 * * *`, `salma-news-ingest` → `select public.run_news_ingestion();`, active |
| AI‑created content | **pending‑only** (`registry.ts` `DRAFT_STATUS = "pending"`) |
| Automatic publishing | **Disabled** |
| Migrations applied since deploy | **None** |

**Rollback (ingest-news):** previous version **v26** = commit `0ee4ca71f652c9d2a0105aacc5795cdf4df9fd85` (parent of `8b60487`); redeploy from that source to roll back. Cron, secrets, and schema need no change — none were altered. The earlier pre‑editorial rollback tag `stable/pre-editorial-pilot` → `c69d7f5` remains available locally and on `origin`.

**Rollback procedure (documented, not executed):**
1. `git checkout c69d7f5 -- supabase/functions/ingest-news` (or check out tag `stable/pre-editorial-pilot`).
2. Redeploy `ingest-news` from that source (creates a new version built from v22 source), preserving `verify_jwt=false`.
3. Cron, secrets, and schema need no change — none were altered.
> The rollback tag `stable/pre-editorial-pilot` → `c69d7f5` has been **pushed to GitHub** and is available both **locally and on `origin`** as a durable remote reference.

---

## Preserved Decisions (do not remove or silently override)

1. **Controlled 10‑article review** of real *pending* articles before permanent cron integration.
2. **Staged review:** start with **3** articles, review them, then continue with the remaining **7**.
3. **Never auto‑publish AI content** — all AI output stays `pending` for admin approval.
4. **Medical Profiles postponed** until 2–3 real stories validate the format.
5. **Social Q&A UI postponed** (schema exists; no public UI).
6. **Doctor ratings** require a later **legal + commercial** decision before public reliance.
7. **Final authentication hardening** is intentionally postponed to the end.
8. **PITR (Point‑in‑Time Recovery) intentionally disabled for now.**
9. **Storage/configuration backup + restore drill remain unfinished.**
10. **Do not remove postponed ideas** from this roadmap.

---

## Workstreams

### 1. Core platform and admin
- **Status:** DONE (core) / IN PROGRESS (ongoing polish) — **before launch**
- **Completed:** Next.js 16 App Router app; public site (home, article, category, video, doctors, transfers, search, about, contact); admin dashboard under `src/app/admin/(dashboard)` with content, categories, comments, doctors, departments, transfers, homepage, users, ingest, synthesize; content model with `draft/pending/approved/published/rejected` statuses; role hierarchy (`role_hierarchy`, `promote_owner`, manager update policy).
- **Human editorial‑review workflow (COMPLETE, 2026-08-10 — production web commit `556965b`, Vercel deployment Ready on `main`):** UI‑only additions on top of the existing content model so an admin can review AI‑generated pending articles quickly and safely — an **AI badge** in the Admin content list (driven by the existing `content.origin` field), a **source‑first review panel** on the edit screen showing provenance/status/created date with a verified **original source link** (opens in a new tab), an **admin‑only unpublished preview** (`/admin/preview/[id]`, `requireAdmin` + `noindex`, verified in production) rendered with the real article layout, and an **explicit Reject action** (`status = "rejected"`, non‑destructive, non‑public). Publication remains an explicit human‑admin action; no auto‑publish path was introduced; no schema/migration change.
- **Remaining:** Ongoing UX polish; admin ergonomics as features grow.
- **Next action:** None blocking; address per‑feature items in their workstreams.
- **Dependencies:** None.
- **Refs:** migrations `create_profiles`, `create_content_schema`, `content_rls_policies`, `role_hierarchy`, `promote_owner`, `profiles_manager_update_policy`; commit `556965b` (human editorial‑review workflow).

### 2. SEO and sharing
- **Status:** DONE (core) — **before launch**
- **Completed:** `src/app/sitemap.ts`, `src/app/robots.ts`, OpenGraph images for articles (`article/[slug]/opengraph-image.tsx`) and video (`video/[slug]/opengraph-image.tsx`); `ShareBar` component (WhatsApp/email/native share) wired into `ArticleView`.
- **Remaining:** Verify structured data (JSON‑LD article schema), canonical URLs, per‑page metadata completeness. **NEEDS CONFIRMATION** whether JSON‑LD is present.
- **Next action:** Audit metadata/JSON‑LD coverage across page types.
- **Dependencies:** Domain (WS 21) for absolute URLs.
- **Priority:** before launch.

### 3. Doctor Transfers
- **Status:** DONE — **before launch**
- **Completed:** Public `transfers` page + admin transfers CRUD; enrichment; secured private source (`secure_transfer_private_source`), minimal transfer RPC (`a2_minimal_transfer_rpc`); redesigned transfer cards.
- **Remaining:** None known.
- **Next action:** None.
- **Dependencies:** None.
- **Refs:** migrations `doctors_departments_transfers_ratings`, `transfers_enrichment`, `secure_transfer_private_source`, `a2_minimal_transfer_rpc`; commits `53d0b31`, `8629950`, `243150d`.

### 4. Supabase and code hardening
- **Status:** IN PROGRESS — **before launch**
- **Completed:** Privilege‑escalation guard on profiles; revoked trigger‑fn EXECUTE; blocked anon media listing; hardened execute + media listing; AI image usage rate limits; RLS policies on content.
- **Remaining:** Final security pass (see WS 27); confirm advisors (security/perf) are clean. **NEEDS CONFIRMATION** of latest `get_advisors` results.
- **Next action:** Run Supabase security + performance advisors and triage.
- **Dependencies:** Feature freeze for launch.
- **Refs:** migrations `guard_profile_privilege_escalation`, `revoke_trigger_fn_execute`, `harden_execute_and_media_listing`, `ai_image_usage_rate_limits`; commit `aed3da4`.

### 5. News sources and ingestion
- **Status:** DONE (foundation) / IN PROGRESS (expansion) — **before launch**
- **Completed:** `ingest-news` Edge Function (Deno) doing its own auth (cron `x-ingest-secret`; manual admin JWT); source registry (`news_source_registry`), WAM source registered (`register_wam_source`); admin sources manager, ingest runs view, ingest policy page; live extraction (`fetchSourceText.ts`); semantic dedupe (`dedupe.ts`, `ingestion_decisions_dedupe_audit`); trusted‑source enforcement; targeted single‑article pilot provenance (`ingestion_runs.pilot_source_domain`).
- **Remaining:** Broaden the registered/verified source set; source‑quality monitoring (WS 11).
- **NEXT IMMEDIATE DESIGN TASK — SALMA SOURCE UNIVERSE / SOURCE STRATEGY (2026-08-10):** expand and classify the source network into three roles — (1) **Discovery sources**, (2) **Primary / authoritative sources**, (3) **Final‑source‑allowed media** (all three already expressible via `discovery_enabled` / `source_type`+`tier` / `final_source_allowed`). Design/classification only — **do not add or modify any sources yet**. This is the prerequisite for wiring Priority Score v1 (WS 10) into the cron path.
- **Next action:** Design the Source Universe classification (discovery vs primary/authoritative vs final‑allowed media); no source changes yet.
- **Dependencies:** Editorial policy (block/allow lists) in `editorial_policy`.
- **Refs:** migrations `news_source_registry`, `register_wam_source`, `ingestion_decisions_source_extraction`, `ingestion_decisions_dedupe_audit`, `ingestion_runs_targeted_pilot`; commits `7b64c0d`, `e828c05`, `be31d7d`.

### 6. AI writer
- **Status:** DONE (verified) — **before launch**
- **Completed:** `salmaWriter.ts` writer with profile‑aware routing (`writerRouter.ts`), factual validator (`validateArticle`), foreign‑name grounding, completion‑parsing hardening; writer audit persisted per candidate (`ingestion_decisions_writer_audit`). Unit tests green (`salmaWriter.test.ts`).
- **Remaining:** None functional; behavior validated in eval.
- **Next action:** None until pilot findings suggest tuning.
- **Dependencies:** OpenRouter model config (env secrets).
- **Refs:** commits `b65836f`, `e4a33fe`, `5bfaca3`, `0579c9d`.
- **Note (verified enforcement boundary):** the factual validator rejects unsupported **numbers** but does not catch purely qualitative exaggeration — "no exaggeration" is a prompt‑level guarantee.

### 7. AI Editorial Director
- **Status:** DONE — **implementation phase CLOSED** (2026-08-10) — **before launch**
- **Completed:** `salmaEditor.ts` (`runEditorPass`): English‑placement gate, factual re‑validation, safety‑alert risk retention (E1.9), bounded second call (formatting recovery **or** editorial repair), safe fallback to original writer draft with `needs_human_review`. Full editorial AI pipeline live in production **v27** (commit `8b60487`): trusted‑source → writer → Editorial Director → fidelity validation → constrained repair (max one LLM call, must return the complete valid article JSON) → final validation → **pending**. A successful real BBC end‑to‑end production pilot completed, accepted into pending as article ID `e1138d51-6bea-4c9c-953a-f5a27a5b7ac8`. All AI content remains pending; automatic publishing remains disabled.
- **Remaining:** None for the Writer + Editorial Director + fidelity‑repair implementation — this phase is **closed**. Do **not** add new editorial rules unasked. Any future work is tuning driven by real review findings, not new implementation.
- **Next action:** None (phase closed).
- **Dependencies:** None.
- **Refs:** commits `c69d7f5`, `e13fefb`, `0ee4ca7` (v26), `8b60487` (v27); memory `project_editor_eval.md`.

### 8. Controlled editorial-pipeline pilot
- **Status:** COMPLETE (2026-08-10) — implementation-validation phase closed
- **Completed:** The controlled initial editorial-pipeline pilot is **complete**. Deployment prerequisites in place (v27 active; pending‑only; rollback ready). The successful BBC v27 end‑to‑end pending article (ID `e1138d51-6bea-4c9c-953a-f5a27a5b7ac8`, ran the full pipeline and was accepted into pending — nothing published) is **sufficient to close the implementation-validation phase**. **No additional seven‑article pilot is required.**
- **Remaining:** None as a mandatory pilot. Future real‑world monitoring happens during **normal controlled operations**, not as a required remaining pilot.
- **Next action:** None. Writer + Editorial Director + fidelity pipeline remain **CLOSED** unless a repeated critical defect appears.
- **Dependencies:** WS 6, WS 7 (done).
- **Priority:** closed (implementation-validation).
- **Preserved rule:** all AI‑generated content remains **pending** and requires **explicit human review before publication**; never auto‑publish.

### 9. Editorial audit persistence
- **Status:** LATER BACKLOG — **not required for the current basic human-review workflow** (2026-08-10). The human editorial-review workflow (WS 1) ships without persisted editorial/fidelity audit; full audit persistence stays a later observability enhancement, deferred until scaling.
- **Completed:** Writer audit, source‑extraction audit, and dedupe audit are persisted on `ingestion_decisions`. Editorial audit (`EditorialAudit`) is currently **observability‑only** — computed and returned in the pilot report but **NOT persisted** (index.ts intentionally leaves the `ingestion_decisions` insert unchanged; no migration in v23).
- **Remaining:** Design a non‑destructive column/table to persist editorial audit (verdict, `final_draft_source`, rejection reason, second‑attempt type, gate warnings) so pilot reviews are queryable.
- **Next action:** Draft a nullable, additive migration for editorial audit fields (review‑only; do not apply without authorization).
- **Dependencies:** Coordinate with WS 8 so pilot results are captured.
- **Priority:** before launch (recommended before permanent cron).
- **Note:** Local migration filename dates (`20260804…`, `20260805…`, `20260806…`) do **not** match applied remote versions (`20260802155824`, `20260802155833`, `20260802221414`); the remote is authoritative. **NEEDS CONFIRMATION** whether local migration filenames should be reconciled with applied versions.

### 10. Cron integration
- **Status:** IN PROGRESS (foundation live; permanent integration gated) — **before launch**
- **Completed:** pg_cron job `salma-news-ingest` every 6h → `run_news_ingestion()` → POSTs to Edge Function with `x-ingest-secret`. Unchanged by v23 deploy.
- **Approved design decision — SALMA NEWS PRIORITY SCORE v1 (2026-08-10, design only — not implemented):** the approved deterministic 0–100 ranking that WS10 integration will apply to story clusters **after** clustering/representative selection and **before** `pilot_limit=1` selects the single candidate. Editorial principle: **NEWS VALUE FIRST** — geography is a meaningful boost, not an overriding hierarchy.
  - **Positive score (weights total 100):** `Priority_base = 0.60·IMPACT + 0.15·AUTHORITY + 0.15·RELEVANCE + 0.10·SAME-RUN BREADTH`, then **minus** the approved thresholded Institutional‑PR penalty; final result clamped to [0,100].
    - **IMPACT (60%)** = `editorial_value_score` (0–100). News value dominant.
    - **AUTHORITY (15%)** = bounded blend of representative source `tier` / `trust_score` / primary preference (`source_type != 'media'`), capped at 100.
    - **RELEVANCE (15%)** = `relevance_score` (0–100 Kuwait/Gulf) — a bounded boost, never overriding the Impact band.
    - **SAME-RUN BREADTH (10%)** = weak same-run Heat proxy over **distinct registered credible domains** in the cluster: `0–1 domains = 0`, `2 = 50`, `3 = 75`, `4+ = 100`. A single credible domain earns **no** breadth credit; counting distinct *registered* domains defeats syndication volume.
    - **Institutional‑PR penalty (thresholded, subtractive, max −15):** `institutional_pr_score <= 40 → 0`; above 40 it rises linearly to a **−15** cap at PR=100 (`penalty = clamp(15·(pr−40)/60, 0, 15)`). Purpose: suppress ceremonial/promotional PR **without** penalizing legitimate major policy or medical announcements merely because they originate from an institution.
  - **Missing/edge rules:** a **null/unusable `editorial_value_score` = UNRANKABLE** (sorts below every scored story and is never selected); **if all eligible stories are unrankable, select none** (prefer publishing nothing over arbitrary discovery‑order selection). **Recency remains tie‑break only** in v1 — `published_date` gets no numeric weight (it is unreliable/often null).
  - **Extraction fallback (approved future behavior, not implemented):** a **source‑fetch failure must NOT consume the single Writer slot** — ranked candidates may continue through extraction failures (#1 → #2 → #3 …). The single cron AI slot is consumed **only once one story begins the Writer stage**; **no second story is attempted after Writer / Editorial Director / fidelity rejection**; **maximum one Writer pipeline attempt per cron run remains unchanged**. Smallest change: relocate the slot‑consumption point from source‑fetch start to Writer‑stage entry, `continue` to the next ranked plan on fetch failure, and `break` unconditionally after the Writer stage.
  - **Preserved rule:** all accepted AI content remains **pending‑only** and requires **explicit human publication**; never auto‑publish.
  - **v2 boundary:** true **News Heat / Coverage Velocity is explicitly v2**. Future Heat v2 should **replace/refine only the current 10% SAME‑RUN BREADTH component** where possible (swap its internals for cross‑run persistent‑story heat), leaving IMPACT/AUTHORITY/RELEVANCE weights, the PR penalty, the recency tie‑break, the missing‑Impact rule, and the clamp unchanged.
- **Remaining:** Implement the approved Priority Score v1 + extraction‑fallback behavior as part of permanent cron integration (gated on the source‑strategy work below); keep pending‑only.
- **Next action:** Proceed to the next immediate design task — **SALMA SOURCE UNIVERSE / SOURCE STRATEGY** (see WS 5) — before wiring Priority Score v1 into the cron path.
- **Dependencies:** WS 5 (source universe/strategy), WS 9 (audit persistence).
- **Refs:** migrations `news_agent_cron`, `ingest_call_edge_function`.

### 11. Source quality and monitoring
- **Status:** LATER — **after launch** (partial before launch)
- **Completed:** Per‑candidate decision logging (`ingestion_decisions`), run‑level provenance, dedupe audit.
- **Remaining:** Dashboards/alerts for source health (extraction failure rates, rejection reasons, dedupe rates); flag degraded sources.
- **Next action:** Define key ingestion quality metrics to surface in admin.
- **Dependencies:** WS 26 (analytics dashboard).
- **Priority:** partial before launch (basic run visibility exists); richer monitoring after launch.

### 12. Research and Studies
- **Status:** NEEDS CONFIRMATION / LATER — **after launch**
- **Completed:** No dedicated "Research/Studies" section found (references appear only in search/sources contexts).
- **Remaining:** Confirm scope — is this a distinct content type/section or covered by categories?
- **Next action:** Confirm product intent with owner before designing.
- **Dependencies:** Content model (WS 1).
- **Priority:** after launch (pending confirmation).

### 13. Medical Profiles
- **Status:** LATER (postponed by decision) — **after launch**
- **Completed:** None (deliberately).
- **Remaining:** Define and build once **2–3 real stories** validate the format.
- **Next action:** Revisit only after real stories exist.
- **Dependencies:** Real editorial content.
- **Priority:** after launch. **Preserved postponement.**

### 14. Social Q&A
- **Status:** LATER (UI postponed by decision) — **after launch**
- **Completed:** Schema exists (`social_qa` migration). No public/admin UI found.
- **Remaining:** UI + moderation flow when prioritized.
- **Next action:** None until un‑postponed.
- **Dependencies:** Comments/moderation patterns (WS 15).
- **Priority:** after launch. **Preserved postponement.**
- **Refs:** migration `social_qa`.

### 15. Comments and moderation
- **Status:** DONE (revalidated 2026-08-05) — **before launch**
- **Completed (verified end‑to‑end):** Public posting without login via `submitComment` server action (`src/app/actions/comments.ts`) with validation; DB trigger forces `status='pending'` so comments are held. Public UI `src/components/site/Comments.tsx` (form + list) wired into `ArticleView` (line 206); public fetch renders **approved‑only** (`src/lib/queries.ts` `.eq("status","approved")`). Admin moderation `src/app/admin/(dashboard)/comments/page.tsx` with pending/approved/rejected tabs and **approve/reject/delete** via `moderateComment` (`src/app/admin/actions.ts`). Admin dashboard shows pending count (`admin-queries.ts`). Backed by `comments` table with `status`.
- **Remaining:** Spam/abuse controls at scale (rate‑limiting, honeypot/CAPTCHA). **NEEDS CONFIRMATION** of any anti‑spam measures — none found in repo.
- **Next action:** Decide on anti‑spam controls before high‑traffic launch (non‑blocking for core workflow).
- **Dependencies:** None.
- **Refs:** `Comments.tsx`, `actions/comments.ts`, `admin/(dashboard)/comments/page.tsx`, `admin/actions.ts:moderateComment`, `queries.ts`.

### 16. "In Brief" summaries
- **Status:** DONE (revalidated 2026-08-05) — **before launch**
- **Completed (verified end‑to‑end):** Admin authors a quick summary in `ContentForm` — labelled textarea «باختصار (ملخص سريع يظهر أعلى المقال)» (`name="ai_summary"`, `content/ContentForm.tsx`); persisted by `saveContent` (`admin/actions.ts`, field `ai_summary`); rendered as a distinct tinted «باختصار» box near the top of the article (`ArticleView.tsx` lines 77–84, conditional on `content.ai_summary`). This is an authored, editable, rendered field — not merely a bare DB column. (A separate homepage brief block was intentionally dropped — commit `709c634`.)
- **Remaining:** None known for the summary‑box workflow.
- **Next action:** None.
- **Dependencies:** None.
- **Refs:** `ContentForm.tsx` (ai_summary), `admin/actions.ts:saveContent`, `ArticleView.tsx`; commit `5a02316`.

### 17. Breaking News
- **Status:** DONE (revalidated 2026-08-05) — **before launch**
- **Completed (verified end‑to‑end):** Admin «عاجل» toggle `is_breaking` checkbox in `ContentForm` (line 407); persisted by `saveContent` (`admin/actions.ts`, field `is_breaking`); homepage query `getHomepage` (`queries.ts`) selects `.eq("is_breaking", true)` (latest, limit 8) into `data.breaking`; rendered as the coral marquee `BreakingTicker.tsx` in `HomeView` (line 26), hidden when empty. Complete author→persist→render loop.
- **Remaining:** None known.
- **Next action:** None.
- **Dependencies:** None.
- **Refs:** `ContentForm.tsx` (is_breaking), `admin/actions.ts:saveContent`, `queries.ts:getHomepage`, `BreakingTicker.tsx`, `HomeView.tsx`; commit `ba61343`.

### 18. Video support
- **Status:** DONE (revalidated 2026-08-05) — **before launch**
- **Completed (verified end‑to‑end):** Admin sets content type «فيديو», `video_url` (YouTube/Vimeo) and duration in `ContentForm` (lines 371–388); persisted by `saveContent` (`admin/actions.ts`, field `video_url`). Public rendering: dedicated `/video/[slug]` route (`app/video/[slug]/page.tsx`) using `ArticleView`, which embeds the video via `embedUrl` (`ArticleView.tsx` lines 95–125, both video‑type and in‑article cases); homepage «فيديو وتبسيط طبي» lane renders `data.videos` as `VideoCard` (`HomeView.tsx` lines 65–71); video OpenGraph image (`video/[slug]/opengraph-image.tsx`); auto YouTube thumbnail cover fallback.
- **Remaining:** None known.
- **Next action:** None.
- **Dependencies:** None.
- **Refs:** `ContentForm.tsx` (video_url), `admin/actions.ts:saveContent`, `app/video/[slug]/page.tsx`, `ArticleView.tsx`, `HomeView.tsx`; commits `7c78141`, `5a02316`.

### 19. Homepage and article-page UX
- **Status:** DONE (core) / IN PROGRESS (polish) — **before launch**
- **Completed:** Rotating homepage hero; drag‑and‑drop section ordering (`@dnd-kit`); direct position control for sections; homepage section pages; article page with share, summary, video, read time, post‑save actions.
- **Remaining:** Ongoing visual polish; responsive/mobile QA.
- **Next action:** Mobile/RTL QA pass before launch (part of WS 31).
- **Dependencies:** Design system (WS 20).
- **Refs:** commits `ba61343`, `709c634`, `5a02316`.

### 20. Branding and design system
- **Status:** IN PROGRESS — **before launch**
- **Completed:** Tailwind v4 design tokens; coral accent; form‑control background polish; RTL Arabic‑first layout.
- **Completed — Apple Design / browser‑platform polish phase: DONE (2026‑08‑19, commit `67c3c7e`, Vercel Production `success`).** Audited against the `apple-design` skill (Emil Kowalski) and shipped, frontend‑only:
  - Browser defaults owned in `globals.css` — overridable defaults in `@layer base` (touch‑action manipulation, pointer cursor / no text‑selection on buttons, press feedback on `a`/`button`, `color-scheme: light`, smooth in‑page anchor scroll + `data-scroll-behavior` for the Next 16 router, `scrollbar-gutter: stable`, `font-synthesis: none`, anchor `scroll-margin-top`, brand `::selection`, `text-wrap: balance` on h1–h3, `overflow-wrap`); deliberately unlayered platform guarantees (`:focus-visible` ring that beats `outline-none`, 16px form controls on coarse pointers to stop iOS focus zoom, `.salma-focus-inset`/`.salma-focus-halo`); `prefers-reduced-motion` handling (ticker/pulse stop, ticker rail becomes scrollable, anchors jump); ticker pause on hover (hover‑capable only) and `:focus-within`; `theme-color` viewport export.
  - Hit targets ≈44px with visual size and layout unchanged: header search/subscribe/logo/nav links, hero dots, SectionTitle action, ShareBar, comment submit, article category chip/credit/sources, contact mailto, doctors filter chips, breaking‑ticker headlines, footer links.
  - Subtle card feedback (hover‑capable + motion‑safe only): 3% image zoom via `Cover zoom` prop (image branches only), title colour → teal, `group`/`isolate` on ContentCard/ListRow/SearchResultRow/VideoCard/HeroCard/HomeSection lead/RotatingHero; hero cross‑fade moved to a wrapper so slides get instant press feedback.
  - Verified: desktop/tablet/mobile geometry identical to the previous HEAD (only the intended 16px‑input growth on touch), RTL/mixed‑script intact, focus rings visible incl. inside clipped surfaces, no console errors; `tsc`, `eslint` (changed files), `next build` clean.
- **Deliberately deferred (design recommendations, not started):** translucent/blurred header material; hero swipe/gesture navigation (Embla); RatingForm star hit targets (doctor ratings postponed, WS 24); replacing the BreakingTicker marquee with a rotating/cross‑fade headline (current ticker concept stays).
- **Remaining:** Consolidate design tokens/components; confirm exact homepage match to the reference design (`Salma Mobile Homepage.dc.html`). **NEEDS CONFIRMATION** whether the reference design was exported into the repo.
- **Next action:** Obtain/confirm the canonical design reference; reconcile.
- **Dependencies:** Design source from owner.
- **Refs:** commits `91b86ed`, `67c3c7e`; memory `project_salma.md`; skill `~/.claude/skills/apple-design/SKILL.md`.

### 21. Domain and production launch
- **Status:** NEEDS CONFIRMATION — **before launch**
- **Completed:** App deployable (Next.js on Vercel per architecture notes). **NEEDS CONFIRMATION** of current hosting/domain status.
- **Remaining:** Custom domain, DNS, TLS, production env/config, Vercel↔Supabase wiring.
- **Next action:** Confirm hosting target and domain; finalize production configuration.
- **Dependencies:** WS 27 (security), WS 31 (QA checklist).
- **Priority:** before launch.

### 22. Legal and editorial policy pages
- **Status:** IN PROGRESS / NEEDS CONFIRMATION — **before launch**
- **Completed:** `about` and `contact` pages exist; admin ingest **policy** page (`ingest/policy`) for editorial allow/block lists.
- **Remaining:** Public Privacy Policy, Terms of Use, editorial standards / corrections policy, medical disclaimer. **NEEDS CONFIRMATION** whether privacy/terms pages exist.
- **Next action:** Draft legal/policy pages (privacy, terms, medical disclaimer).
- **Dependencies:** Legal review.
- **Priority:** before launch.

### 23. Newsletter and subscriptions
- **Status:** IN PROGRESS — **after launch** (capture before launch)
- **Completed:** `newsletter_subscribers` table; `NewsletterForm` + `actions/newsletter.ts`; signup entry points in header/home.
- **Remaining:** Sending/delivery pipeline, double opt‑in, unsubscribe. **NEEDS CONFIRMATION** of any email delivery integration.
- **Next action:** Decide delivery provider; implement confirmation + unsubscribe.
- **Dependencies:** Email provider decision.
- **Priority:** capture before launch; delivery after launch.

### 24. Doctor ratings
- **Status:** BLOCKED (pending legal/commercial decision) — **after launch**
- **Completed:** Admin ratings page + public doctor ratings display + `actions/ratings.ts`; schema in `doctors_departments_transfers_ratings`.
- **Remaining:** Public‑reliance policy; moderation; legal/commercial sign‑off before promoting ratings.
- **Next action:** Obtain legal + commercial decision before public emphasis.
- **Dependencies:** Legal/commercial.
- **Priority:** after launch. **Preserved: requires later decision.**

### 25. Advertising and monetization
- **Status:** LATER — **after launch / optional**
- **Completed:** None.
- **Remaining:** Ad placements/sponsorship model or other monetization; policy alignment with editorial trust.
- **Next action:** Defer until audience/traction exists.
- **Dependencies:** Analytics (WS 26), legal (WS 22).
- **Priority:** after launch / optional.

### 26. Analytics and editorial dashboard
- **Status:** LATER — **after launch** (basic before launch)
- **Completed:** Admin landing dashboard (`admin/(dashboard)/page.tsx`) with content/comment overviews; ingest runs view.
- **Remaining:** Traffic analytics, editorial KPIs (throughput, approval rates, source quality), ingestion health metrics.
- **Next action:** Define minimal launch KPIs; choose privacy‑respecting analytics.
- **Dependencies:** WS 11, WS 9.
- **Priority:** basic before launch; richer after.

### 27. Authentication and final security hardening
- **Status:** LATER (intentionally postponed to the end) — **before launch (final gate)**
- **Completed:** Admin‑only auth model (public site is anonymous); role hierarchy; RLS; execution/media hardening; privilege‑escalation guard.
- **Remaining:** Final end‑to‑end security review (auth flows, session handling, RLS coverage, secret hygiene, advisor findings) as the last pre‑launch gate.
- **Next action:** Schedule the final hardening pass at the end, before launch sign‑off.
- **Dependencies:** Feature freeze.
- **Priority:** before launch (final). **Preserved postponement to end.**

### 28. Storage/configuration backups and restore drill
- **Status:** BLOCKED / IN PROGRESS (unfinished) — **before launch**
- **Completed:** None verified.
- **Remaining:** Define backup strategy for storage + configuration; perform an actual **restore drill**. **PITR intentionally disabled for now** — revisit before/at launch.
- **Next action:** Decide backup approach; run a restore drill; document.
- **Dependencies:** Owner decision on PITR re‑enablement.
- **Priority:** before launch. **Preserved: PITR off; backups/restore unfinished.**

### 29. Monitoring and system health
- **Status:** LATER — **after launch** (basic before launch)
- **Completed:** Edge Function logs available via Supabase; ingestion run records.
- **Remaining:** Uptime/error alerting for Edge Function + cron; failure notifications; log retention policy. **NEEDS CONFIRMATION** of any external monitoring.
- **Next action:** Add basic cron/Edge failure alerting before launch.
- **Dependencies:** None hard.
- **Priority:** basic before launch; richer after.

### 30. Editorial governance and team workflow
- **Status:** IN PROGRESS — **before launch**
- **Completed:** Role hierarchy (admin/manager/owner); pending‑approval workflow; editorial policy page; ingest runs review.
- **Remaining:** Written editorial SOP (who reviews, approval SLAs, corrections handling); reviewer assignment for the 10‑article pilot.
- **Next action:** Draft the reviewer workflow for the pilot (WS 8).
- **Dependencies:** WS 8, WS 22.
- **Priority:** before launch.

### 31. Full QA and launch checklist
- **Status:** NEXT — **before launch**
- **Completed:** Automated tests for ingestion/writer/editor (Node `--test`); build/lint/typecheck pipeline verified during v23 release.
- **Remaining:** End‑to‑end QA: RTL/mobile, SEO/OG, sharing, comments moderation, admin CRUD, ingestion pending flow, accessibility, cross‑browser; final launch checklist sign‑off.
- **Next action:** Assemble the launch QA checklist and run a full pass.
- **Dependencies:** WS 19, WS 20, WS 21, WS 27.
- **Priority:** before launch.

### 32. Post-launch growth features
- **Status:** LATER — **after launch / optional**
- **Completed:** None.
- **Remaining:** Candidate ideas — Medical Profiles (WS 13), Social Q&A UI (WS 14), Research/Studies section (WS 12), richer personalization, newsletter delivery, monetization (WS 25). **Do not remove postponed ideas.**
- **Next action:** Reprioritize after launch based on traction.
- **Dependencies:** Launch complete.
- **Priority:** after launch / optional.

---

## Changelog

| Date | Workstream | Previous status | New status | Reason |
|---|---|---|---|---|
| 2026-08-05 | (roadmap) | — | Created | Established canonical Salma roadmap as permanent source of truth. |
| 2026-08-05 | 7. AI Editorial Director | IN PROGRESS (local, approved) | DONE (deployed) | Editorial Director wired into `ingest-news` and deployed in v23 (commit `e13fefb`); byte‑verified; approved for controlled pilot. |
| 2026-08-05 | 10. Cron integration | (foundation live) | IN PROGRESS (gated) | Cron unchanged by v23; permanent Editorial‑Director cron behavior gated on the 10‑article pilot. |
| 2026-08-05 | 8. Controlled ten-article pilot | (planned) | NEXT | Deployment prerequisites met; staged 3‑then‑7 review is the immediate next step, pending‑only. |
| 2026-08-05 | 9. Editorial audit persistence | (implicit) | NEXT | Confirmed editorial audit is observability‑only, not persisted; additive persistence needed before scaling. |
| 2026-08-05 | (production/rollback) | tag local‑only | tag local + on `origin` | Corrected rollback record: `stable/pre-editorial-pilot` → `c69d7f5` was pushed to GitHub and is now available locally and on `origin`. |
| 2026-08-05 | 15. Comments and moderation | DONE | DONE (revalidated) | Verified full end‑to‑end workflow (public form + approved‑only render + admin approve/reject/delete + `comments.status`); status stands. |
| 2026-08-05 | 16. "In Brief" summaries | DONE | DONE (revalidated) | Verified admin‑authored «باختصار» textarea → `saveContent` → rendered box in `ArticleView`; an editable/rendered field, not a bare column; status stands. |
| 2026-08-05 | 17. Breaking News | DONE | DONE (revalidated) | Verified `is_breaking` toggle → `saveContent` → `getHomepage` `is_breaking=true` → `BreakingTicker` on homepage; status stands. |
| 2026-08-05 | 18. Video support | DONE | DONE (revalidated) | Verified `video_url`/type admin controls → `saveContent` → `/video/[slug]` + in‑article embed + homepage video lane; status stands. |
| 2026-08-10 | 7. AI Editorial Director | DONE (deployed v23) | DONE — implementation phase CLOSED | Full pipeline (trusted‑source → writer → Editorial Director → fidelity validation → constrained repair → final validation → pending) live in `ingest-news` v27 (commit `8b60487`); all AI content stays pending; auto‑publish remains disabled. |
| 2026-08-10 | 8. Controlled ten-article pilot | NEXT | IN PROGRESS | First real end‑to‑end production pilot completed on v27 — one BBC article accepted (ID `e1138d51-6bea-4c9c-953a-f5a27a5b7ac8`); staged 3‑then‑7 review continues, pending‑only. |
| 2026-08-10 | 8. Controlled editorial-pipeline pilot | IN PROGRESS | COMPLETE | Approved decision reversal: the successful BBC v27 pending article closes the implementation-validation phase; no additional seven‑article pilot required. Future monitoring happens during normal controlled operations. Writer + Editorial Director + fidelity pipeline remain CLOSED unless a repeated critical defect appears; all AI content stays pending, explicit human review required. |
| 2026-08-10 | 1. Core platform and admin (human editorial-review workflow) | (not tracked) | COMPLETE | Human editorial-review workflow shipped — production web commit `556965b`, Vercel deployment Ready on main: AI badge, source‑first review panel, verified original source link, admin‑only unpublished preview (`/admin/preview/[id]`, `requireAdmin` + noindex), explicit Reject (`status="rejected"`, non‑destructive/non‑public); publication remains explicit human‑admin action; no schema/migration. |
| 2026-08-10 | 9. Editorial audit persistence | NEXT | LATER BACKLOG | Full Editorial Director/fidelity audit persistence deferred; not required for the current basic human‑review workflow. |
| 2026-08-10 | 10. Cron integration | IN PROGRESS (gated) | IN PROGRESS (design approved) | Approved **SALMA NEWS PRIORITY SCORE v1** (design only, not implemented): `0.60·IMPACT + 0.15·AUTHORITY + 0.15·RELEVANCE + 0.10·SAME‑RUN BREADTH` minus a thresholded Institutional‑PR penalty (0 at PR≤40, rising to −15 at PR=100); NEWS VALUE FIRST, geography a boost not a hierarchy; null‑Impact = UNRANKABLE (if all unrankable, select none); recency tie‑break only; breadth 0/50/75/100 for 1/2/3/4+ distinct registered credible domains; source‑fetch failure must not consume the single Writer slot (continue through extraction failures; slot consumed at Writer start; no second story after Writer/Editor/fidelity rejection; one Writer attempt/run); Heat/Coverage‑Velocity explicitly v2 replacing only the 10% breadth term; all AI content stays pending, explicit human publication required. |
| 2026-08-10 | 5. News sources and ingestion | (expansion) | NEXT DESIGN TASK | Set **SALMA SOURCE UNIVERSE / SOURCE STRATEGY** as the next immediate design task: classify the source network into Discovery / Primary‑authoritative / Final‑source‑allowed media. Design only — no sources added or modified yet. |
| 2026-08-19 | 20. Branding and design system (Apple Design / browser‑platform polish sub‑phase) | (local, uncommitted) | DONE — phase CLOSED | Apple‑design audit + fixes shipped in commit `67c3c7e` (Vercel Production `success`): browser defaults in `@layer base` + unlayered focus/iOS‑zoom guarantees, reduced‑motion support, ≥44px hit targets with zero layout shift, subtle motion‑safe card feedback. Radar/editorial/admin logic, schema, SEO, comments, transfers, auth untouched. Deferred: translucent header, hero swipe/Embla, rating‑star targets, ticker replacement. Categories work not started. |

---

## Open Items Marked NEEDS CONFIRMATION
- SEO JSON‑LD / structured data coverage (WS 2).
- Latest Supabase security/performance advisor results (WS 4).
- Research/Studies scope as a distinct section (WS 12).
- Anti‑spam controls for comments at scale (WS 15).
- Whether the reference homepage design was exported into the repo (WS 20).
- Current hosting/domain/production configuration status (WS 21).
- Existence of Privacy/Terms/medical‑disclaimer pages (WS 22).
- Newsletter email delivery integration (WS 23).
- External uptime/error monitoring (WS 29).
- Reconciliation of local migration filenames vs applied remote versions (WS 9).
