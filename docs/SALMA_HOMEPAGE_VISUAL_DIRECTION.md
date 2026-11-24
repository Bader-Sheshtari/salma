# SALMA Homepage — Approved Visual Direction (Refined H1 «دار سلمى»)

**Status: APPROVED by owner 2026-11-24 as SALMA's visual design baseline — design direction only.**
This approval does NOT authorize implementation. Phase 2 of the implementation plan remains paused; no production files are modified, committed, pushed, or deployed on its basis. Implementation proceeds only per `docs/SALMA_HOMEPAGE_IMPLEMENTATION_PLAN.md` and its per-phase owner gates.

Authority artifact: `design/mockups/direction-h1.html` (refined version of 2026-11-24 — the version carrying the teal/wine/jet/golden identities and the de-duplicated labels). The file is currently untracked; committing it as the design record is scheduled in the implementation plan (Phase 2a) and gated like everything else.
Presentation of record: https://claude.ai/artifact/1WtBVoYYZFR324bGgzhC9T (Version 3).
Functional baseline: Direction E (`design/mockups/direction-e.html`) — refined H1 changed presentation only; all content, behaviors (hero 5×6.5s rotation, ticker 30s, honeypot, anchors) and the §DUP/DB/DC logic of the plan are carried over verbatim.
Lineage: Direction E approved 2026-11-23 → H1/H2 Monocle-brief concepts → color round (full palette) → six-point refinement → this baseline.

## 1. Design character

"دار سلمى": an open editorial page (Monocle-informed module intelligence) — hairline-structured, card-free news areas, each section with its own anatomy, punctuated by full-bleed identity modules, with SELF-style photographic energy in صحة وحياة. Organized richness; not minimalism, not visual chaos.

## 2. Section identity map (binding)

Order, surface, device, anatomy — top to bottom:

| # | Section | Surface | Identity device | Anatomy |
|---|---|---|---|---|
| 1 | Masthead + pill nav | Dark Amethyst #1D0446 | White wordmark 208/170 | — |
| 2 | Breaking ticker | Mauve band | «عاجل» pill | marquee 30s [PRESERVED] |
| 3 | Lead board | Paper | Golden-100 #FBCF50 «الأبرز» highlight | Center hero + «الأحدث» (icon tiles) + supporting rail + «المزيد» 3-col text row |
| 4 | الكويت | Paper | 3px frost rule beside lead standfirst | Lead with standfirst + 2-col rows |
| 5 | الخليج | Teal-20 #E9F1EF field | Teal-100 #8FB8AD 3px underlines, rule, hairlines; teal-30 pills/image grounds | Underlined-headline pair |
| 6 | Video band | Dark Amethyst | — | Full-width feature strip |
| 7 | اقتصاد الصحة | Pink-10 #FFF5F8 field | Amethyst numerals on Pink-100 #FC97B9 discs | Numbered list |
| 8 | العالم | Paper | Jet #2B3A36 ink: rule-start + 3px cap on side column | Open 2:1 composition |
| 9 | انتقالات الأطباء | Vanilla #FBF6DD field | Golden من ← إلى ECG journey (#B98900 arrow, graphic-only); 96px portraits | Airy rows, journey as the row's hero |
| 10 | صحة وحياة | Frost-100 #8AD4DD field | Light frost tints (#DCF2F5, #D0EEF1) for pills, grounds, arrows; the City-Guides moment | Edge-to-edge horizontal rail, arrows + counter |
| 11 | شصاير في داوي | Mauve-20 #F3EEFE wash | Icon tile | Feature + side row |
| 12 | تحقيقات | Wine-10 #F0EAEA field | Wine #662832 headline ink + drop rule; wine-20 hairlines/pills | Text-led |
| 13 | Pre-footer («لماذا سلمى» + newsletter) + footer | Dark Amethyst | — | Mission text verbatim; honeypot kept |

## 3. Composition rules (binding)

1. **Color arc.** The page alternates warm and cool: dark → paper (golden touch) → teal → dark → pink → paper(jet) → vanilla/golden → frost → mauve → wine → dark. Eight brand families present; none dominates.
2. **Fields never touch.** Every tinted field is separated from the next by ≥48px of paper or by a dark band.
3. **No boxes.** News stories are headline + hairline + margin compositions; no card containers outside the identity modules' own internal elements.
4. **Category labels.** A story's category tag appears ONLY where it adds editorial value: mixed-category collections (hero slides, «الأحدث», supporting rail, «المزيد»). Inside single-category sections the tag is omitted — the section heading, field and identity carry it. (17 such tags were removed from the mockup; 14 remain, all in the lead board.)
5. **De-duplication.** §DUP of the implementation plan: a story appears once per page; hero-carousel stories may reappear in their own section as the sanctioned fallback.
6. **Editorial variety.** Horizontal and vertical presentation mix deliberately; section anatomies intentionally differ (owner-praised; preserve in implementation).

## 4. Contrast rules (binding)

- On Frost-100: text is Amethyst (10.8:1) or Amethyst-800 (8.6:1) only.
- Teal-100 is graphic-only (1.9:1 on its field) — lines, underlines, never text.
- Wine headlines on wine-10: 9.2:1. Amethyst on golden-100: 12.2:1. Amethyst on pink-100 discs: 6.6:1.
- Golden #B98900 journey arrow: graphic-only (3.0:1).
- Derived darkened text-safe variants (frost #24747E, teal #4A766A, pink #B83A6B, pumpkin #B34E00, mauve #7B52D6, golden-text #8A6600): **DEFERRED by owner ruling DG, 2026-11-24** — not part of the implementation baseline. The approved design consumes none of them (its unused `--ck` declarations are stripped at mockup commit); all colored type uses official colors (amethyst; Wine Plum; Jet Black). They return only as a future proposal if colored type in the light families is ever wanted.

## 5. Open gates affecting this direction

- K1/DA: KO Sans web license; IBM Plex Sans Arabic is the documented dev fallback; production with a substitute font needs its own owner approval.
- K2: Seabass Latin display file + license.
- Mockup commit: `design/mockups/` is untracked; recorded in-plan (Phase 2a), owner-gated.
- (DG is no longer a gate: deferred 2026-11-24, see §4.)

All hexes in the implementation baseline come from the official brand guidelines (primary/secondary palettes and their tint ramps); the §4 derived variants are recorded for history only and are not implemented.
