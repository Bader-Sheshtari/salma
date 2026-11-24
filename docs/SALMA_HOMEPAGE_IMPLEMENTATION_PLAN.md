# SALMA Homepage Redesign — Implementation Plan (Refined H1 «دار سلمى»)

**Status: APPROVED Rev 3 (owner, 2026-11-24) as the planning baseline, including the four rulings (DF, DG, §LBL, §ORD) and the Admin flexibility safeguards. Approval covers the documentation and plan only — NOT implementation. Per safeguard 4, every phase (Phase 2a included) still starts only on its own explicit owner go-ahead.**
Rev 3 trigger: owner approved refined H1 as SALMA's visual design baseline on 2026-11-24 (design direction only). This revision aligns the plan with that baseline; it removes nothing from Rev 2 — superseded Rev 2 items are re-stated, not silently dropped.
Owner-confirmed guardrail (2026-11-24): Admin control over section visibility, ordering, `display_style`, `items_limit`, `show_view_all`, hero curation, and breaking-news settings is preserved; the approved homepage composition is not hardcoded beyond the presentation vocabulary (DF map, lead-board/video/pre-footer slots, §LBL condition).
Date: 2026-11-23 (Rev 2) · 2026-11-24 (Rev 3 draft)
Design authority: **Refined H1 «دار سلمى»** (`design/mockups/direction-h1.html`, 2026-11-24) as recorded in `docs/SALMA_HOMEPAGE_VISUAL_DIRECTION.md` (binding identity map, composition and contrast rules). Direction E (`design/mockups/direction-e.html`) remains the functional/content baseline that H1 carries verbatim.
Binding constraints: `docs/SALMA_HOMEPAGE_SPEC.md` Rev 2 (§6-A functional baseline, Charter C1–C5) and `docs/SALMA_BRAND_IDENTITY_SPEC.md` (incl. owner clarifications K1/K2).

Legend: **[GATE]** = requires explicit owner approval before proceeding · **[PRESERVED]** = existing behavior carried over unchanged.

---

## 0. Owner safeguards (2026-11-23) — override anything below that conflicts

1. No modification to the Admin Dashboard, database schema, or backend contracts without explicit owner approval. This plan requires none; if a need emerges it becomes its own proposal.
2. All binding requirements of `SALMA_HOMEPAGE_SPEC.md` Rev 2 and the approved brand specification are preserved.
3. All work on a separate local Git branch (`redesign/homepage-e`); never directly on `main`.
4. **Explicit owner approval is required before each phase begins, before any push, and before any deployment.** Every phase below is therefore gated, not only the launch.
5. Rollback procedure and acceptance criteria are documented (§4, and per-phase exit criteria in §2).

## 1. Scope

In scope: the public Homepage only — `src/app/page.tsx` shell, `src/components/site/*` used by it, `src/app/globals.css` tokens, `src/lib/queries.ts` homepage selection logic.
Out of scope: Admin Dashboard, article pages, category pages, backend/database schema, editorial agents, all other routes. No database writes. No editorial reclassification.

The redesign is a **restyle + recomposition over the existing engine**, not a rebuild:

| Direction E element | Existing code it maps onto |
|---|---|
| Masthead (wordmark · search · اشتراك) + pill nav | `Header.tsx` (absorbs `SearchBox` from `HomeView`) |
| Breaking ticker | `BreakingTicker.tsx` + `.salma-marquee` CSS — **[PRESERVED]** 30s, pause, reduced-motion |
| Lead board: dominant hero + «الأحدث» + supporting + «المزيد من الأخبار» | `RotatingHero.tsx` (**[PRESERVED]** `ROTATE_MS=6500`, cross-fade 700ms, dots, pause, reduced-motion) + the existing hero-adjacent ListRows, extended to the 3-rail composition |
| Uniform section anatomy | `HomeSection.tsx` `display_style` switch — `featured` → lead+rows (the Direction E default), `list` → text rows (تحقيقات style), `grid` → image cards (صحة وحياة style), `carousel` → horizontal Rail (kept for admin use) |
| Doctor transfers dark band | `TransferCard.tsx` + transfers branch in `HomeSection.tsx` |
| Video strip | existing fixed video lane in `HomeView.tsx`, restyled full-width |
| «لماذا سلمى» + newsletter pre-footer | existing mission band + `NewsletterForm` (honeypot **[PRESERVED]**), relocated/merged |
| Story excerpts | existing `content.excerpt` column, already in `CARD_FIELDS` — rendered on hero/lead/rail cards (today it shows only on `featured` leads) |

