# SALMA Homepage Specification — Existing Baseline (Pre-Redesign)

**Revision:** 2 — 2026-11-21 (adds the Redesign Charter §0, the functional/visual separation, and live production verification §8; Rev 1 was 2026-11-21 initial draft).
**Status:** APPROVED by the owner on 2026-11-21 — this is the agreed baseline for the Homepage redesign. Changes after this point must be explicit and dated.
**Scope:** Public homepage (`/`) only. The Admin Dashboard, backend, and all other pages are strictly out of the redesign scope and must not be modified.

**Evidence legend** — every statement is tagged with its provenance:

- `[INSTRUCTION]` — a confirmed previous instruction or approved decision, with its source (doc section, commit, or the owner's Refactor brief).
- `[CODE]` — current implementation discovered in the codebase, with file and line references.
- `[VERIFIED-PROD]` — behavior confirmed on the live production homepage (https://salma-azure.vercel.app) on 2026-11-21; see §8.
- `[UNVERIFIED]` — an assumption, a gap, or something whose origin cannot be verified from accessible history or documentation.

**Binding legend** — per the Redesign Charter (§0), every requirement is additionally classified:

- `[FUNCTIONAL — BINDING]` — existing functionality that must be preserved unless the owner explicitly approves a change.
- `[VISUAL — HISTORICAL]` — an old visual/design decision, documented for the record but NOT binding on the redesign.

**Sources reviewed:** `docs/SALMA_NORTH_STAR.md` (V2, 2026-10-15), `docs/SALMA_MASTER_ROADMAP.md`, `PRD.rtf`, `Refactor 1.rtf` (untracked owner brief, July 2026), `README.md`, `design/design_reference.html`, `design/Salma Mobile Homepage.html` (byte-identical mock), full git history of the homepage files, the source under `src/`, and the live production homepage (§8).

---

## 0. Redesign Charter — Owner decisions, 2026-11-21

These decisions were given by the owner on 2026-11-21 when commissioning this baseline. They govern how the rest of this document is read.

- **C1 — Functional vs. visual separation.** Existing functional requirements and old visual design decisions are documented separately. Functional behavior is binding; old visuals are historical reference.
- **C2 — Functionality is preserved by default.** ALL existing homepage functionality — including the breaking-news ticker, the hero slider, the dynamic sections engine, and every admin-controlled setting — must be preserved unless the owner explicitly approves a change. The binding list is §6-A.
- **C3 — Old visual identity does not restrict the redesign.** Previous instructions requiring preservation of the old colors, typography, layout, or visual identity (notably the Refactor brief's "keep existing design" rule, and the design mock) are **superseded for the purposes of the redesign**. A new official logo, color palette, and fonts will be introduced. This activates North Star §17's provision that final branding would be applied later; it does not contradict the North Star. Old visual values remain documented in §4 as historical reference.
- **C4 — Open items stay open.** All nine discrepancies (D1–D9) and seven unverified items (U1–U7) in §7 remain documented. None of them is to be automatically implemented, removed, or resolved; each awaits an explicit owner decision. Verification notes added in Rev 2 record facts only — they do not close any item.
- **C5 — Scope.** The redesign covers strictly the public Homepage. The Admin Dashboard, backend, and other pages are untouched. No website code is changed or deployed during the documentation/design phase.

---

## 1. Homepage Structure

Render order of the page `[CODE]` `[VERIFIED-PROD]`:

| # | Block | Component | Notes |
|---|-------|-----------|-------|
| 0 | Header (sticky) | `src/components/site/Header.tsx` | Rendered by `src/app/page.tsx:8-20`, outside `<main>` |
| 1 | Breaking-news ticker | `src/components/site/BreakingTicker.tsx` | First child of HomeView; hidden when no breaking items |
| 2 | Hero search box | `src/components/site/SearchBox.tsx` (variant `hero`) | `HomeView.tsx:28-31` |
| 3 | Hero slider + secondary column | `src/components/site/RotatingHero.tsx` | `HomeView.tsx:33-47`; hidden when hero pool empty |
| 4 | Feed-prompt CTA card | inline in `HomeView.tsx:49-63` | «خلاصتك تبدأ من هنا» → `#newsletter` |
| 5 | Video lane «فيديو وتبسيط طبي» | `HomeSection`/`Section` rail + `VideoCard` | `HomeView.tsx:66-68`; hidden when no videos |
| 6 | Dynamic sections (admin-ordered) | `src/components/site/HomeSection.tsx` | From `homepage_sections` table, `sort_order`, enabled only |
| 7 | Mission block «لماذا سلمى» | inline in `HomeView.tsx:81-93` | Static text |
| 8 | Newsletter signup (`id="newsletter"`) | `NewsletterForm` | `HomeView.tsx:95-104` |
| 9 | Footer | `src/components/site/Footer.tsx` | `page.tsx:17` |

- Page shell: `src/app/page.tsx:12` — centered content column `max-w-6xl` (1152px), `min-h-screen`. `[CODE]` (column styling itself: `[VISUAL — HISTORICAL]`; the single-column IA: structure)
- Rendering model: ISR with `revalidate = 60` (`page.tsx:6`); data fetched server-side via `getHomepage()` + `getCategories()` in parallel. `[CODE]` `[FUNCTIONAL — BINDING]`
- `<html lang="ar" dir="rtl">` — `src/app/layout.tsx:62-64`. `[CODE]` `[FUNCTIONAL — BINDING]`
- The homepage has **no `<h1>`** (hero titles are `h2`; section titles are `<div>`s) and **no JSON-LD** — see §7. `[CODE]`

---

## 2. Previously Approved Requirements

### 2.1 Strategic requirements (North Star V2, 2026-10-15) — all `[FUNCTIONAL — BINDING]` principles

- The website is the **authoritative record**; Instagram is where growth happens. The homepage is judged on its own editorial merit, not as a copy of Instagram. — §2 `[INSTRUCTION]`
- Trust outranks revenue; paid/sponsored content must stay clearly labeled and distinguishable from editorial. — §8 `[INSTRUCTION]`
- Every major homepage feature must pass the 5-question product decision test (§12). — `[INSTRUCTION]`
- Output must be clean, concise, elegant, easy to consume; the benchmark is global quality. — §14 `[INSTRUCTION]`
- **Final branding was intentionally unsettled** (§17); the owner has now decided (Charter C3) that the redesign introduces the new official logo, palette, and fonts. The §17 requirement that survives is structural: build so branding can be changed without structural rework. — `[INSTRUCTION]`
- Near-term emphasis is content formats and distribution, "rather than adding website features for their own sake". — §13 `[INSTRUCTION]`

### 2.2 The owner's Refactor brief (`Refactor 1.rtf`, repo root, untracked, July 2026)

An owner-written instruction document addressed to the coding agent. Split per Charter C1:

**Functional instructions `[FUNCTIONAL — BINDING]` (as functionality; their visual treatment is open):**

- **S3 — Doctor transfers on the homepage:** carousel/lane of latest transfers; mobile swipe; «عرض الكل» → dedicated page with search, specialty filter, pagination. Card fields: photo, name, specialty, «انتقل من» → «انتقل إلى», published date+time, short summary, read more. — `[INSTRUCTION]` (see D5)
- **S4 — Dynamic section placement:** every section placed and controlled from admin (not hardcoded): show/hide, homepage title, order, item count, display style (carousel | grid | list | featured card), «عرض الكل» toggle, highlight latest/featured, optional accent. — `[INSTRUCTION]`
- **S5 — Date + time under every item** (e.g. «نُشر في 1 يوليو 2026 - 3:45 مساءً») and source/credit on items. — `[INSTRUCTION]` (see D3)
- **S9 — Social/community section «المساحة الاجتماعية»**: active question, guest answers (optional name, no login), admin moderation. — `[INSTRUCTION]` (not implemented — D4)
- **S10 — Homepage search with Arabic-aware fuzzy matching** (normalization أ/إ/ا، ة/ه، ي/ى; typo tolerance; mixed Arabic/English) over title/body/summary/category/doctor/specialty/source. — `[INSTRUCTION]`
- **S11 — Sharing:** WhatsApp, copy link, email, native share; required on full pages, optional on cards. — `[INSTRUCTION]`
- **S15 (functional part) — Homepage composition:** search near the top; dynamic sections from admin settings; transfers lane; social question area; latest/featured per visible section with «عرض الكل»; date/time on items. — `[INSTRUCTION]`

**Visual instructions `[VISUAL — HISTORICAL]` — superseded for the redesign by Charter C3:**

- "Keep existing homepage structure and design; reuse existing theme colors, typography, spacing, card style, gradients, layout language; no new brand direction." — **superseded by C3.**
- S8 — all input boxes white, existing-theme focus color. The *accessible, RTL-correct, mobile-correct input* requirement survives as functional; the specific white/old-theme styling does not.
- S3's "visually important, not hidden" treatment and the mock's signature-block styling — the *prominence intent* carries into the redesign as a design goal, the old styling does not.
- S15's "do not make the homepage crowded: generous spacing, premium cards, visually separated sections" — carries forward as a design *principle* for the new design (consistent with North Star §14), not as the old pixel values.

### 2.3 Decisions recorded in git history

Functional decisions `[FUNCTIONAL — BINDING]` unless noted:

| Date | Commit | Approved behavior |
|------|--------|-------------------|
| 2026-07-01 | `2196811` | Homepage sections driven by `homepage_sections` table (sort order, display style, item limit, view-all); fixed chrome (breaking, hero, feed prompt, video, mission, newsletter) stays put |
| 2026-07-01 | `709c634` | Exact-position section ordering from admin; the short-lived «أقسام سلمى» grid (added `7a44521`) removed |
| 2026-07-01 | `1598bca` | Admin picks the main hero article; footer links to /about and /contact; newsletter form functional |
| 2026-07-03 | `5a68928` | Header nav driven by admin-managed categories (`show_in_nav`); nav never hardcoded |
| 2026-07-03 | `19af62f` | Explicit per-section visibility control (ظاهر/مخفي) |
| 2026-07-05 | `ba61343` | Auto-rotating hero pool (pauses on hover/focus, dots, reduced-motion aware); drag-and-drop section reordering. *(The «coral ticker» color in this commit is visual-historical; the ticker behavior is functional.)* |
| 2026-07-06 | `7c78141` | Cards fall back to YouTube thumbnail; video lane tied to type فيديو |
| 2026-07-07 | `74e8443` | Arabic-aware site search; homepage search box |
| 2026-08-19 | `67c3c7e` | Apple-design polish, phase closed: ≥44px hit targets, press feedback, ticker pause on hover/focus, reduced-motion marquee→plain scroller. *(The accessibility/motion standards are functional-binding; the specific aesthetic is visual-historical. The roadmap's "do not reopen" applies to re-doing that polish effort, not to restyling in the redesign.)* |
| 2026-08-22 | `9512241` | Footer trust-links row (corrections, privacy, terms) + editorial-policy link |
| 2026-10-05 | `706eb8b` | Honest wording on the newsletter CTA |
| 2026-10-11 | `4bf9b30` | Launch hardening: doctors nav + sitemap entries hidden (restorable); branded 404/error pages; form honeypots/rate limits; CSP + security headers |

### 2.4 Roadmap statuses relevant to the homepage `[INSTRUCTION]`

- Breaking ticker (`is_breaking` → marquee), video lane, In Brief box: shipped, marked **Intact**. `[FUNCTIONAL — BINDING]`
- Deferred (not cancelled) design backlog: translucent header, hero swipe (Embla), ticker replacement concept — these remain open *inputs* to the redesign, not commitments.
- Open items: homepage JSON-LD missing (P1 #12); homepage QA on RTL mobile/desktop incl. loading/error/empty states (§8.B P1 #5); production domain / `NEXT_PUBLIC_SITE_URL` affects canonical+OG.

### 2.5 PRD.rtf

Generic early template (titled "Wealth — PRD"); **no homepage requirements**. Product-wide: credible simplified Arabic health news; search results within 3 seconds with helpful empty states. Superseded by the Refactor brief and North Star. `[UNVERIFIED]` whether the search-latency target was re-approved.

---

## 3. Existing Functional Behaviors — `[FUNCTIONAL — BINDING]` per Charter C2

Everything in this section is current behavior that the redesign must preserve unless the owner explicitly approves a change. Visual values that happen to appear (sizes, colors) are cited for traceability only and are NOT binding (§4 governs visuals).

### 3.1 Data pipeline (`src/lib/queries.ts`, `getHomepage`)

- Breaking items: `is_breaking = true`, published, not deleted, newest first, limit 8 (`queries.ts:75`). Not deduped against the hero. `[CODE]`
- Hero pool: 1 admin-featured item (`is_featured`, latest; `queries.ts:73`) + latest non-video articles (limit 6; `queries.ts:74`), deduped, capped at 5 (`queries.ts:87-97`). Videos excluded. `[CODE]` `[VERIFIED-PROD: 5 slides live]`
- Videos: `type = video`, published, newest first, limit 6 (`queries.ts:76`). `[CODE]`
- Sections: `homepage_sections` where `is_enabled`, ordered by `sort_order` (`queries.ts:77-81`). Only `kind=category` and `feature:doctor_transfers` resolve; `feature:social` is silently skipped (`queries.ts:99-100,115`). `[CODE]`
- Category section content: published, not deleted, category match, newest first, limit = `items_limit`, hero id excluded; empty sections dropped. `[CODE]`
- Transfers: `doctor_transfers` published, not deleted, newest first (`queries.ts:516-528`). `[CODE]`

### 3.2 Header (`Header.tsx`)

- Sticky at top; the ticker is NOT inside it and scrolls away. `[CODE]` `[VERIFIED-PROD]`
- Logo links to `/`; search entry → `/search` (aria-label «بحث»); «اشتراك» → `#newsletter`. `[CODE]`
- Nav: horizontal scroll rail at ALL widths — no hamburger, no dropdowns. `[CODE]` `[VERIFIED-PROD: rail overflows and scrolls at 375px; no hamburger]`
- Nav order: «الرئيسية» → `/`; categories with `show_in_nav` by `sort_order`; «انتقال الأطباء» → `/transfers`. Doctors entry hidden with restore note (`4bf9b30`). `[CODE]` + `[INSTRUCTION]`

### 3.3 Breaking-news ticker (`BreakingTicker.tsx`)

- Hidden when no breaking items. `[CODE]`
- Fixed «عاجل» label block with pulsing dot + continuously scrolling headline marquee. `[CODE]` `[VERIFIED-PROD: 4 live breaking items]`
- Animation: pure CSS marquee, `salmaMarquee` `translateX(0→50%)`, **30s linear infinite**; items duplicated for a seamless loop. `[CODE]` `[VERIFIED-PROD: computed animation `salmaMarquee 30s linear infinite`]`
- **Direction (verified):** the track moves **rightward** at ≈52 px/s (measured +104px over 2s on production) — headlines enter from the left and exit right, i.e. the reading flow for RTL text. `[VERIFIED-PROD]`
- Pause on hover (hover-capable devices) and focus-within; reduced motion disables marquee+pulse and turns the rail into a plain horizontal scroller (`globals.css:209-231`; decision `67c3c7e`). `[CODE]` + `[INSTRUCTION]`
- Each headline links to its article/video. `[CODE]`

### 3.4 Hero slider (`RotatingHero.tsx`)

- Auto-rotation interval **6500ms** (`ROTATE_MS`, `:9`); runs only with >1 slide, not paused, and NOT under `prefers-reduced-motion` (reduced-motion users get a static first slide). `[CODE]` `[VERIFIED-PROD: slide advanced exactly once within a 7s window; 5 slides, 5 dots]`
- Pauses on mouse enter and focus-capture; resumes on leave/blur; dot click does not reset the timer. `[CODE]` (decision `ba61343`)
- Transition: cross-fade, 700ms ease-in-out; inactive slides non-interactive (`aria-hidden`, `tabIndex -1`, `pointer-events-none`). `[CODE]`
- Controls: dots only (44px hit rows, aria-label «الخبر رقم N», hidden when one slide); no arrows, no swipe. `[CODE]`
- Each slide: whole-card link, «الأبرز» badge, title + relative Arabic date. `[CODE]` `[VERIFIED-PROD]`
- Desktop: hero (2/3) + secondary column of up to 3 ListRow items from the first content section, hero ids excluded; stacked below `lg`. `[CODE]` `[VERIFIED-PROD: 1-column stack at 375px]`
- Fallbacks when the pool is empty; section hidden when nothing resolves. `[CODE]`

### 3.5 Dynamic sections engine (`HomeSection.tsx`, `Section.tsx`)

- Admin-controlled per section: enabled/hidden, exact order, title, item limit, display style, «عرض الكل» toggle, accent. `[CODE]` + `[INSTRUCTION S4]`
- Four display styles (carousel / grid / list / featured) + the transfers lane override; rails scroll horizontally on mobile and become grids at `sm`+. `[CODE]` `[VERIFIED-PROD: rails scroll at 375px]`
- «عرض الكل» targets: category → `/category/{slug}`; transfers → `/transfers`. `[CODE]`
- Seed defaults exist (migration `20260701153554`) but live values are admin-managed; the live section lineup is in §8. `[CODE]` `[VERIFIED-PROD]`

### 3.6 Fixed chrome blocks

- **Video lane** «فيديو وتبسيط طبي» — only when videos exist. `[CODE]` `[VERIFIED-PROD]`
- **Feed-prompt CTA** «خلاصتك تبدأ من هنا» → `#newsletter`. `[CODE]` `[VERIFIED-PROD — live copy: «سجّل بريدك الآن — وستصلك نشرة سلمى عند انطلاقها: أخبار، فيديو، تحقيقات.»]`
- **Mission block** «لماذا سلمى · WHY SALMA» — static copy. `[CODE]` `[VERIFIED-PROD]`
- **Newsletter**: required email, honeypot field, server action (`source="homepage"`), success/already-subscribed states, optional audience survey, privacy link, honest wording (`706eb8b`). `[CODE]` + `[INSTRUCTION]`
- **Search box** (hero variant): `<form role="search">` GET → `/search?q=…`. `[CODE]` + `[INSTRUCTION S8/S10]`
- **Footer**: category links (currently the unfiltered list — D8), «من نحن», «اتصل بنا», «المعايير التحريرية», sources line, trust row (corrections/privacy/terms), copyright. `[CODE]` (trust row `9512241`)

### 3.7 News cards (`cards.tsx`, `HotImg.tsx`, `TransferCard.tsx`)

- Image source: `cover_image_url` else YouTube thumbnail (`7c78141`); three-stage fallback (next/image for Supabase Storage → plain img with self-removal on error → hatched placeholder). `[CODE]`
- Whole card links to `/article/{slug}` or `/video/{slug}`. `[CODE]`
- **ContentCard** meta: read time only — no date, no category, no source (D3). **ListRow/featured/hero** meta: relative Arabic time. **TransferCard**: name, specialty, من/إلى strip, absolute date «نُشر في …». `[CODE]` `[VERIFIED-PROD: transfers show «نُشر في 7 نوفمبر 2026» format; article cards show «N دقائق قراءة»]`
- Titles/excerpts not line-clamped on the homepage (only search results clamp). `[CODE]`
- Alt texts generic («صورة», «صورة رئيسية», «فيديو»). `[CODE]`

### 3.8 SEO / analytics / platform

- Homepage inherits layout metadata (title «سلمى · SALMA — أخبار صحية موثوقة», OG website/ar_AR); no OG image, no canonical, no JSON-LD (open P1 #12). `[CODE]`
- `robots.ts` allows `/`, disallows `/admin`, `/api`; sitemap lists `/` hourly, priority 1. `[CODE]`
- Homepage analytics: `NavTracker` only (sessionStorage paths); `ReaderAnalytics` is on article/video pages. `[CODE]`
- CSP + security headers (`4bf9b30`). `[CODE]` + `[INSTRUCTION]`

---

## 4. Design and Visual Rules — `[VISUAL — HISTORICAL]` per Charter C3

> **Everything in this section documents the OLD look.** It is preserved as the record of what exists today and as reference for the redesign; none of it binds the new design. A new official logo, color palette, and fonts will be introduced (Charter C3). The *functional* aspects embedded here — reduced-motion behavior, hit-target sizes, touch input sizing — are binding and are also listed in §6-A.

### 4.1 Current fonts

IBM Plex Sans Arabic (400/500/600/700), IBM Plex Sans, IBM Plex Mono via `next/font/google` (`layout.tsx:7-23`); `font-synthesis: none`. **To be replaced by the new official fonts.**

### 4.2 Current color tokens (`globals.css:4-31`, Tailwind v4 `@theme inline`; no `tailwind.config.*`)

teal `#3a7c6c` (brand/primary), green `#449785`, coral `#e99e8e` (ticker bar), ink `#2e2e2d`, gold `#e7ceb5`, cream `#f7efe6`, sand `#e6dccd` (page bg), gray `#616261`, line `#ece4d8` (borders), plus unused blue `#5496cf`, cyan `#68bbca`, navy `#0f2230`. **To be replaced by the new official palette.** (Detailed per-element usage is preserved in the Rev 1 record via git history of this file.)

### 4.3 Current typography scale

Wordmark 20→24px; nav 13.5px; ticker 13px; hero title 18→24px; section titles 17→18px; card titles 13.5–15px; metas 11–11.5px; `text-wrap: balance` on headings.

### 4.4 Current layout and spacing

1152px white column on sand; gutters 16/24px; section padding ~20px; aspect ratios hero 16/10, grid cards 16/10, featured 16/9, video 16/9, transfer 4/5; anchor offset 96px.

### 4.5 Current motion values

Ticker 30s linear; pulse 1.1s; hero fade 700ms; cover zoom 1.03/300ms; press feedback (links opacity 0.8, buttons scale 0.97/100ms). *(The reduced-motion and hit-target behaviors tied to these are functional — §6-A.)*

### 4.6 Dark mode

None; `color-scheme: light` forced. (Whether the redesign adds dark mode is an open design decision.)

### 4.7 Design-reference mock (`design/design_reference.html` ≡ «Salma Mobile Homepage.html»)

Fixed-412px RTL mock, reference only, already diverged from production (ticker colors inverted, 22s vs 30s marquee, several never-built blocks — D9). With Charter C3 it is fully historical.

### 4.8 Current logo treatment

Teal rounded square «س» + wordmark «سلمى» + "SALMA · HEALTH" sub-label. **To be replaced by the new official logo.**

---

## 5. Responsive Requirements

Current responsive *behavior* (functional pattern binding per C2; the specific visual metrics are historical):

- Breakpoints in use: `sm` = 640px and `lg` = 1024px only. `[CODE]`
- Header: nav is a horizontal scroll rail at all widths; **no hamburger menu exists**. `[CODE]` `[VERIFIED-PROD at 375px]`
- Hero: stacked below `lg`; hero + secondary list side-by-side at `lg`. `[CODE]` `[VERIFIED-PROD: 1-col at 375px, 3-col grid at 1024px]`
- Rails: horizontal swipe-scroll on mobile (fixed card widths), static grids at `sm`+; no scroll-snap. `[CODE]` `[VERIFIED-PROD: rails overflow and scroll at 375px]`
- Grid sections: 2 → 3 → 4 columns; transfer/carousel 1 → 2 → 3. `[CODE]`
- Ticker identical at all widths. `[CODE]` `[VERIFIED-PROD: same 30s animation at 375px]`
- RTL: inherited `dir="rtl"`; some intentional physical positions (badges top-right, duration chip bottom-left, centered dots); CTA arrows are literal «←» glyphs. `[CODE]`
- Touch: 16px inputs on coarse-pointer devices `[VERIFIED-PROD: email input computes to 16px under mobile emulation]`; hover-only effects gated to hover-capable devices. `[CODE]`
- There is no documented responsive spec beyond the code (the mock has zero media queries); the roadmap requires RTL mobile+desktop QA incl. loading/error/empty states. `[UNVERIFIED]` + `[INSTRUCTION]`

---

## 6. Features That Must Be Preserved

### 6-A. Functional — BINDING (Charter C2: preserved unless the owner explicitly approves a change)

1. **Admin-driven homepage sections** — show/hide, exact ordering, display style, item limit, «عرض الكل» toggle, accent assignment (`2196811`, `709c634`, `19af62f`, `ba61343`; S4).
2. **Breaking ticker** fed by `is_breaking`: seamless continuous marquee, pause on hover/focus, reduced-motion fallback to a manual scroller, headlines linked.
3. **Auto-rotating hero**: admin-featured article leads the pool; auto-advance (currently 6.5s); pause on hover/focus; slide controls with ≥44px targets; no autoplay under reduced motion; whole-slide links.
4. **Nav driven by categories** (`show_in_nav`, `sort_order`) — never hardcoded; «انتقال الأطباء» present; doctors entry hidden but restorable (`4bf9b30`).
5. **Video lane** tied to type فيديو with YouTube-thumbnail fallback.
6. **Doctor-transfers lane** with «عرض الكل» → `/transfers` (S3; North Star doctor-transfer growth loop).
7. **Homepage search** → Arabic-aware `/search` (S10; `74e8443`).
8. **Newsletter signup**: honeypot anti-spam, honest wording (`706eb8b`), success/duplicate states, audience-survey hook, header «اشتراك» anchor.
9. **Footer trust block**: editorial policy, corrections, privacy, terms, about, contact (`9512241`, `1598bca`).
10. **Accessibility & motion standards**: ≥44px hit targets, press feedback, full `prefers-reduced-motion` handling, visible focus styles, 16px inputs on touch devices (`67c3c7e`).
11. **Trust presentation**: sponsored/commercial placements clearly distinguishable from editorial (North Star §8).
12. **Structural branding flexibility**: the new design must itself remain re-themeable without structural rework (North Star §17).
13. **Platform behaviors**: ISR (60s), CSP/security headers, robots/sitemap entries, `lang="ar" dir="rtl"` document root.
14. **Content-selection rules** of §3.1 (published-only, soft-delete respected, hero dedupe, empty sections dropped).

### 6-B. Visual — documented but NOT binding (Charter C3)

The old palette, IBM Plex fonts, current logo treatment, the 1152px white-column-on-sand shell, card corner radii/aspect ratios, the coral ticker bar color, specific type sizes and spacing, and the mock's styling. All recorded in §4 for reference; the redesign replaces them with the new official identity.

---

## 7. Unverified or Conflicting Requirements

> Per Charter C4, every item below stays open and documented. Nothing here is to be auto-implemented, removed, or resolved. "Verification 2026-11-21" notes record observed facts only; the decisions remain the owner's.

### Discrepancies between previous instructions and current implementation

- **D1 — Ticker duration:** mock 22s vs. shipped 30s; no written instruction fixes either. *Verification 2026-11-21: production runs 30s linear.* Owner decision: pick the redesign's timing.
- **D2 — Ticker colors inverted vs. mock** (mock ink-bar/coral-label; shipped coral-bar/ink-label, matching `ba61343`). Now moot for the redesign (C3) but kept for the record.
- **D3 — Refactor S5 (date+time + source under every item) not met by ContentCard:** shows read-time only; no absolute «نُشر في…» on article cards; source/credit absent on all homepage cards. *Verification 2026-11-21: production confirms — article cards show «N دقائق قراءة» only; TransferCard DOES show the instructed absolute format («نُشر في 7 نوفمبر 2026»).* Owner decision: enforce S5 in the redesign, or retire it.
- **D4 — Refactor S9 social section «المساحة الاجتماعية» never implemented** (seeded, skipped in `queries.ts:115`). Owner decision: build in redesign scope, defer, or retire.
- **D5 — Refactor S3 transfers treatment:** no desktop arrows; rail/grid; not the "visually important" signature block. *Verification 2026-11-21: live lane renders as cards with the من/إلى strip; 4 transfers currently listed.* Owner decision: prominence treatment in the new design.
- **D6 — Refactor S11 sharing icons on cards:** absent (optional in the brief).
- **D7 — Roadmap staleness:** 404/error pages listed open (P1 #4) but shipped in `4bf9b30`. Needs explicit re-status in the roadmap (never silent removal).
- **D8 — Footer lists ALL categories while the header filters by `show_in_nav`.** No instruction says which is intended.
- **D9 — Mock-only blocks never implemented** (economy lane, lifestyle lane, Gulf digest, doctor voting, newsletter interest chips, ع|EN toggle, footer social tiles, investigations treatment; CTA copy divergence). With C3 these are design *options* for the new homepage, each needing a fresh decision (voting additionally gated by North Star §8).

### Unverified items

- **U1 — No written instruction exists for:** ticker speed/direction, hero interval (6500ms), hero pool cap (5), fade duration (700ms), section typography/spacing, card aspect ratios, exact nav/footer composition. Code-only provenance (mostly initial commit `006c029`). The redesign may set these freshly; current values are the de-facto baseline.
- **U2 — Ticker direction:** *Verification 2026-11-21: measured on production — the track moves rightward at ≈52px/s.* The item stays recorded because no instruction ever specified a direction; the redesign should specify one explicitly.
- **U3 — Live production state:** *Partially verified 2026-11-21 (§8): live section lineup and counts observed from the rendered page.* Still not verified: the `homepage_sections` admin rows themselves (styles/limits as configured), live `is_breaking`/`is_featured` flags in the DB, Vercel `NEXT_PUBLIC_SITE_URL`.
- **U4 — Refactor brief approval state:** untracked, no record of which items were accepted vs. superseded. Charter C3 settles its *visual* clauses; its unimplemented *functional* items (D3–D6) still await explicit confirmation or retirement.
- **U5 — PRD search-latency target (3s)** never re-validated.
- **U6 — Implementation quirks with no decision trail** (redesign candidates, not requirements): no homepage `<h1>`; section titles not heading elements; no line-clamps (uneven cards); `Cover` `sizes` hint 768px vs 1152px column; generic alts; hero fallback chain; reduced-motion hero shows first slide only.
- **U7 — Open roadmap gaps:** homepage JSON-LD (P1 #12); full RTL mobile/desktop homepage QA (§8.B P1 #5); production domain decision.

---

## 8. Production Verification — 2026-11-21

Live homepage at **https://salma-azure.vercel.app** (canonical production), checked read-only in a browser on 2026-11-21. Measurements via computed styles and DOM sampling; nothing was changed.

### Confirmed on production

| Behavior | Observation |
|----------|-------------|
| Ticker animation | Computed `salmaMarquee 30s linear infinite`; container `dir=rtl`; 4 breaking items duplicated for the loop |
| Ticker direction/speed | Track position +104.3px over 2.0s → moves **rightward** at ≈52px/s |
| Hero | 5 slides, 5 dot controls; active slide advanced exactly one step within a 7s observation window (consistent with 6500ms) |
| Header | `position: sticky` confirmed; nav rail overflows and scrolls horizontally at 375px; no hamburger present |
| Mobile layout (375×812 emulation) | Hero grid collapses to 1 column; section rails scroll horizontally (e.g. 1448px of content in a 351px container); email input computes to 16px under coarse pointer |
| Desktop layout (1024px) | Hero 3-column grid (hero spans 2); grid sections at 3–4 columns |
| Live section lineup (top → bottom) | Ticker → search → hero+secondary → feed-prompt CTA → «فيديو وتبسيط طبي» (1 video) → **«شصاير في داوي ؟»** (1 item) → **«الكويت»** (6) → **«الخليج»** (3) → **«انتقالات الأطباء»** (4) → **«اقتصاد الصحة»** (6) → **«صحة وحياة»** (5) → **«العالم»** (6) → **«تحقيقات»** (3) → mission → newsletter |
| Card metas | Article cards: «N دقائق قراءة» only; list/hero rows: relative time («قبل 1 شهر»); transfer cards: absolute «نُشر في 7 نوفمبر 2026» |
| Newsletter | Live honest copy present; privacy-consent line present |

### Production observations for the owner (data/editorial, not code — recorded, not acted on)

- **P1 —** «شصاير في داوي ؟» is a live custom section not present in the original seeds — confirms sections are admin-managed in production.
- **P2 —** Demo transfer rows are still public, including «روبرت دنيرو» (هوليوود → بوليوود) — matches the known open owner item from launch hardening.
- **P3 —** «الخليج» currently shows the same Qatar/Numbeo headline twice (two items, same title) — likely duplicate content rows.
- **P4 —** Several items under «اقتصاد الصحة» appear off-category (e.g. NFL brain-disease study, intermittent fasting) — category assignment, not homepage code.
- **P5 —** Hero slide dates run up to «قبل 2 أشهر» — hero pool freshness depends on publishing cadence, as designed.

### Not verifiable from the browser

Admin-configured `homepage_sections` row values (display styles/limits as set), DB flags (`is_breaking`, `is_featured`), Vercel env (`NEXT_PUBLIC_SITE_URL`), server-side behavior (ISR timing), and exact animation frame-rate behavior across devices.

---

*End of baseline, Rev 2. This document records the existing state and the 2026-11-21 Redesign Charter only; no design decisions for the new homepage are made here. Changes after approval must be explicit and dated.*
