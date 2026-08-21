# Salma Master Roadmap — Canonical Source of Truth

> **Read this roadmap before starting any substantial Salma task. Update it after every meaningful milestone. Never silently remove, forget, or redefine a postponed item.**

This is the permanent, canonical roadmap for the entire Salma project. It supersedes ad-hoc notes. When a fact cannot be established from the repository or a confirmed decision, it is marked **NEEDS CONFIRMATION** rather than guessed.

- **Last updated:** 2026-08-21 (full launch-readiness audit; repo + production verification at HEAD `291ced7`)
- **Product:** Salma — Arabic-first (RTL) health & treatment news platform for Kuwait/GCC public + healthcare professionals.
- **Stack:** Next.js 16 App Router, React 19, Supabase (`@supabase/ssr`), TailwindCSS v4. AI pipeline in Supabase Edge Functions (Deno). AI via OpenRouter. Discovery via Event Registry / NewsAPI.ai.
- **Production Supabase project ref:** `ukraltlejlfkqbcifgcq` (eu-central-1, free tier).
- **Repo:** `github.com:Bader-Sheshtari/salma.git`, single `main` branch.

## Status legend

| Status | Meaning |
|---|---|
| **DONE** | Implemented and in the deployed/committed state. |
| **IN PROGRESS** | Actively being worked; partially complete. |
| **NEXT** | Immediate priority, not yet started. |
| **LATER** | Planned but deliberately deferred. |
| **BLOCKED** | Cannot proceed until a dependency/decision clears. |
| **SUPERSEDED** | Design decision preserved for the record but replaced by a shipped system. |
| **NEEDS CONFIRMATION** | Not establishable from repo/production this session; verify before relying on it. |

Priority tiers: **P0** must fix before public/serious launch · **P1** complete around launch · **P2** post-launch/growth · **P3** advanced future.

---

# 1. Current Production State (verified 2026-08-21)

## 1.1 Editorial pipeline (the core of the product) — DONE, LIVE

```
Radar (Event Registry, medical + healthy-life intakes, multilingual)
  → radar-rank (dedupe + LLM priority scoring)
  → ESL: classification → event clustering → cross-language canonical clustering
        → already-covered protection → story-type-aware source selection
        → editorial scoring → diversity / daily balance → selected story
  → Primary Source Escalation (discovery source ≠ editorial source)
  → Evidence Intelligence (per-cluster Evidence Card → Writer constraints)
  → Writer → Editorial Director → Fidelity validation → constrained repair
  → Content PENDING → human editor review → human publish (only)
```

| System | Status | Evidence / commits |
|---|---|---|
| Radar global multilingual discovery (medical profile) | **DONE** | `radar-shadow` fn; cron `salma-radar-shadow` every 2h |
| Healthy-Life / Quality-of-Life intake (sleep, activity, nutrition, prevention, wellbeing, aging, family/everyday, travel, lifestyle medicine) | **DONE** | commit `06609cb`; cron `salma-radar-healthlife` 01:30/09:30/17:30 UTC |
| Radar ranking | **DONE** | `radar-rank` fn; cron `salma-radar-rank` every 2h at :10 |
| ESL V1 (cluster → score → balance → promote) | **DONE, LIVE** | commits `cd08e40`, `fa0bf68`; see 1.2 |
| Cross-language canonical clustering (language-scoped Event Registry IDs solved; Moderna/Merck melanoma vaccine 10 variants / 7 languages → 1 cluster validated) | **DONE** | commit `cb5fe48` |
| Primary Source Escalation (bounded, cached, story-type aware, provenance-preserving; validated: t5→science.org, recall→fda.gov, strong Nature→no search) | **DONE** | commit `424b54b`; `radar_source_escalation` sidecar |
| Evidence Intelligence V1 (study type, RCT vs observational, association vs causation, sample size, company-only claims, regulatory facts → Writer/Fidelity constraints; analysis source ≠ editorial primary provenance fix) | **DONE** | commits `578963d`, `291ced7`; `radar_evidence_intelligence` sidecar; admin EvidencePanel |
| Editorial Feedback Loop V1 (**observational only** — publish/reject/reason/title-body edit magnitude/category/source/image signals linked to ESL metadata; `/admin/editorial-feedback`) | **DONE** | commit `abf279d`; does NOT auto-tune anything |
| Writer + Editorial Director + Fidelity | **DONE — phase CLOSED** | in `ingest-news`; do not reopen without a repeated critical defect |

