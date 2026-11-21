# SALMA Brand Identity Specification

**Status:** APPROVED by the owner on 2026-11-22 (with owner clarifications K1/K2 below) — official brand reference for the Homepage redesign. Changes after this point must be explicit and dated.
**Date:** 2026-11-22.
**Source package:** `Design Brand for claud.zip` (owner-provided, 2026-11-22): `Salma_Brand_Guidelines.ai_compressed.pdf` ("Salma Visual Identity", Version 1.0, 2026, 24 pages), logo icon + logo typeface sets (SVG/PNG), 25 iconography SVGs, 14 font files. Originals unchanged.
**Relationship to other docs:** `docs/SALMA_HOMEPAGE_SPEC.md` (Rev 2, commit `99b4101`) remains the binding functional baseline; this document defines the visual identity that replaces the old (historical) visuals per Redesign Charter C3.

**Owner clarifications — 2026-11-22:**
- **K1 — KO Sans** is confirmed as the official Arabic brand typeface and stays the intended typography throughout this spec. **Production web embedding is PENDING license verification**: it must not be deployed or self-hosted on the live website until the appropriate rights are confirmed. (Local preview in non-deployed design mockups is acceptable.)
- **K2 — Seabass** is confirmed as the official Latin headline typeface; its font file is missing from the package and the asset is marked **PENDING**. Design mockups may use a clearly labeled temporary substitute; such a substitute is a mockup convenience only, NOT an approved brand change.
- All five conflicts (C1–C5) and fourteen gaps (M1–M14) in §8 remain documented and open; none is auto-resolved.

**Provenance legend:**
- `[OFFICIAL]` — stated in the Brand Guidelines PDF (page cited) or verified directly in the delivered asset files.
- `[OBSERVED]` — consistently shown in the guidelines' examples/mockups but not written as a rule.
- `[RECOMMENDATION]` — my recommendation for web use; not an official brand requirement.
- `[FLAG]` — missing, unverifiable, or conflicting; collected in §8.

---

## 1. Official Color Palette

### 1.1 Primary palette `[OFFICIAL]` (p.11; hex values independently confirmed in the logo/icon SVG files)

| Name | HEX | RGB | CMYK |
|------|-----|-----|------|
| **Dark Amethyst** | `#1D0446` | 29, 4, 70 | 59, 94, 0, 73 |
| **Mauve** | `#C6A9FD` | 198, 169, 253 | 22, 33, 0, 1 |
| **Vanilla Custard** | `#F5E9A4` | 245, 233, 164 | 0, 5, 33, 4 |
| **Seashell** | `#F1E5E0` | 241, 229, 224 | 0, 5, 7, 5 |

Positioning line (p.11): the palette combines the "trust and professionalism of healthcare" with "warmth, empathy, and vitality".

Roles are not printed `[FLAG §8-M1]`; observed usage `[OBSERVED]`: Dark Amethyst = logo, text, dark panels; Mauve = panels, buttons, banners, breaking-ticker bar; Seashell = page/surface backgrounds; Vanilla Custard = highlight tags (e.g. the «الأبرز» pill).

### 1.2 Primary tint ramps `[OFFICIAL]` (p.12; 100%→10% in steps of 10)

- **Dark Amethyst:** `#1D0446 #341D59 #4A366B #61507E #776890 #8E82A3 #A59BB5 #BBB4C8 #D2CCDA #E8E6ED`
- **Mauve:** `#C6A9FD #CBB2FD #D1BBFD #D6C4FD #DCCDFE #E2D4FE #E7DDFE #EDE6FE #F3EEFE #F9F7FF`
- **Vanilla Custard:** `#F5E9A4 #F6ECB0 #F7EEBC #F8F1C7 #F9F3D3 #FAF4D0 #FBF6DD #FCF8E8 #FDFBF2 #FEFDF9` — `[FLAG §8-C1: the printed 50% value #FAF4D0 is darker than the 60% value, breaking the ramp; likely a typo in the guidelines]`
- **Seashell:** `#F1E5E0 #F2E8E4 #F3EBE7 #F5EEEB #F6F1EE #F8F2F0 #F9F5F3 #FAF7F6 #FCFAF9 #FDFCFB`