No `homepage_sections` schema change. Admin controls (`sort_order`, `items_limit`, `show_view_all`, `is_enabled`, `display_style`, `accent`) keep working — **[PRESERVED]**.

## 2. Decisions — owner rulings of 2026-11-23 (final)

- **DA — Typography (RULED).** KO Sans remains SALMA's official Arabic typeface. IBM Plex Sans Arabic may be used **only as a clearly documented temporary development fallback** (code comment at the font declaration + entry in the phase commit message naming it a fallback pending K1). **Production deployment with a substitute font is itself a [GATE]: it requires explicit owner approval, separate from the launch gate.** The KO Sans swap (Phase 6) happens via `next/font/local` once the Kotype web license is confirmed.
- **DB — Supporting-stories selection (RULED).** Selection follows a **documented editorial selection logic**, not recency alone, with no hardcoded editorial choices (no article IDs/slugs in code) and no interference with existing admin-controlled featured-story settings. The v1 logic to implement, documented here as the single source of truth:
  1. Eligibility: published stories not already placed in the hero or «الأحدث» rail.
  2. Ranking: (a) `is_breaking` first; (b) then stories with a cover image (the rail is image-led); (c) then freshness (`published_at`). Importance signals available today are `is_breaking` and the admin's section/hero curation; if the owner later wants a dedicated "editorial importance" control, that is a separate admin proposal, not part of this plan.
  3. The logic lives in one named function (`selectLeadBoard`, `src/lib/leadBoard.ts`) with a doc comment pointing at this section.
  4. *(Resolution, owner-confirmed 2026-11-24.)* DB's original "not already placed in the hero or «الأحدث» rail" was circular with DC. The implemented, deterministic fill order is **hero → supporting → «الأحدث» → «المزيد»**; each slot excludes everything selected before it. Admin hero curation (`is_featured`) runs first, outside this function, and is never overridden by it.
- **DC — «الأحدث» rail (RULED: approved in principle).** The most recently published **eligible** stories across all categories, 4 items. Eligibility and duplication handling: stories already selected for the hero or the supporting rail are excluded; the rail never shows a story twice with another lead-board slot. Downstream, the §DUP rule below governs reappearance in category sections.
- **DD — Feed-prompt band (RULED: conditional).** The teal band is removed **visually only**; its functions are explicitly mapped and preserved:
  | Existing function of the band | Where it lives in Direction E |
  |---|---|
  | Route readers to newsletter signup (`#newsletter` anchor link) | Masthead «اشتراك» button (same anchor) + pre-footer subscribe band |
  | Communicate the "follow SALMA / stay informed" message | «لماذا سلمى» panel copy in the pre-footer band (mission text preserved verbatim) |
  | Visual break between lead board and sections | The full-width video strip occupies this position |
  If any further objective of the band is identified during review, it must be mapped before the band is deleted.
- **DE — Review channel (RULED: approved).** Initial visual review on the **local development preview**. Any GitHub push or Vercel preview deployment requires separate explicit owner approval.

**§DUP — De-duplication rule (approved with Direction E).** A story appears once on the Homepage; hero-carousel stories may additionally appear in their own category section when the section would otherwise fall below its minimum (the carousel is transient). Original `category_slug` is always displayed where tags appear; category pages and database classifications are untouched. (Rev 3 note: §LBL below governs *where* tags appear.)

**§DUP-V — Section-visibility guarantee (owner ruling 2026-11-24).** An enabled section that has eligible published stories never disappears because of de-duplication. Deterministic ladder in `dedupSectionItems` (`src/lib/leadBoard.ts`, unit-tested via `npm test`): (1) strict §DUP exclusion — the default; (2) the sanctioned hero-story re-admission above; (3) only when both leave the section EMPTY while it has stories, controlled duplication: the section renders its own stories newest-first, capped at the admin `items_limit`, which stays authoritative in every branch.