## 1.2 ESL operating model — verified 2026-08-21

- **Mode: LIVE** since 2026-08-21 ~14:50 UTC. The flip was a one-line production cron change (`run_esl('shadow')` → `run_esl('live')`) applied **out-of-band**; the repo migration `20260820010000_esl_cron.sql` still reads `'shadow'` — the repo is NOT the source of truth for the current cron command (see P1-8).
- **Schedule:** cron `salma-esl` 3 runs/day at 06/12/18 UTC.
- **Daily cap:** env `ESL_DAILY_CAP`, default **8 Content candidates total/day**; **stateful across the editorial day** (rebuilds day state + `promotedToday` from `radar_editorial_selection`; verified in `radar-editorial-select/index.ts`).
- **One real-world development = one editorial opportunity** (canonical clustering + cross-day already-covered protection over `ESL_HISTORY_DAYS`).
- **All output lands `pending`.** Promotion hardcodes `radar_publish_mode:"prepare"`; `DRAFT_STATUS="pending"`. **Never auto-publishes.** Verified: no cron path publishes; the only publish path is the admin one-click behind `requireAdmin()`.
- **Production verification this session (read-only, service-role REST):** live-mode selection rows exist from the 2026-08-20 cap=1 live test; content = 424 pending / 116 published / 0 rejected / 4 draft; anon API sees **published content only** (pending/draft blocked); ESL/escalation/evidence/feedback sidecar tables all blocked to anon (RLS fixes confirmed applied). First scheduled live run: 2026-08-21 18:00 UTC (after this audit's cutoff — **NEEDS CONFIRMATION** that it produced pending candidates as expected).

## 1.3 Legacy ingestion path

- Cron `salma-news-ingest` (every 6h) still fires but posts `{}`, which the pilot gate **rejects** — it is a **no-op burner** today. The ESL path is the real production pipeline. Cleanup: P1-9.
- Old **Priority Score v1** + **Source Universe** design tasks (pre-ESL WS10/WS5 plans): **SUPERSEDED** by ESL scoring/clustering and story-type-aware source selection (see §8 Preserved Decisions for the record).

---

# 2. P0 — Must Fix Before Public / Serious Launch

Genuine blockers only, from the 2026-08-21 audit. **P0-1/P0-2/P0-3 were fixed and verified in production on 2026-08-21** (security hardening pass); P0-4/P0-5/P0-6 remain open.

### P0-1 · Role escalation hole — **DONE (fixed + verified 2026-08-21)**
Was: `guard_profile_changes()` skipped the role-revert for any `is_admin()` caller, so a plain admin could `PATCH /rest/v1/profiles` on their own row → `super_admin`. **Fixed** by migration `20260821120000_fix_role_escalation_guard.sql` (applied to production): nobody may change their own `role`/`disabled`; only active super_admin/owner may change anyone's; owner-tier transitions are owner-only; super_admin manages only user/admin targets and can grant at most `admin` (mirrors `canManage`/`setAdminRole`); last-owner protections unchanged; violations now raise. Verified with 13 DB-level boundary tests (`scripts/security/role-guard-tests.sql`, self-rolling-back, all PASS): user/admin/super_admin self-promotion blocked, hierarchy enforced, service-role + owner + super_admin legitimate paths still work.

### P0-2 · Unauthenticated ESL + radar edge functions — **DONE (fixed + verified 2026-08-21)**
Was: `radar-editorial-select`, `radar-rank`, `radar-shadow` were callable with the public anon key; the ESL accepted caller `mode:"live"` and an unbounded `cap`. **Fixed:** all three now require the `x-ingest-secret` header matching `INGEST_SECRET` (the exact pattern `ingest-news` enforces), failing closed if the secret is unset; the cron SQL wrappers (`run_radar_shadow/healthlife/rank`, `run_esl`) read `app_config.cron_secret` and send it (migration `20260821130000_radar_cron_secret.sql`, applied before the function deploys — zero downtime); `verify_jwt=true` pinned in `config.toml` for radar-shadow + radar-editorial-select; ESL caller cap is clamped server-side to `ESL_DAILY_CAP` (default 8) — callers can only lower it (`radar-editorial-select/authz.ts`, 9 unit tests). Deployed: radar-shadow v3, radar-rank v6, radar-editorial-select v12. Verified live: anon invocations of all three → 401 (incl. `{"mode":"live","cap":9999}`); authorized shadow call with cap 9999 → response `cap:8` + stateful `cap_reached_for_today`; cron SQL wrappers invoke successfully with the secret.

### P0-3 · Public Supabase signup — **DONE at the DB layer; one manual dashboard toggle remains**
Was: production GoTrue reported `disable_signup:false`. **Fixed (defense in depth):** migration `20260821140000_block_public_signup.sql` (applied) adds a BEFORE INSERT trigger on `auth.users` rejecting any unconfirmed self-signup-shaped row; the manager `createAdmin` workflow (`email_confirm:true`) still works (verified: unconfirmed insert blocked, confirmed insert allowed). **Remaining manual step (owner):** also switch on "Disable new user signups" in the Supabase Auth dashboard — it is hosted config not reachable from SQL/MCP, so `/auth/v1/settings` still reports `disable_signup:false` until flipped; the DB trigger guarantees the boundary regardless.

### P0-4 · Zero legal / policy pages
No Privacy Policy, no Terms, no editorial standards page, no corrections policy, no standalone medical disclaimer, **no AI disclosure anywhere on the public site** — while the site collects emails (newsletter) and comments, and publishes AI-assisted health content (`ai_summary` box, AI pipeline). Footer mentions "المعايير التحريرية" as dead text, not a link. The medical disclaimer exists only buried in Contact body copy. **Launch minimum:** Privacy Policy, Terms, medical disclaimer page, AI-assisted-content disclosure, and a public editorial-standards + corrections page (credibility-critical for a health-news brand). Content drafting requires owner/legal input — flagged, not drafted.

### P0-5 · Production domain / `NEXT_PUBLIC_SITE_URL` unset
All absolute URLs (metadataBase, canonicals, OG/Twitter, sitemap, robots `Sitemap:`/`Host:`) flow from `NEXT_PUBLIC_SITE_URL` with fallback `http://localhost:3000` (`src/lib/site.ts`). The variable is in **neither** `.env.example` nor `.env.local`, and nothing validates it — if unset in Vercel, the whole site silently ships localhost SEO. Branded domain: **NEEDS CONFIRMATION** (no domain configured anywhere in repo; no `.vercel` link locally). **Fix:** choose/configure final domain, set the env var in Vercel, add a build-time guard, document it.

### P0-6 · No backup / restore capability
PITR intentionally disabled (preserved decision); **no backup scripts, no storage/media backup, no restore runbook, no restore drill ever performed**. `.env.example` documents ~1/3 of required secrets (missing `INGEST_SECRET`, `EVENTREGISTRY_API_KEY`, all `ESL_*` knobs, `app_config` rows) — **the production configuration exists only inside the Supabase dashboard and could not be rebuilt from documentation.** "Backup exists" ≠ "restore tested" — currently neither is true. **Fix:** enable a backup strategy (PITR or scheduled dumps + storage copy), write the secrets/rebuild inventory, and run one real restore drill.

---

# 3. P1 — Complete Around Launch

Ordered roughly by importance.

1. **Minimum viable monitoring** — today there is **zero** alerting; a crashed/stopped ESL leaves **no trace** (no run table, no top-level try/catch, `pg_net` response discarded; `radar_shadow_runs`/`radar_rank_runs` exist but no admin UI reads them). Minimum: (a) ESL run-level logging incl. failure rows, (b) one simple alert channel (email/webhook) for cron/edge failures, (c) a stale-pipeline ("no candidates today") check, (d) an admin health strip showing last run per cron. Not enterprise observability.
   **LIVE PROOF (incident, 2026-08-21) — `radar-rank` silently dead since ~08:10 UTC:** scheduled runs at 10:10/16:10 returned gateway **504** (function exceeds the request window on a growing backlog; ~595 unranked rows by 17:00, nothing ranked since 08:03, no run rows written, nobody alerted). Discovered only during the security-pass verification; **pre-dates and is unrelated to the security changes** (an authorized manual run passes the new auth and hits the same 504). Not fixed in the security session (out of scope — needs a bounded-work/chunked-run fix in radar-rank, e.g. smaller `MAX_PER_RUN`/translate budget per invocation or run-row-first accounting). **Treat as the immediate next operational fix together with this monitoring item.** ESL keeps running on already-ranked rows meanwhile.
2. **Security headers** — `next.config.ts` sets none (no CSP, no `X-Frame-Options` → admin is clickjackable, no HSTS/nosniff/Referrer-Policy). Cheap, high-value.
3. **Auth hardening pass (final)** — `changeOwnPassword` requires no current password (session theft = takeover); no password-reset-by-email flow (a locked-out **owner** has no in-app recovery); no MFA for admins; enable Supabase leaked-password protection if available on plan; `/admin/users` page is owner-only but its server actions accept `super_admin` (UI/policy mismatch — align deliberately). The long-standing "final authentication hardening at the end" decision — **this is now "the end."**
4. **Route-level error/empty states** — no `error.tsx`, `not-found.tsx`, `global-error.tsx`, or `loading.tsx` anywhere; 8 `notFound()` call sites dead-end on Next's unstyled English LTR default page. Add branded Arabic RTL 404/error pages.
5. **Full launch QA pass** — never performed end-to-end. Scope: reader (home/category/article/video, Arabic RTL, mobile+desktop, images, sharing, SEO metadata, broken links, loading/error/empty), admin (login, roles, create/edit/reject+reason/publish/unpublish/delete, categories, images, attribution, feedback surface, Evidence Card, Radar, ESL-generated content), pipeline (Radar→ESL→escalation→evidence→Writer→Fidelity→PENDING→human publish). ~491 unit tests exist (pure logic only) but there's **no `npm test` script and no CI** — wire both.
6. **Newsletter honesty fix** — homepage runs a prominent newsletter CTA, but capture is a dead end: no consent text, no double opt-in, no unsubscribe, no admin subscriber view, no sender. Around launch either (a) add consent text + admin list view + unsubscribe path, or (b) hide the CTA until the real newsletter ships (P2). Collecting emails with zero privacy text is also a P0-4 dependency.
7. **Comment/ratings/newsletter anti-spam** — anon inserts are unthrottled (`with check (true)`); moderation queue is floodable. Add rate limiting + honeypot (CAPTCHA optional).
8. **Repo/production drift reconciliation** — commit a migration reflecting the live ESL cron (`run_esl('live')`) so the repo is the source of truth again; same for any other out-of-band prod changes.
9. **Legacy cleanup** — retire or repurpose the no-op `salma-news-ingest` cron (fires 4×/day, rejected by pilot gate); reconcile local migration filenames vs applied remote versions; note the `ingest-news` publish branch is **default-on** (`radar_publish_mode` defaults to `"publish"`) and only ESL's hardcoded `"prepare"` prevents auto-publish — flip the default to `"prepare"` for structural safety.
10. **Basic reader analytics** — currently none (no Vercel Analytics/GA/Plausible/anything). Pick a privacy-respecting option and install before launch so day-one traffic isn't lost. Richer product analytics = P2.
11. **Editorial governance docs** — written editorial SOP: who reviews, review checklist (Evidence Card usage), corrections/updates/retractions procedure, breaking-news standard, sourcing/attribution/quotation rules, news-vs-guidance distinction, human-review requirement (already enforced technically). Public-facing versions belong to P0-4; this item is the internal operating doc.
12. **SEO completeness** — JSON-LD exists for article/video (`src/lib/seo.ts`, NewsArticle/VideoObject + citations — good) but: no Organization/WebSite JSON-LD on home; category/doctor pages lack canonical+description+OG; sitemap omits `/about`, `/contact`, `/doctors`, `/transfers`. Small fixes.
13. **Doctors section data** — `doctors` table is **empty in production** (0 rows) while public `/doctors` + `/transfers` pages ship. Populate or hide for launch.

---

# 4. P2 — Post-Launch / Growth

| Item | Status | Notes |
|---|---|---|
| **Newsletter (full)** | LATER | Delivery provider, templates, double opt-in, subscriber management UI, sending workflow, analytics, automation. Schema today is 3 columns (email/id/created_at) — needs consent/status/token columns. |
| **Comments upgrades** | LATER | Core flow is DONE (public submit → forced `pending` → admin approve/reject/delete → approved-only render). Remaining: scale moderation, abuse handling beyond P1 rate-limiting, possible identified comments. |
| **Reader/product analytics (rich)** | LATER | Engagement, reading behavior, traffic sources, article/category performance, newsletter conversion, retention. Distinct from the shipped editorial-feedback analytics. |
| **Research / Studies section (public)** | LATER | Does NOT exist (no route). Distinct from Evidence Intelligence (editor-facing). Note: `study` content type is advertised in search copy but the DB CHECK constraint doesn't allow it — unreachable; fix constraint or copy when building this. |
| **Social Q&A** | LATER (preserved postponement) | Schema exists (`social_questions`/`social_answers`); no UI. |
| **Kuwait / GCC dedicated intelligence (Radar V1.2)** | LATER | Dedicated intake for Kuwait/Saudi/UAE/Qatar/Bahrain/Oman ministries, regulators, hospitals, companies, investments. Planned as next Radar profile after launch stabilizes. |
| **ESL supply improvements (V1.3)** | LATER | Residual tier-5 share is a supply problem → needs strong-source discovery; L5 research-vs-guidance split refinement. |
| **Sharing extensions** | LATER | Current: WhatsApp, email, native share, copy link. Consider X/Telegram/Facebook. |
| **Evergreen Editorial Planner** | LATER | Non-breaking magazine-style planning (sleep, nutrition, exercise, prevention, QoL explainers). Distinct from Healthy-Life NEWS discovery. |
| **Ads / monetization** | LATER | Placements, commercial policy, sponsored-content labeling, model. Requires editorial-trust alignment + legal (see §6). |
| **Design polish backlog** | LATER | Deferred Apple-design items: translucent header, hero swipe (Embla), ticker replacement concept. Apple-design polish phase itself is DONE (commit `67c3c7e`) — do not reopen. |
| **Editorial audit persistence** | LATER | Persist Editorial Director/fidelity audit verdicts queryably (currently observability-only). |
| **Search scale** | LATER | Search is good (Arabic-aware normalization + fuzzy) but fetches the whole published corpus per query — fine now, needs pagination/caching at scale. |

---

# 5. P3 — Advanced Future Intelligence

Preserve; do **not** build before launch. We already have substantial AI infrastructure — additions must earn their place.

1. **Direct Authoritative Source Network** — direct discovery monitoring of FDA, EMA, WHO, CDC, SFDA, GCC ministries, PubMed, ClinicalTrials.gov, NEJM/Lancet/JAMA/BMJ/Nature, pharma newsrooms, major institutions. **Distinct from Primary Source Escalation** (which upgrades sources *after* discovery; the feed network would BE discovery). Not built.
2. **Story Intelligence** — evolving-story understanding (trial → submission → approval → launch → safety update as one thread).
3. **AI Editorial Director (planning)** — higher-level daily mix/planning recommendations. NOT the existing Editorial Director writing stage.
4. **Personalization** — reader-interest personalization.
5. **Health Knowledge Graph** — entity graph (companies, drugs, diseases, studies, trials, hospitals, regulators, people, countries, Salma stories).
6. **Feedback Loop → tuning** — the Feedback Loop stays observational; any future automated tuning of ESL/weights/prompts is a deliberate, separate decision.

---

# 6. Deferred / Requires Business or Legal Decision

| Item | Status | Gate |
|---|---|---|
| **Doctor ratings (public reliance)** | BLOCKED | Legal + commercial sign-off. Schema + admin moderation + public display exist; do not promote publicly until cleared. |
| **Medical Profiles** | LATER (preserved postponement) | Wait until 2–3 real stories validate the format. |
| **PITR re-enablement / paid tier** | Owner decision | Currently free tier, PITR off — interacts with P0-6. |
| **Monetization model** | Owner decision | See P2. |
| **Branded domain choice** | Owner decision | Blocks parts of P0-5. |

---

# 7. Platform Foundations (verified DONE — reference)

Condensed record of completed workstreams; details live in git history.

- **Core platform & admin** — public site (home, article, category, video, doctors, transfers, search, about, contact); admin dashboard (content, categories, comments, doctors, departments, transfers, homepage, users, ingest, radar, synthesize, editorial-feedback); content statuses draft/pending/approved/published/rejected; human review workflow (AI badge, source-first review panel, admin-only preview, explicit Reject **with 10-code reason taxonomy** — the earlier silently-broken Reject constraint was fixed in the Feedback Loop work).
- **Roles** — `user`/`admin`/`super_admin`/`owner` ("manager" = super_admin+owner concept). Server-side enforcement is solid: every admin server action calls `requireAdmin()` first; no unguarded API routes; service-role key is `server-only` (no client-bundle exposure); all 30 tables have RLS; owner tier protected at DB level (last-owner demote/disable/delete blocked). Known holes are P0-1/P0-3 and P1-3 items. RLS gap window on ESL sidecars (created 08-20 without RLS, fixed 08-21) — production now verified blocked to anon.
- **Legacy ingestion foundation** — `ingest-news` v27-era pipeline, source registry, dedupe, trusted-source enforcement, writer audits; strongest failure handling in the stack (mandatory audit, rollback of orphaned drafts).
- **SEO & sharing core** — sitemap, robots, OG images (article+video), ShareBar, JSON-LD NewsArticle/VideoObject with citations. Gaps → P1-12.
- **Doctor transfers** — public page + admin CRUD + secured private source (manager-only).
- **In Brief «باختصار»** — authored summary field → rendered box. Intact.
- **Breaking ticker** — `is_breaking` → homepage marquee. Intact.
- **Video** — `/video/[slug]`, homepage lane, VideoObject JSON-LD. Intact.
- **Comments** — full moderation loop. Intact (anti-spam → P1-7).
- **Design system** — Tailwind v4 tokens, Apple-design browser-platform polish phase CLOSED (commit `67c3c7e`).
- **AI stack** — Writer (+ profile routing, factual validator), Editorial Director, Fidelity + constrained repair (CLOSED); Radar; ESL V1; cross-language clustering; Source Escalation; Evidence Intelligence; Feedback Loop (see §1.1).

---

# 8. Preserved Decisions (do not remove or silently override)

1. **Never auto-publish AI content** — all AI output stays `pending` for explicit human review. (Enforced; keep the P1-9 default-flip for structural safety.)
2. **Feedback Loop is observational only** — no automated tuning of ESL/weights/prompts/ranking/publishing without a new explicit decision.
3. **Medical Profiles postponed** until 2–3 real stories validate the format.
4. **Social Q&A UI postponed** (schema exists).
5. **Doctor ratings require legal + commercial sign-off** before public reliance.
6. **Final authentication hardening postponed to the end** — now due (P0-1/P0-3/P1-3).
7. **PITR intentionally disabled for now** — revisit at launch (P0-6).
8. **Do not remove postponed ideas** from this roadmap.
9. **Writer/Editorial Director/Fidelity implementation phase CLOSED** — reopen only for a repeated critical defect; tuning driven by real review findings only.
10. **ESL daily cap = 8, 3 runs/day, stateful, one development = one opportunity** — operating contract of ESL V1.
11. **Historical (SUPERSEDED by ESL, kept for the record):** Priority Score v1 formula (0.60 IMPACT + 0.15 AUTHORITY + 0.15 RELEVANCE + 0.10 BREADTH − PR penalty; unrankable = never selected; recency tie-break only) and the Source Universe classification task — both replaced by ESL's editorial scoring, story-type taxonomy, and story-type-aware source selection (commits `cd08e40`, `fa0bf68`). The "one Writer slot, fetch-failure doesn't consume it" principle carried into ESL promotion design.
12. **Rollback references:** tag `stable/pre-editorial-pilot` → `c69d7f5` exists locally and on origin; `ingest-news` v26 = commit `0ee4ca7`.

---

# 9. Changelog

| Date | Change |
|---|---|
| 2026-08-05 | Roadmap created; Editorial Director deployed (v23); comments/In-Brief/breaking/video revalidated DONE. |
| 2026-08-10 | Pipeline v27 live; BBC end-to-end pilot success closed the implementation-validation phase; human review workflow shipped (`556965b`); Priority Score v1 + Source Universe designs approved (later superseded by ESL). |
| 2026-08-19 | Apple-design browser-platform polish phase CLOSED (`67c3c7e`). |
| 2026-08-20 | **ESL V1 shipped** (`cd08e40`), editorial tuning (`fa0bf68`), cross-language canonical clustering (`cb5fe48`); shadow-validated on real 581-article pool; one live cap=1 test → Content PENDING. |
| 2026-08-21 | **Healthy-Life intake** (`06609cb`), **Primary Source Escalation V1** (`424b54b`), **Editorial Feedback Loop V1** (`abf279d`, incl. Reject-constraint fix + ESL sidecar RLS fix), **Evidence Intelligence V1** (`578963d`) + provenance fix (`291ced7`). **ESL flipped SHADOW → LIVE** (~14:50 UTC, production cron change, out-of-band of repo). |
| 2026-08-21 | **Full launch-readiness audit** (this update): verified production state read-only (content counts, anon RLS behavior, auth settings, live-mode ESL rows); rewrote roadmap around P0–P3; recorded security findings (admin self-promotion hole, anon-invokable ESL/radar functions, public signup enabled), legal-pages absence, backup/monitoring absence, `NEXT_PUBLIC_SITE_URL` risk. Old WS10/WS5 designs marked SUPERSEDED. **No fixes applied in the audit session.** |
| 2026-08-21 | **P0 security hardening pass — P0-1/P0-2/P0-3 fixed and verified in production.** Migrations `20260821120000` (role-escalation guard rewrite), `20260821130000` (radar/ESL cron wrappers send `x-ingest-secret`), `20260821140000` (DB-level public-signup block) applied; radar-shadow v3 / radar-rank v6 / radar-editorial-select v12 deployed with in-code secret auth + server-side cap clamp (`authz.ts`); `verify_jwt` pinned in config.toml. 13 DB boundary tests PASS (rolled back); anon probes → 401; authorized cap-9999 call clamped to 8. ESL remains LIVE (cron `run_esl('live')` unchanged), cap 8, pending-only. Remaining manual: dashboard "Disable new user signups" toggle. No Radar/ESL scoring, editorial logic, or product behavior changed. |

---

# 10. Open Items — NEEDS CONFIRMATION

- First scheduled **live** ESL run (2026-08-21 18:00 UTC) produced pending candidates as expected.
- Whether any anon writes landed on `radar_editorial_selection` / `radar_source_escalation` during the 08-20 → 08-21 RLS gap window.
- Vercel production env: is `NEXT_PUBLIC_SITE_URL` set at all today? Which Vercel project/domain serves production?
- Supabase Auth plan features available on free tier (leaked-password protection, MFA options) for P1-3.
- Owner decision: branded domain; PITR/paid tier; newsletter CTA keep-or-hide at launch.
- Whether the reference homepage design export (`design/design_reference.html`) still matches the shipped homepage (low priority).
