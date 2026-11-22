# SALMA Homepage Redesign — Implementation Plan (Direction E)

**Status: APPROVED Rev 2 (owner, 2026-11-23). Approval covers the plan itself; per safeguard 4, each phase still starts only on its own explicit owner go-ahead.**
Date: 2026-11-23 (Rev 2, same day: owner rulings on DA–DE + safeguards incorporated)
Design authority: Direction E «تحريري أولاً», approved by owner 2026-11-23 (`design/mockups/direction-e.html`).
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
  3. The logic lives in one named function in `lib/queries.ts` with a doc comment pointing at this section.
- **DC — «الأحدث» rail (RULED: approved in principle).** The most recently published **eligible** stories across all categories, 4 items. Eligibility and duplication handling: stories already selected for the hero or the supporting rail are excluded; the rail never shows a story twice with another lead-board slot. Downstream, the §DUP rule below governs reappearance in category sections.
- **DD — Feed-prompt band (RULED: conditional).** The teal band is removed **visually only**; its functions are explicitly mapped and preserved:
  | Existing function of the band | Where it lives in Direction E |
  |---|---|
  | Route readers to newsletter signup (`#newsletter` anchor link) | Masthead «اشتراك» button (same anchor) + pre-footer subscribe band |
  | Communicate the "follow SALMA / stay informed" message | «لماذا سلمى» panel copy in the pre-footer band (mission text preserved verbatim) |
  | Visual break between lead board and sections | The full-width video strip occupies this position |
  If any further objective of the band is identified during review, it must be mapped before the band is deleted.
- **DE — Review channel (RULED: approved).** Initial visual review on the **local development preview**. Any GitHub push or Vercel preview deployment requires separate explicit owner approval.

**§DUP — De-duplication rule (approved with Direction E).** A story appears once on the Homepage; hero-carousel stories may additionally appear in their own category section when the section would otherwise fall below its minimum (the carousel is transient). Original `category_slug` is always displayed; category pages and database classifications are untouched.

## 3. Phases — each begins only on explicit owner approval **[GATE before every phase]**

Work happens on local branch `redesign/homepage-e` (never `main`). Each phase ends in local commit(s); **nothing is pushed or deployed at any phase** (safeguard 4; pushing `main` auto-deploys production on Vercel).