### 1.3 Secondary palette `[OFFICIAL]` (p.13)

| Name | HEX | RGB |
|------|-----|-----|
| Coffee Bean | `#2D1318` | 45, 19, 24 |
| Golden Pollen | `#FBCF50` | 251, 207, 80 |
| Wine Plum | `#662832` | 102, 40, 50 |
| Jet Black | `#2B3A36` | 43, 58, 54 |
| Pink Mist | `#FC97B9` | 252, 151, 185 |
| Muted Teal | `#8FB8AD` | 143, 184, 173 |
| Pumpkin Spice | `#FF7307` | 255, 115, 7 |
| Frosted Blue | `#8AD4DD` | 138, 212, 221 |

Each secondary color has a printed 100%→10% tint ramp (p.14; full values preserved in the guidelines — use the PDF as source of truth for secondary tints).

### 1.4 Usage rules

- `[OFFICIAL]` (p.13) Secondary colors "can be used for": supporting graphic elements and illustrations; social media layouts and campaign visuals; highlights, accents, and visual categorization; backgrounds and complementary design elements. They add "depth, variety, and personality".
- `[OFFICIAL]` No forbidden combinations, contrast rules, or approved-pairing tables are printed `[FLAG §8-M2]`.
- `[OBSERVED]` pairings in the guidelines' examples: Amethyst↔Mauve (both directions), Amethyst on Seashell, white wordmark on photography, secondary colors as category tags/tiles (Frosted Blue, Wine Plum, Pumpkin Spice, Golden Pollen, Pink Mist), Golden Pollen "Featured" pill.
- `[RECOMMENDATION]` Measured WCAG contrast (text-safe = ≥4.5:1 for body, ≥3:1 for large text):
  - **Safe for text:** Amethyst on white 18.1:1, on Seashell 14.7:1, on Mauve 9.1:1, on Vanilla 14.7:1; Mauve on Amethyst 9.1:1; Golden Pollen on Amethyst 12.2:1; Frosted Blue on Amethyst 10.8:1; Wine Plum on white 11.0:1; Coffee Bean on white 17.2:1; Jet Black on white 11.9:1.
  - **NOT text-safe (decorative/background use only):** Mauve on white 2.0:1, Vanilla on white 1.2:1, Pumpkin Spice on white 2.7:1, Pink Mist on white 2.1:1, Muted Teal on white 2.2:1, Frosted Blue on white 1.7:1, Seashell on white 1.2:1.
  - Practical consequence: light brand colors work as fills/pills/bands carrying Amethyst text; they must not be used as text color on light surfaces.

## 2. Typography System

### 2.1 Arabic — KO Sans `[OFFICIAL]` (p.16, "primary Arabic typeface"; files delivered: Light/Regular/Medium/SemiBold/Bold OTF)

| Application (per guidelines) | Weight |
|------------------------------|--------|
| Display | Bold / ExtraBold "where available" |
| Primary headline | Bold |
| Secondary headline | Medium / Bold |
| Paragraphs, descriptions, captions, news content | Regular / Medium |

Applies to "digital and print applications". `[FLAG §8-M4: no ExtraBold file was delivered — heaviest delivered weight is Bold]`

> **Owner clarification K1 (2026-11-22):** KO Sans is the official Arabic brand typeface and remains the intended typography for the website. Production web embedding is **pending license verification** — no deployment or self-hosting on the live site until rights are confirmed. Mockup preview use is permitted.

### 2.2 Latin `[OFFICIAL]` (p.17)

- **Seabass** — headlines, "primarily set in uppercase": Ultra headline Bold/ExtraBold (large-scale headlines, campaign statements), Primary headline Bold, Secondary headline Medium/Bold. `[FLAG §8-C2: NO Seabass font file is in the package — asset PENDING]`

  > **Owner clarification K2 (2026-11-22):** Seabass is the official Latin headline typeface; the asset is pending delivery. Mockups may use a **clearly labeled temporary substitute**, which is not an approved brand change — the spec's intended font remains Seabass.
- **DM Sans** — paragraphs, descriptions, captions, news content: Regular/Medium. (Delivered as an OFL variable font.)

