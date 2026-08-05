# Salma Master Roadmap — Canonical Source of Truth

> **Read this roadmap before starting any substantial Salma task. Update it after every meaningful milestone. Never silently remove, forget, or redefine a postponed item.**

This is the permanent, canonical roadmap for the entire Salma project. It supersedes ad‑hoc notes. When a fact cannot be established from the repository or a confirmed decision, it is marked **NEEDS CONFIRMATION** rather than guessed.

- **Last updated:** 2026-08-05
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

## Current Production Milestone (authoritative snapshot — 2026-08-05)

| Item | Value |
|---|---|
| Edge Function `ingest-news` | **v23, ACTIVE** |
| Deployed commit | `e13fefb` (feat(ingestion): wire Salma Editorial Director into ingest-news) |
| Deployed source vs committed HEAD | **Byte‑identical** (all 8 runtime files sha256‑verified) |
| Rollback tag | `stable/pre-editorial-pilot` — **pushed: available locally and on `origin`** |
| Rollback commit | `c69d7f5` (pre‑editorial; = previous function v22 source) |
| `verify_jwt` | **false** (function does its own auth) |
| Cron | **Unchanged** — jobid 1, `0 */6 * * *`, `salma-news-ingest` → `select public.run_news_ingestion();`, active |
| AI‑created content | **pending‑only** (`registry.ts` `DRAFT_STATUS = "pending"`) |
| Automatic publishing | **Disabled** |
| Production pilot after v23 | **None run yet** |
| Migrations applied since deploy | **None** |
| Temporary deployment access token | **Revoked** |

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
- **Completed:** Next.js 16 App Router app; public site (home, article, category, video, doctors, transfers, search, about, contact); admin dashboard under `src/app/admin/(dashboard)` with content, categories, comments, doctors, departments, transfers, homepage, users, ingest, synthesize; content model with `draft/pending/approved/published` statuses; role hierarchy (`role_hierarchy`, `promote_owner`, manager update policy).
- **Remaining:** Ongoing UX polish; admin ergonomics as features grow.
- **Next action:** None blocking; address per‑feature items in their workstreams.
- **Dependencies:** None.
- **Refs:** migrations `create_profiles`, `create_content_schema`, `content_rls_policies`, `role_hierarchy`, `promote_owner`, `profiles_manager_update_policy`.

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
- **Next action:** Curate and register additional trusted GCC/MENA/global health sources.
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
- **Status:** DONE (deployed, approved for controlled pilot) — **before launch**
- **Completed:** `salmaEditor.ts` (`runEditorPass`): English‑placement gate, factual re‑validation, safety‑alert risk retention (E1.9), bounded second call (formatting recovery **or** editorial repair), safe fallback to original writer draft with `needs_human_review`. Prompt version `e1.8-salma-editor`. Wired into `index.ts`; a factually valid edit is retained, else original kept. 69 editor tests green. Deployed in v23 (commit `e13fefb`).
- **Remaining:** Observe behavior on real pending articles during the 10‑article pilot (WS 8); do **not** add new editorial rules unasked.
- **Next action:** Feed pilot outputs; collect human verdicts.
- **Dependencies:** WS 8 (pilot).
- **Refs:** commits `c69d7f5`, `e13fefb`; memory `project_editor_eval.md`.

### 8. Controlled ten-article pilot
- **Status:** NEXT — **before launch**
- **Completed:** Deployment prerequisites in place (v23 active; pending‑only; rollback ready). Targeted‑pilot provenance column exists.
- **Remaining:** Execute the staged review — **generate/collect 3 real pending articles → human review → then 7 more**; record verdicts; decide on permanent cron integration afterward.
- **Next action:** Produce the first **3** pending articles for review (no publishing).
- **Dependencies:** WS 6, WS 7 (done); WS 9 (audit persistence) strongly recommended before scaling.
- **Priority:** before launch.
- **Preserved rule:** never auto‑publish; start with 3, then 7.

### 9. Editorial audit persistence
- **Status:** NEXT — **before launch**
- **Completed:** Writer audit, source‑extraction audit, and dedupe audit are persisted on `ingestion_decisions`. Editorial audit (`EditorialAudit`) is currently **observability‑only** — computed and returned in the pilot report but **NOT persisted** (index.ts intentionally leaves the `ingestion_decisions` insert unchanged; no migration in v23).
- **Remaining:** Design a non‑destructive column/table to persist editorial audit (verdict, `final_draft_source`, rejection reason, second‑attempt type, gate warnings) so pilot reviews are queryable.
- **Next action:** Draft a nullable, additive migration for editorial audit fields (review‑only; do not apply without authorization).
- **Dependencies:** Coordinate with WS 8 so pilot results are captured.
- **Priority:** before launch (recommended before permanent cron).
- **Note:** Local migration filename dates (`20260804…`, `20260805…`, `20260806…`) do **not** match applied remote versions (`20260802155824`, `20260802155833`, `20260802221414`); the remote is authoritative. **NEEDS CONFIRMATION** whether local migration filenames should be reconciled with applied versions.

### 10. Cron integration
- **Status:** IN PROGRESS (foundation live; permanent integration gated) — **before launch**
- **Completed:** pg_cron job `salma-news-ingest` every 6h → `run_news_ingestion()` → POSTs to Edge Function with `x-ingest-secret`. Unchanged by v23 deploy.
- **Remaining:** Decide permanent cron behavior with the Editorial Director **after** the 10‑article pilot; keep pending‑only.
- **Next action:** Hold cron as‑is until pilot completes; then review cadence/behavior.
- **Dependencies:** WS 8 (pilot), WS 9 (audit persistence).
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
- **Remaining:** Consolidate design tokens/components; confirm exact homepage match to the reference design (`Salma Mobile Homepage.dc.html`). **NEEDS CONFIRMATION** whether the reference design was exported into the repo.
- **Next action:** Obtain/confirm the canonical design reference; reconcile.
- **Dependencies:** Design source from owner.
- **Refs:** commit `91b86ed`; memory `project_salma.md`.

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