### Phase 0 — Foundations (invisible) [GATE]
- Add Direction E brand tokens to `globals.css` `@theme inline` alongside existing ones (amethyst #1D0446, mauve #C6A9FD, vanilla #F5E9A4, seashell #F1E5E0, the 8 secondary colors, hairline). Nothing consumes them yet.
- Add the approved type scale as utilities/custom properties (hero clamp 24→32, section 22, lead 20, row 16, excerpt 14, meta 11/13).
- Commit brand **logo SVGs** (wordmark + mark variants) under `public/brand/`. Font files are NOT committed (K1/DA).
- Optional, owner's call: commit `design/mockups/` (excluding `assets/fonts/`) as the design record.
- **Acceptance:** build passes; zero visual change on any route; no new font files in the repo.

### Phase 1 — Global chrome [GATE]
- `Header.tsx`: Amethyst masthead, official wordmark (white variant, 208px/170px), search field moved in from `HomeView`, «اشتراك» button (#newsletter anchor), pill nav (categories where `show_in_nav`, unchanged source). Interim Arabic font documented per DA.
- `Footer.tsx`: Amethyst footer per mockup (links unchanged; trust/sources line kept — §6-A).
- `BreakingTicker.tsx`: restyle to Mauve band + «عاجل» pill. Animation CSS untouched.
- **Acceptance:** ticker animation measured unchanged (30s, pause on hover/focus, reduced-motion fallback); nav lists the same categories as production; no horizontal overflow at 320px.

### Phase 2 — Lead board [GATE]
- `HomeView.tsx`: 3-rail board. Center: `RotatingHero` restyled (adds per-slide `excerpt`, «الأبرز» tag; behavior code untouched). Start rail «الأحدث» (per DC); end rail supporting stories (per DB); «المزيد من الأخبار» 3-col text row under a hairline.
- `lib/queries.ts` `getHomepage()`: implement the featured layer + §DUP de-duplication with the section-minimum fallback.
- Remove the teal feed-prompt band per DD's mapping table.
- **Acceptance:** automated check — no headline appears twice outside the carousel; hero rotation still 6.5s with 700ms fade and functional dots; DB/DC logic matches §2 word for word; sections never render empty because of dedup (fallback engages).

### Phase 3 — Sections + pre-footer [GATE]
- `HomeSection.tsx`: restyle all `display_style` variants to the approved anatomies (hairlines not boxes; chips removed except «الأبرز»/«عاجل»; category as plain meta; `accent` drives the header rule color, default moves from `--salma-green` to Amethyst).
- Transfers band: calm dark Amethyst treatment (64px round portraits, من ← إلى line, pulse divider).
- Video lane: full-width feature strip in flow.
- Mission band content merges into the pre-footer «لماذا سلمى» + newsletter band (honeypot kept, mission text verbatim).
- **Acceptance:** every `display_style` renders sensibly at 1, 3, and 6 items (adaptivity implemented as explicit variants server-side, no `:has()` dependency); admin toggles (`is_enabled`, `sort_order`, `items_limit`, `show_view_all`) verified effective against a local data copy; transfers and newsletter function unchanged.

### Phase 4 — Hardening [GATE]
- Responsive matrix 320/375/390/430/768/1024+: no horizontal overflow, no visible text <13px under 768, touch targets ≥44px.
- A11y: carousel aria pattern, focus-visible, reduced-motion (hero + ticker + any pulse animation), landmarks — §6-A #10 preserved.
- Perf: hero image `priority`, lazy below fold, LCP check; `revalidate = 60` and admin `revalidatePath("/")` unchanged.
- **Acceptance:** the full §6-A checklist audited item by item and recorded in the phase's commit message; all matrix checks pass.

### Phase 5 — Review & launch [GATE ×3]
- **Review gate:** owner reviews the full page on the local dev server (DE).
- **Push gate:** any GitHub push / Vercel preview URL needs its own explicit approval (DE).
- **Launch gate:** merge to `main` + production deploy only on explicit owner instruction — and, while KO Sans is unlicensed, only together with the DA substitute-font approval.

### Phase 6 — Post-launch, separately gated [GATE]
- KO Sans swap-in once the Kotype web license is confirmed (K1/DA): `next/font/local`, one commit.
- Seabass for Latin display once the file + license arrive (K2); DM Sans remains the body Latin face (OFL).

## 4. Rollback procedure

- **Before merge:** the branch is local-only; abandoning it restores status quo with zero production impact.
- **After launch:** `git revert` of the merge commit on `main` + push redeploys the previous Homepage via Vercel. The redesign is component/CSS/query-selection only — **no schema migration, no data migration, no admin change** — so revert is complete and immediate (within the 60s ISR window; `revalidatePath("/")` can force it instantly).
- Brand tokens added in Phase 0 are additive and inert if unused, so partial rollback of later phases never breaks earlier ones.

## 5. Risks & notes

- **Fonts are the only external gate** (K1/K2/DA); everything else is self-contained.
- `display_style` mapping keeps admin semantics but changes looks; the admin Homepage page itself is untouched. A per-section preview in admin would be a separate proposal.
- External article images (BBC/CNN/agency URLs) already render on production cards; no CSP/image-host change expected. Verified in Phase 4 anyway.
- Dedup changes which stories appear in sections (not what exists in the DB or category pages); §DUP's fallback prevents empty sections.
- Production content issues found during design (editorial follow-ups, outside this plan): «مواطن يناشد…» meta description says «مواطن قطري»; Orca-T and Qfitlia homepage headlines disagree with their articles' content.

## 6. Estimate

Phases 0–1: small. Phase 2: the core of the work (selection logic + board). Phase 3: medium, mostly CSS/JSX. Phase 4: fixed checklist. Sequential 0→1→2→3→4, each independently committable and revertible, each started only on the owner's go.