### 2.3 Fonts delivered but NOT designated by the guidelines `[FLAG §8-C3]`

Adobe Arabic, SF Pro Display (3 weights), Arial (2), Manrope, Readex Pro are in the package but appear nowhere in the guidelines. Per the owner's instruction, they are **not treated as approved website fonts** pending clarification of why they were included.

### 2.4 Font licensing (evidence read from the font files' own name tables)

| Family | License evidence | Web self-hosting |
|--------|------------------|------------------|
| KO Sans (5 weights) | "Copyright © 2025 by Kotype. All rights reserved." — no open license | **Commercial — confirm the purchased license covers webfont use before self-hosting** `[FLAG §8-M5]` |
| DM Sans (variable) | SIL Open Font License 1.1 | ✅ Free to self-host |
| Manrope, Readex Pro | SIL Open Font License 1.1 | ✅ Free (but not brand-designated) |
| Adobe Arabic | Adobe copyright/trademark; Adobe-bundled | ❌ Not for self-hosting without an Adobe license |
| SF Pro Display | Apple — "subject to the iOS Software License Agreement" | ❌ Do not self-host |
| Arial | Monotype embedding restrictions | ❌ Do not self-host (system fallback only) |

- `[OFFICIAL — absent]` No type scale, sizes, line heights, tracking, fallback stacks, or Arabic↔Latin size relationship is printed `[FLAG §8-M6]`.
- `[RECOMMENDATION]` Web stacks: Arabic `"KO Sans", "IBM Plex Sans Arabic", system-ui, sans-serif` during transition (drop IBM Plex once KO Sans licensing is confirmed); Latin body `"DM Sans", system-ui, sans-serif`; Latin display: pending the Seabass file or an owner-approved substitute.

## 3. Logo Usage

### 3.1 Identity `[OFFICIAL]`

- **Primary logo:** custom Arabic wordmark «سلمى» — "fluid, connected letterforms with a contemporary geometric touch" (p.2). It is custom lettering, not a font setting.
- **Symbol:** inspired by the Arabic letter «س», "simplified into a modern geometric symbol" (p.5) — a pulse/zigzag glyph with a bar, used in a rounded-square tile; serves as favicon, avatar, and social badge (pp.4, 22).
- **Four official variations** (p.7): Symbol Primary (Mauve glyph on Dark Amethyst tile), Symbol Reversed (Amethyst tile with Mauve glyph on Mauve), Wordmark Primary (Amethyst), Wordmark Photography Application (white/light on photos). "The logo and symbol adapt to our brand color palette."
- No English/Latin wordmark lockup exists; "SALMA.CO" / "SALMA.HEALTH" appear only as small labels in social mockups, with no spec `[FLAG §8-M7]`.

### 3.2 Rules `[OFFICIAL]`