### Rev 3 — decisions RULED by owner 2026-11-24

- **DF — Section identity mechanism (RULED: approved, with condition).** Owner condition: changing a section's `accent` through Admin must apply a **coherent visual identity** — surface background, accent devices, and accessible text contrast together, never a partial restyle. Mechanism as proposed: Refined H1 gives each section a visual identity (surface color family + accent device + anatomy variant) beyond what `display_style` alone expresses. Proposed mechanism, still with **no schema change**: the existing `homepage_sections.accent` column becomes the identity key. A single documented config map in code (one file, no section slugs hardcoded in components) translates `accent` values (`teal`, `pink`, `jet`, `vanilla`, `frost`, `mauve`, `wine`, `paper`/empty) into the surface, devices and text rules of `SALMA_HOMEPAGE_VISUAL_DIRECTION.md` §2, combined with `display_style` for the anatomy. Admin keeps full control: changing a section's `accent` in the existing Admin UI changes its identity; unknown/empty values fall back to paper + amethyst rule. This extends Rev 2's narrower ruling ("accent drives the header rule color").
- **DG — Derived text-safe color variants (RULED: DEFERRED).** The six derived darkened hexes (frost #24747E, teal #4A766A, pink #B83A6B, pumpkin #B34E00, mauve #7B52D6, golden-text #8A6600) are **not part of the implementation baseline**: they do not enter the token set, and the six unused `--ck` declarations are stripped from `direction-h1.html` when the mockup is committed (Phase 2a). Verified basis: the approved refined H1 consumes none of them (`var(--ck)`: zero uses); all colored type uses official colors (amethyst; Wine Plum #662832; Jet Black #2B3A36). Implementation uses the official SALMA palette and approved tints only. If a future design round introduces colored type in the light families, DG returns as its own proposal.
- **§LBL — Category-label rule (RULED: approved).** Redundant category labels are hidden within sections and displayed where editorially meaningful: a story's tag renders only when its category differs from its section's own category — automatically true throughout the mixed lead board (hero slides, «الأحدث», supporting rail, «المزيد من الأخبار»), automatically false inside single-category sections. Implemented as one documented condition in the card/row components, not per-section exceptions.
- **§ORD — Section order (RULED: approved).** Admin `sort_order` remains the **sole authority** for section ordering. Refined H1's approved sequence (visual direction doc §2) differs from current production order. Sections remain ordered by the admin's `sort_order` — no code override. Realization: at the Phase 5 review gate the owner (or, on his instruction, the implementer via the Admin UI) sets `sort_order` to the approved sequence; the code-positioned elements (lead board, video band, pre-footer) are composed to their approved slots in `HomeView.tsx`. Until then the new design renders in whatever order admin data dictates — by design.

## 3. Phases — each begins only on explicit owner approval **[GATE before every phase]**

Work happens on local branch `redesign/homepage-e` (never `main`). Each phase ends in local commit(s); **nothing is pushed or deployed at any phase** (safeguard 4; pushing `main` auto-deploys production on Vercel).

**Phase status (2026-11-24): Phase 0 DONE (commit 7552b7f) · Phase 1 DONE (commit e9081cd) — both under Rev 2, both compatible with refined H1 (the H1 masthead/footer/ticker match what Phase 1 built). Phase 2a is new in Rev 3. Phases 2+ NOT started; Phase 2 remains paused by owner.**

### Phase 0 — Foundations (invisible) [GATE] — DONE (7552b7f)
- Add Direction E brand tokens to `globals.css` `@theme inline` alongside existing ones (amethyst #1D0446, mauve #C6A9FD, vanilla #F5E9A4, seashell #F1E5E0, the 8 secondary colors, hairline). Nothing consumes them yet.
- Add the approved type scale as utilities/custom properties (hero clamp 24→32, section 22, lead 20, row 16, excerpt 14, meta 11/13).
- Commit brand **logo SVGs** (wordmark + mark variants) under `public/brand/`. Font files are NOT committed (K1/DA).
- Optional, owner's call: commit `design/mockups/` (excluding `assets/fonts/`) as the design record.
- **Acceptance:** build passes; zero visual change on any route; no new font files in the repo.

### Phase 1 — Global chrome [GATE] — DONE (e9081cd)
- `Header.tsx`: Amethyst masthead, official wordmark (white variant, 208px/170px), search field moved in from `HomeView`, «اشتراك» button (#newsletter anchor), pill nav (categories where `show_in_nav`, unchanged source). Interim Arabic font documented per DA.
- `Footer.tsx`: Amethyst footer per mockup (links unchanged; trust/sources line kept — §6-A).
- `BreakingTicker.tsx`: restyle to Mauve band + «عاجل» pill. Animation CSS untouched.
- **Acceptance:** ticker animation measured unchanged (30s, pause on hover/focus, reduced-motion fallback); nav lists the same categories as production; no horizontal overflow at 320px.

### Phase 2a — Token extension (invisible) [GATE] — NEW in Rev 3
- Extend `globals.css` tokens with the official tint values refined H1 consumes: teal-20/30 (#E9F1EF, #DDEAE6), pink-10 (#FFF5F8), frost-30/40 (#DCF2F5, #D0EEF1), mauve-20 (#F3EEFE), vanilla-40 (#FBF6DD), wine-10/20 (#F0EAEA, #E0D4D6), golden-100 (#FBCF50), journey-arrow #B98900. All values from the official tint ramps; **no DG variants** (DG deferred).
- Commit `design/mockups/direction-h1.html` + `direction-e.html` (and `index.html`, excluding any font files) as the design record, per Phase 0's deferred "owner's call" item — included here for the owner's explicit yes/no. Before committing, strip the six unused `--ck` declarations from `direction-h1.html` (DG ruling).
- **Acceptance:** build passes; zero visual change on any route; no font files committed.

### Phase 2 — Lead board [GATE]
- `HomeView.tsx`: 3-rail board. Center: `RotatingHero` restyled (adds per-slide `excerpt`, golden-100 «الأبرز» highlight per refined H1; behavior code untouched). Start rail «الأحدث» (per DC) with its icon-tile treatment; end rail supporting stories (per DB); «المزيد من الأخبار» 3-col text row under a hairline. Category tags render here (mixed collections, §LBL).
- `lib/queries.ts` `getHomepage()`: implement the featured layer + §DUP de-duplication with the section-minimum fallback.
- Remove the teal feed-prompt band per DD's mapping table.
- **Acceptance:** automated check — no headline appears twice outside the carousel; hero rotation still 6.5s with 700ms fade and functional dots; DB/DC logic matches §2 word for word; sections never render empty because of dedup (fallback engages).

### Phase 3 — Section identity system + pre-footer [GATE]
*(Supersedes Rev 2's Phase 3 "restyle all `display_style` variants uniformly". Rev 2's transfers treatment — "calm dark Amethyst, 64px portraits" — is superseded by the approved vanilla field; nothing else from Rev 2's Phase 3 is dropped.)*
- *(Deferred here from Phase 2, owner-accepted 2026-11-24:)* the lead board's category marks, reading pills and icon tiles ship Phase 2 in neutral amethyst/mauve with a single pulse glyph; their per-category color treatment and story-type icons are delivered by the DF identity map below — accent-keyed, never hardcoded category slugs.
- `HomeSection.tsx` + the DF config map: implement the binding identity map of `SALMA_HOMEPAGE_VISUAL_DIRECTION.md` §2 — per-section surfaces (teal-20 الخليج, pink-10 اقتصاد, frost-100 صحة-وحياة, mauve-20 داوي, wine-10 تحقيقات, paper + jet ink العالم, paper + frost rule الكويت), accent devices, and anatomy variants (underlined pair, numbered list, open 2:1, text-led, lead+standfirst) composed from `display_style` × `accent`. Hairlines not boxes throughout.
- §LBL label rule: category tags omitted inside single-category sections; rendered in mixed collections only. One documented condition, no per-section exceptions.
- Transfers band: **vanilla-40 field** (#FBF6DD), 96px portraits, golden من ← إلى ECG journey as the row's visual hero (#B98900 arrow graphic-only), airy rows.
- صحة وحياة: edge-to-edge horizontal rail on frost-100 with arrows + counter (keyboard-operable, `aria` per carousel pattern, reduced-motion: no smooth-scroll animation).
- Video lane: full-width **dark Amethyst** feature band in flow.
- Mission band content merges into the pre-footer «لماذا سلمى» + newsletter band (honeypot kept, mission text verbatim).
- **Acceptance:** every `display_style` × identity renders sensibly at 1, 3, and 6 items (explicit server-side variants, no `:has()` dependency); admin toggles (`is_enabled`, `sort_order`, `items_limit`, `show_view_all`, `accent`) verified effective against a local data copy — including switching a section's `accent` to another identity and to empty (paper fallback); composition rules audited: no two tinted fields touch (≥48px paper or dark band between), warm/cool arc preserved for the approved order; §LBL verified (zero same-category tags inside unified sections); contrast rules of the visual direction doc §4 verified programmatically; transfers and newsletter function unchanged.

### Phase 4 — Hardening [GATE]
- Responsive matrix 320/375/390/430/768/1024+: no horizontal overflow, no visible text <13px under 768, touch targets ≥44px.
- A11y: carousel aria pattern (hero AND the صحة-وحياة rail), focus-visible on colored fields, reduced-motion (hero + ticker + rail + any pulse animation), landmarks — §6-A #10 preserved.
- Full contrast audit of every text/surface pair on the colored fields per `SALMA_HOMEPAGE_VISUAL_DIRECTION.md` §4 (≥4.5:1 text, ≥3:1 large text; teal-100 and #B98900 graphic-only).
- Perf: hero image `priority`, lazy below fold, LCP check; `revalidate = 60` and admin `revalidatePath("/")` unchanged.
- **Acceptance:** the full §6-A checklist audited item by item and recorded in the phase's commit message; all matrix and contrast checks pass.

### Phase 5 — Review & launch [GATE ×3]
- **Review gate:** owner reviews the full page on the local dev server (DE). §ORD executes here: `sort_order` set to the approved sequence via the Admin UI (owner, or implementer on his instruction).
- **Push gate:** any GitHub push / Vercel preview URL needs its own explicit approval (DE).
- **Launch gate:** merge to `main` + production deploy only on explicit owner instruction — and, while KO Sans is unlicensed, only together with the DA substitute-font approval. (DG deferred — no longer a launch condition.)

### Phase 6 — Post-launch, separately gated [GATE]
- KO Sans swap-in once the Kotype web license is confirmed (K1/DA): `next/font/local`, one commit.
- Seabass for Latin display once the file + license arrive (K2); DM Sans remains the body Latin face (OFL).

## 4. Rollback procedure

- **Before merge:** the branch is local-only; abandoning it restores status quo with zero production impact.
- **After launch:** `git revert` of the merge commit on `main` + push redeploys the previous Homepage via Vercel. The redesign is component/CSS/query-selection only — **no schema migration, no data migration, no admin change** — so revert is complete and immediate (within the 60s ISR window; `revalidatePath("/")` can force it instantly).
- Brand tokens added in Phase 0 are additive and inert if unused, so partial rollback of later phases never breaks earlier ones.

## 5. Risks & notes

- **External gates:** fonts only (K1/K2/DA); everything else is self-contained. (DG deferred out of the baseline.)
- `display_style` mapping keeps admin semantics but changes looks; DF additionally widens what `accent` means (identity key, not just rule color) — admin UI itself untouched; existing accent values fall back to paper if they don't match an identity key. A per-section preview in admin would be a separate proposal.
- External article images (BBC/CNN/agency URLs) already render on production cards; no CSP/image-host change expected. Verified in Phase 4 anyway.
- Dedup changes which stories appear in sections (not what exists in the DB or category pages); §DUP's fallback prevents empty sections.
- Production content issues found during design (editorial follow-ups, outside this plan): «مواطن يناشد…» meta description says «مواطن قطري»; Orca-T and Qfitlia homepage headlines disagree with their articles' content.

## 6. Estimate

Phases 0–1: done. Phase 2a: small (tokens + design-record commit). Phase 2: a core (selection logic + board). Phase 3: the second core under Rev 3 (identity system — grew from "medium, mostly CSS/JSX"). Phase 4: fixed checklist, now including the contrast audit. Sequential 2a→2→3→4→5, each independently committable and revertible, each started only on the owner's go.