- **Clear space** (p.4): defined by a diagram — approximately one glyph-block unit on all sides of the wordmark; no numeric formula printed `[FLAG §8-M8]`.
- **Minimum sizes** (p.4): symbol **50px**; wordmark **150px**.
- **Misuse** (p.8): no skewing/stretching, no rotating, no per-character recoloring, no effects (e.g. drop shadow), no strokes, no modifying any part.
- **Co-branding** (p.9): "SALMA × partner" lockups (examples: DAWI NOW, Hadi Clinic, A'AYAN); Salma left of the separator; equal clear-space blocks; consistent sizing/alignment; no numeric ratios printed.

### 3.3 Delivered logo files (verified)

| Asset | Content | Formats |
|-------|---------|---------|
| Logo-Icon Asset 1 | Symbol tile: Mauve bg, Amethyst mark | SVG + PNG 1327×1326 |
| Logo-Icon Asset 2 | Symbol tile: Amethyst bg, Mauve mark | SVG + PNG |
| Logo-Icon Assets 6/7/8/9 | Bare mark in white / black / Mauve / Amethyst | SVG + PNG 1451×1076 |
| Logo-typeface Assets 3/4/5/10 | Wordmark in Amethyst / Mauve / black / white | SVG + PNG 1847×522 |
| Loose "Artboard" PNGs | Padded full-canvas exports incl. white-on-black reverse | PNG 4501×4501 |

`[FLAG §8-C4: bare black mark/wordmark files exist (Assets 5, 7) but a black/mono version is not among the four official variations — confirm whether mono-black is permitted.]`

## 4. Iconography

- `[OFFICIAL]` (p.19) Icon system "inspired by the rhythm of a heartbeat"; every icon carries a "signature zigzag detail". 24 icons shown in the guidelines; 25 SVG files delivered (health/medical/news subjects: heart-pulse, DNA, stethoscope, hospital, brain, lungs, microscope, search-pulse, location-pulse, calendar, video, mail, shield, doctor, etc.).
- Style (verified in files): monoline outline style built as **filled paths** (not strokes), rounded joins, single color, hardcoded `fill: #1D0446`; no currentColor; non-square viewBoxes ≈ 67–116 units.
- `[OFFICIAL]` (p.21) **Rhythm Codes:** each content type has its own "heartbeat" line derived from the logo pulse — Breaking/عاجل (fast, heavy spikes), Daily Dose/الجرعة اليومية (small spikes), Research/أبحاث ودراسات (smooth sine), Events/فعاليات ومؤتمرات (regular zigzag). Uses: section dividers, tag icons, loading animations, video intros; designed to work in one color and for color-blind readers.
- `[OFFICIAL — absent]` No icon grid, stroke width, or size values printed `[FLAG §8-M9]`.
- `[RECOMMENDATION]` For the web: inline the SVGs and normalize fills to `currentColor` at build time (a mechanical, reversible transform of copies — originals untouched) so icons can inherit text color and theme correctly.

## 5. Visual Identity Principles

`[OFFICIAL]` statements:
- Healthcare "trust and professionalism" + "warmth, empathy, and vitality"; the identity should feel "credible, human, and approachable" (p.11).
- The wordmark "balances authenticity and modernity" (p.2); the Arabic type is "bold, distinctive, and recognizable" (p.16); the Latin pairing is "professional and approachable" (p.17).
- The **heartbeat/pulse** is the central brand motif (logo symbol, icon zigzags, Rhythm Codes) (pp.5, 19, 21).
- Sample brand lines: «نبض الأخبار الطبية» / "THE PULSE OF MEDICAL NEWS." (pp.16–17).

`[OBSERVED]` visual language across the guidelines: generous rounded-corner containers and pill shapes everywhere; flat color fields (no gradients except photo overlays); candid natural-light photography; monoline Amethyst illustrations on Mauve; category color-coding via secondary-palette tags.

## 6. Responsive Branding Considerations `[RECOMMENDATION unless cited]`

- **Token mapping for the web:** Amethyst = ink/primary text + primary buttons; Seashell = page surface (the guidelines' own mobile mockup uses a Seashell/near-white background, p.22 `[OBSERVED]`); white = card surface; Mauve = interactive accents, bands, selected states (never text on light); Vanilla = highlight tags with Amethyst text; secondary palette = category coding (tags/tiles), mapping naturally onto the existing per-category accent system the admin already controls.
- **Breaking ticker:** the guidelines' mockup shows a Mauve ticker bar with an Amethyst «عاجل» pill (p.22) `[OBSERVED]` — a direct replacement for the old coral/ink scheme; behavior stays per Homepage Spec §6-A.
- **Logo responsive use:** wordmark in the header (≥150px per the minimum); symbol tile for favicon, app icons, avatars, and tight mobile contexts (≥50px). The symbol's rounded-square tile works directly as the favicon/PWA icon set.
- **Dark surfaces:** Amethyst panels with Mauve/white content are officially sanctioned (variations p.7, examples pp.3, 21); a full dark mode has no official palette `[FLAG §8-M10]`.
- **Accessibility deltas to engineer around** (no official guidance `[FLAG §8-M2]`): all light brand colors fail as text on light surfaces (§1.4) — enforce the safe-pairs table; keep the existing functional accessibility standards (Homepage Spec §6-A #10).
- **Icons:** convert copies to currentColor (§4); render at consistent optical size despite non-square viewBoxes (wrap in a fixed-box component).
- **Rhythm Codes on the web:** natural fits are section dividers, category tags, and the loading/skeleton states — with `prefers-reduced-motion` honored for any animated pulse.

## 7. Recommended Web Assets `[RECOMMENDATION]`

- **Logo:** use the delivered SVGs (vector, tiny): wordmark Amethyst (Logo-typeface Asset 3) as the default header logo; wordmark white (Asset 10) on dark/photo; symbol tiles (Logo-Icon Assets 1/2) for favicon/avatar/app icon; bare marks (Assets 8/9) for inline badge uses. PNGs only for social/OG fallbacks.
- **Fonts:** convert to WOFF2 for self-hosting — **gated on licensing**: DM Sans immediately (OFL; or load the same family via Google Fonts); KO Sans only after the Kotype license is confirmed to cover web embedding; do not convert Adobe Arabic, SF Pro, or Arial at all. Seabass pending the missing file.
- **Icons:** the 25 SVGs, inlined with normalized fills (copies, not originals).
- **Proposed repo location** (when approved): `design/brand/` for originals + `src/` integration via next/font local for licensed WOFF2 files. Nothing has been copied into the repo yet.

## 8. Missing Information or Conflicting Guidelines

### Conflicts / anomalies

- **C1 — Vanilla Custard tint ramp anomaly:** printed 50% (`#FAF4D0`) is darker than 60% (`#F9F3D3`) — likely a guidelines typo; needs confirmation before tokenizing the ramp.
- **C2 — Seabass is specified but not delivered:** the official Latin headline face has no font file in the package. Status per owner clarification K2 (2026-11-22): asset PENDING; a clearly labeled temporary substitute is allowed in mockups only. Still open: delivery of the file + license.
- **C3 — Five delivered font families are not in the guidelines** (Adobe Arabic, SF Pro Display, Arial, Manrope, Readex Pro). Their intended role is unknown; not treated as approved for the website.
- **C4 — Black/mono logo files exist but mono usage is not among the four official variations.** Confirm whether single-color black (e.g. print, fax, embossing, high-contrast mode) is permitted.
- **C5 — Brand handles "SALMA.CO" / "SALMA.HEALTH"** appear in mockups while the actual production domain is undecided (roadmap §8.B; salma.news unconnected). Mockup artifacts, not domain decisions.

### Missing (not specified in the guidelines; flagged, not invented)

- **M1** — Formal role assignments for the primary colors (background/text/accent) — only observable from examples.
- **M2** — Contrast/accessibility rules, approved/forbidden color pairings, minimum text sizes.
- **M3** — Web/CSS specs: spacing scale, grid, breakpoints, corner-radius values, shadows, component states (hover/focus), motion specs.
- **M4** — KO Sans ExtraBold (referenced "where available") not delivered.
- **M5** — KO Sans license terms/webfont rights (file says "All rights reserved"; no license document in the package). Status per owner clarification K1 (2026-11-22): KO Sans stays the intended typeface; production embedding blocked until verification. Still open: the verification itself.
- **M6** — Type scale: sizes, line heights, tracking, fallbacks, Arabic↔Latin size relationship.
- **M7** — Latin/English wordmark lockup; favicon size set; logo on backgrounds other than Amethyst/Mauve/Seashell/photo.
- **M8** — Numeric clear-space formula (diagram only) and print minimum sizes.
- **M9** — Icon grid/stroke/size specs and icon color variants.
- **M10** — Dark-mode palette or rules.
- **M11** — Photography/illustration written rules; image overlay/treatment specs.
- **M12** — Voice & tone guidelines (only positioning adjectives exist).
- **M13** — Co-branding numeric ratios.
- **M14** — Pantone/spot colors and print production specs.

### Note on the guidelines' website mockups (pp.22–24)

The guidelines include homepage mockups (Seashell surface, pill navigation, Mauve ticker with Amethyst «عاجل» pill, Vanilla «الأبرز» tag, hero carousel with dots, «آخر الأخبار» sidebar, a mega-menu concept, ticker arrows). These are **brand application examples, not functional specs**: where they conflict with the approved functional baseline (`SALMA_HOMEPAGE_SPEC.md` §6-A), the baseline governs unless the owner approves a change. They will, however, serve as a strong starting reference for the Homepage design directions.

---

*End of brand identity baseline. Changes after approval must be explicit and dated.*
