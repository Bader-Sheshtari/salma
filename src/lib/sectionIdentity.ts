// DF — Section identity map (docs/SALMA_HOMEPAGE_IMPLEMENTATION_PLAN.md §2 DF;
// docs/SALMA_HOMEPAGE_VISUAL_DIRECTION.md §2 identity map, §3 composition rules,
// §4 contrast rules). The ONE place where a homepage section's admin-managed
// `homepage_sections.accent` value is translated into a complete visual
// identity: surface, accent devices and text rules travel together, so changing
// `accent` in Admin always applies a coherent identity, never a partial restyle.
// No category slugs live here or in components; unknown/empty/legacy-hex values
// fall back to PAPER (paper surface + amethyst rule) — always safe.
//
// GRAMMAR (owner-approved Color Picker): accent =
//   ""/unknown            → paper (always safe)
//   legacy key            → the exact refined-H1 recipe (LEGACY below, frozen)
//   "<family>"            → that family's default recipe (legacy families keep
//                           their legacy recipe; new families: see FAMILY_DEFAULTS)
//   "<family>-<tint>"     → that official tint as the section surface
//   "<family>-rule"       → paper surface + that family's devices
// Families and tints come only from `lib/brandPalette.ts` (official guideline).
//
// Pure module (no React/Next imports) so `node --test` can exercise it.
// Every class string is a literal so Tailwind's source scan picks it up;
// palette-generated recipes carry their colours as CSS custom properties
// (`vars`) consumed by literal `[var(--id-*)]` classes.
// Colours: official palette + approved tints only (Phase 2a tokens); raw hex
// only where no token exists (pink-30 #FED5E3, jet-20 #D5D8D7 — official ramp
// values). DG is deferred: coloured TYPE is only amethyst / wine / jet.

import {
  BRAND_FAMILIES,
  DAWI_COLORS,
  DAWI_KEYS,
  DAWI_SHADES,
  FAMILY_KEYS,
  TEXT_COLORS,
  TINT_STEPS,
  contrast,
  hostsText,
  type DawiKey,
  type DawiShade,
  type FamilyKey,
  type TintStep,
} from "./brandPalette.ts";

export const IDENTITY_KEYS = [
  "paper",
  "frost-rule",
  "teal",
  "pink",
  "jet",
  "frost",
  "mauve",
  "wine",
  "vanilla",
] as const;
/** Legacy refined-H1 keys (frozen recipes). */
export type IdentityKey = (typeof IDENTITY_KEYS)[number];

type LegacyIdentity = {
  key: string;
  /** Tinted surface? Tinted fields own ≥48px paper margins (§3 rule 2). */
  field: boolean;
  /** Section surface (background) classes; "" = page paper. */
  surface: string;
  /** 28×3px rule start of the section heading. */
  rule: string;
  /** Remainder of the heading rule (1px hairline). */
  ruleLine: string;
  /** Hairlines between stories on this surface. */
  hairline: string;
  /** Headline text colour (official colours only, §4). */
  headline: string;
  /** Excerpt / meta text colour (≥4.5:1 on this surface, §4). */
  body: string;
  /** Reading-time pill background (amethyst text on it). */
  pill: string;
  /** Category mark (graphic only, 14×3px). Used by the lead board via the
   * category → section identity link. */
  mark: string;
  /** 48px icon-tile background on PAPER (graphic) — used for this
   * identity's stories inside mixed collections (lead board). */
  tile: string;
  /** Icon-tile background on this identity's OWN surface. */
  fieldTile: string;
  /** Image placeholder ground. */
  ground: string;
  /** Hover background of the «عرض الكل» link. */
  linkHover: string;
  /** Optional devices — present only on the identity that owns them. */
  underline?: string; // teal: 3px headline underline (graphic)
  disc?: string; // pink: numeral discs (amethyst numerals on pink-100, 6.6:1)
  cap?: string; // jet: 3px cap over the side column
  drop?: string; // wine drop rule / frost-rule standfirst rule
};

/** A complete identity: the legacy recipe fields plus the generalised ones. */
export type Identity = LegacyIdentity & {
  /** Brand family the recipe belongs to (anatomy variants); null = paper. */
  family: FamilyKey | null;
  /** Dark surface (light text)? */
  dark: boolean;
  /** Primary ink for titles/links on this surface. */
  ink: string;
  /** Text colour on the reading-time pill. */
  pillText: string;
  /** Divider colour between transfer rows. */
  divide: string;
  /** Palette-generated recipes only: CSS custom properties for the section. */
  vars?: Record<string, string>;
  /** Palette-generated recipes only: inline colour for the lead-board mark/tile. */
  markStyle?: { backgroundColor: string };
  tileStyle?: { backgroundColor: string };
};

const PAPER: LegacyIdentity = {
  key: "paper",
  field: false,
  surface: "",
  rule: "bg-amethyst",
  ruleLine: "bg-hairline-strong",
  hairline: "border-hairline",
  headline: "text-amethyst",
  body: "text-amethyst-600",
  pill: "bg-amethyst-100",
  mark: "bg-amethyst-400",
  tile: "bg-mauve-20",
  fieldTile: "bg-mauve-20",
  ground: "bg-seashell-2",
  linkHover: "hover:bg-seashell-2",
};

// FROZEN — the approved refined-H1 recipes. Owner condition 3: these keys must
// resolve to exactly these recipes (asserted against a snapshot in tests).
const LEGACY: Record<IdentityKey, LegacyIdentity> = {
  paper: PAPER,
  // الكويت-style: paper + 3px frost rule beside the lead standfirst.
  "frost-rule": {
    ...PAPER,
    key: "frost-rule",
    rule: "bg-frosted-blue",
    pill: "bg-frosted-blue-30",
    mark: "bg-frosted-blue",
    tile: "bg-frosted-blue-30",
    fieldTile: "bg-frosted-blue-30",
    drop: "border-frosted-blue",
  },
  // الخليج-style: teal-20 field; teal-100 is GRAPHIC ONLY (1.9:1 on its field).
  teal: {
    ...PAPER,
    key: "teal",
    field: true,
    surface: "bg-muted-teal-20",
    rule: "bg-muted-teal",
    ruleLine: "bg-muted-teal",
    hairline: "border-muted-teal-30",
    pill: "bg-muted-teal-30",
    mark: "bg-muted-teal",
    tile: "bg-muted-teal-30",
    fieldTile: "bg-muted-teal-30",
    ground: "bg-muted-teal-30",
    linkHover: "hover:bg-white/60",
    underline: "decoration-muted-teal",
  },
  // اقتصاد-style: pink-10 field; amethyst numerals on pink-100 discs.
  pink: {
    ...PAPER,
    key: "pink",
    field: true,
    surface: "bg-pink-mist-10",
    rule: "bg-pink-mist",
    pill: "bg-[#fed5e3]",
    mark: "bg-pink-mist",
    tile: "bg-[#fed5e3]",
    fieldTile: "bg-[#fed5e3]",
    linkHover: "hover:bg-white/60",
    disc: "bg-pink-mist",
  },
  // العالم-style: paper + jet ink (rule start + 3px cap).
  jet: {
    ...PAPER,
    key: "jet",
    rule: "bg-jet-black",
    mark: "bg-jet-black",
    tile: "bg-[#d5d8d7]",
    fieldTile: "bg-[#d5d8d7]",
    cap: "border-jet-black",
  },
  // صحة وحياة-style: frost-100 field — text strictly amethyst / amethyst-800 (§4).
  frost: {
    ...PAPER,
    key: "frost",
    field: true,
    surface: "bg-frosted-blue",
    rule: "bg-amethyst",
    ruleLine: "bg-amethyst/30",
    hairline: "border-amethyst/20",
    body: "text-amethyst-800",
    pill: "bg-frosted-blue-30",
    mark: "bg-frosted-blue",
    tile: "bg-frosted-blue-30",
    fieldTile: "bg-frosted-blue-30",
    ground: "bg-frosted-blue-40",
    linkHover: "hover:bg-frosted-blue-40",
  },
  // داوي-style: mauve-20 wash.
  mauve: {
    ...PAPER,
    key: "mauve",
    field: true,
    surface: "bg-mauve-20",
    rule: "bg-mauve",
    hairline: "border-amethyst/15",
    pill: "bg-white",
    mark: "bg-mauve",
    tile: "bg-mauve-20",
    fieldTile: "bg-white",
    linkHover: "hover:bg-white/60",
  },
  // تحقيقات-style: wine-10 field, wine headline ink (9.2:1) + drop rule.
  wine: {
    ...PAPER,
    key: "wine",
    field: true,
    surface: "bg-wine-plum-10",
    rule: "bg-wine-plum",
    ruleLine: "bg-wine-plum-20",
    hairline: "border-wine-plum-20",
    headline: "text-wine-plum",
    pill: "bg-wine-plum-20",
    mark: "bg-wine-plum",
    tile: "bg-wine-plum-20",
    fieldTile: "bg-wine-plum-20",
    ground: "bg-wine-plum-20",
    linkHover: "hover:bg-white/60",
    drop: "border-wine-plum",
  },
  // انتقالات-style: vanilla-40 field, golden-100 rule (journey arrow is the
  // transfers component's own graphic, --color-journey-arrow).
  vanilla: {
    ...PAPER,
    key: "vanilla",
    field: true,
    surface: "bg-vanilla-40",
    rule: "bg-golden-pollen",
    ruleLine: "bg-amethyst/20",
    hairline: "border-amethyst/10",
    pill: "bg-white",
    mark: "bg-golden-pollen",
    tile: "bg-vanilla-40",
    fieldTile: "bg-white",
    linkHover: "hover:bg-white/60",
  },
};

const LEGACY_FAMILY: Record<IdentityKey, FamilyKey | null> = {
  paper: null,
  "frost-rule": "frost",
  teal: "teal",
  pink: "pink",
  jet: "jet",
  frost: "frost",
  mauve: "mauve",
  wine: "wine",
  vanilla: "vanilla",
};

function fromLegacy(k: IdentityKey): Identity {
  const l = LEGACY[k];
  return {
    ...l,
    family: LEGACY_FAMILY[k],
    dark: false,
    ink: "text-amethyst",
    pillText: "text-amethyst",
    divide: l.field ? "divide-amethyst/10" : "divide-hairline",
  };
}

/** The pre-generalisation recipe of a legacy key (exact, for regression tests). */
export function legacyRecipe(k: IdentityKey): LegacyIdentity {
  return LEGACY[k];
}

// ------------------------------------------------------------------ grammar

/** Default tint for a bare family key. Legacy families (teal, pink, frost,
 * mauve, wine, vanilla, jet) resolve to their frozen legacy recipe instead;
 * the tint listed for them is only what that recipe's surface corresponds to
 * (used by the picker's «الافتراضي» badge). "rule" = paper surface. */
export const FAMILY_DEFAULTS: Record<FamilyKey, TintStep | "rule"> = {
  teal: 20,
  pink: 10,
  frost: 100,
  mauve: 20,
  wine: 10,
  vanilla: 40,
  jet: "rule",
  // New families (owner-approved defaults):
  golden: 20, // light warm surface
  seashell: 60, // quiet light surface (= the seashell-2 well)
  pumpkin: 10, // warm, pumpkin-10-style
  amethyst: 100, // dark surface, light text
  coffee: 100, // dark surface, light text
};

export type ParsedAccent =
  | { kind: "paper" }
  | { kind: "legacy"; key: IdentityKey }
  | { kind: "family"; family: FamilyKey; tint: TintStep | "rule" }
  | { kind: "dawi"; color: DawiKey; shade: DawiShade | "rule" };

const isFamily = (v: string): v is FamilyKey => (FAMILY_KEYS as readonly string[]).includes(v);
const isDawi = (v: string): v is DawiKey => (DAWI_KEYS as readonly string[]).includes(v);

/** Parses and validates an admin accent against the official palette.
 * Case/whitespace-insensitive; anything unrecognised → paper. Legacy keys
 * (including bare legacy families and "frost-rule") resolve to "legacy".
 * DAWI brand colors live in their own `dawi-` namespace, so they can never
 * collide with a SALMA family (e.g. `dawi-teal` vs `teal`). */
export function parseAccent(accent: string | null | undefined): ParsedAccent {
  const v = (accent ?? "").trim().toLowerCase();
  if (!v || v === "paper") return { kind: "paper" };
  if ((IDENTITY_KEYS as readonly string[]).includes(v)) return { kind: "legacy", key: v as IdentityKey };
  if (v.startsWith("dawi-")) {
    const d = /^([a-z]+)(?:-(light|rule))?$/.exec(v.slice(5));
    if (!d || !isDawi(d[1])) return { kind: "paper" };
    const shade = (d[2] ?? "primary") as DawiShade | "rule";
    if (shade !== "rule" && !hostsText(DAWI_COLORS[d[1]].shades[shade])) return { kind: "paper" };
    return { kind: "dawi", color: d[1], shade };
  }
  if (isFamily(v)) {
    const d = FAMILY_DEFAULTS[v];
    return { kind: "family", family: v, tint: d };
  }
  const m = /^([a-z]+)-(rule|100|90|80|70|60|50|40|30|20|10)$/.exec(v);
  if (!m || !isFamily(m[1])) return { kind: "paper" };
  const tint = m[2] === "rule" ? "rule" : (Number(m[2]) as TintStep);
  if (tint !== "rule" && !hostsText(BRAND_FAMILIES[m[1]].tints[tint])) return { kind: "paper" };
  return { kind: "family", family: m[1], tint };
}

/** The accent string a DAWI picker selection writes. */
export function dawiAccent(color: DawiKey, shade: DawiShade | "rule"): string {
  return shade === "primary" ? `dawi-${color}` : `dawi-${color}-${shade}`;
}

/** DAWI shades a pair offers as a SURFACE (text can be hosted, same standard
 * as the SALMA tints); the rest are offered as `-rule` only. */
export function offeredDawiShades(color: DawiKey): DawiShade[] {
  return DAWI_SHADES.filter((s) => hostsText(DAWI_COLORS[color].shades[s]));
}

/** The accent string a picker selection writes: a family's DEFAULT writes the
 * bare family key (legacy families → their frozen recipe); frost+rule writes
 * the legacy "frost-rule"; anything else `family-<tint|rule>`. */
export function accentFor(family: FamilyKey, tint: TintStep | "rule"): string {
  if (FAMILY_DEFAULTS[family] === tint) return family;
  if (family === "frost" && tint === "rule") return "frost-rule";
  return `${family}-${tint}`;
}

/** Normalised identity key for an accent ("paper" when unknown). */
export function identityKey(accent: string | null | undefined): string {
  const p = parseAccent(accent);
  if (p.kind === "paper") return "paper";
  if (p.kind === "legacy") return p.key;
  if (p.kind === "dawi") return dawiAccent(p.color, p.shade);
  return `${p.family}-${p.tint}`;
}

/** Page paper (homepage ground) — the surface of `-rule` recipes. */
const PAPER_HEX = "#FCFAF9";
const HAIRLINE_HEX = "#E8E6ED";

const step = (t: TintStep, by: number): TintStep | null => {
  const i = TINT_STEPS.indexOf(t) + by;
  return i >= 0 && i < TINT_STEPS.length ? TINT_STEPS[i] : null;
};

/** First candidate text colour reaching ≥4.5:1 on the surface. */
const pick = (surface: string, candidates: [string, string][]): string | null => {
  for (const [cls, hex] of candidates) if (contrast(hex, surface) >= 4.5) return cls;
  return null;
};

/**
 * Recipe builder for palette accents (fixed rules, documented):
 *  - surface = the chosen official tint (rule → page paper, no field).
 *  - text NEVER uses the selected colour: light surfaces → amethyst headline,
 *    amethyst-600 / -800 / amethyst body (first ≥4.5:1); dark surfaces →
 *    white headline, amethyst-100 / white body (first ≥4.5:1).
 *  - devices (rule, cap, drop, underline) = family 100 on light surfaces (or
 *    amethyst when 100 is nearly invisible there, <1.5:1); family 30 on dark.
 *  - pills / grounds / tiles = 2 steps lighter than the surface (white past
 *    10); on dark surfaces family 30. Pill text = amethyst or white, ≥4.5:1.
 *  - discs = family 100 when amethyst numerals reach ≥4.5:1 on it, else 30.
 *  - hairlines = 2 steps darker than a light surface (official hairline on
 *    paper); 3 steps lighter on a dark surface.
 */
function buildRecipe(family: FamilyKey, tint: TintStep | "rule"): Identity {
  const T = BRAND_FAMILIES[family].tints;
  const rule = tint === "rule";
  const surfaceHex = rule ? PAPER_HEX : T[tint];
  const dark = !rule && contrast(TEXT_COLORS.white, surfaceHex) > contrast(TEXT_COLORS.amethyst, surfaceHex);

  const headline = dark ? "text-white" : "text-amethyst";
  const body = dark
    ? pick(surfaceHex, [["text-amethyst-100", TEXT_COLORS.amethyst100], ["text-white", TEXT_COLORS.white]])
    : pick(surfaceHex, [
        ["text-amethyst-600", TEXT_COLORS.amethyst600],
        ["text-amethyst-800", TEXT_COLORS.amethyst800],
        ["text-amethyst", TEXT_COLORS.amethyst],
      ]);

  const dev = dark
    ? T[30]
    : contrast(T[100], surfaceHex) >= 1.5
      ? T[100]
      : TEXT_COLORS.amethyst;

  let pill: string;
  if (rule) pill = T[30];
  else if (dark) pill = T[30];
  else {
    const lighter = step(tint as TintStep, 2);
    pill = lighter ? T[lighter] : "#FFFFFF";
  }
  if (contrast(TEXT_COLORS.amethyst, pill) < 4.5 && contrast(TEXT_COLORS.white, pill) < 4.5) pill = "#FFFFFF";
  const pillText = contrast(TEXT_COLORS.amethyst, pill) >= 4.5 ? "text-amethyst" : "text-white";

  const disc = contrast(TEXT_COLORS.amethyst, T[100]) >= 4.5 && !dark ? T[100] : T[30];
  const line = rule
    ? HAIRLINE_HEX
    : dark
      ? T[step(tint as TintStep, 3) ?? 10]
      : T[step(tint as TintStep, -2) ?? 100];
  const mark = contrast(T[100], PAPER_HEX) >= 1.3 ? T[100] : TEXT_COLORS.amethyst600;
  const ink = dark ? "text-white" : "text-amethyst";

  return {
    key: `${family}-${tint}`,
    family,
    dark,
    field: !rule,
    surface: rule ? "" : dark ? "bg-[var(--id-surface)] [&_:focus-visible]:outline-mauve!" : "bg-[var(--id-surface)]",
    rule: "bg-[var(--id-rule)]",
    ruleLine: "bg-[var(--id-line)]",
    hairline: "border-[var(--id-line)]",
    headline,
    body: body ?? "text-amethyst",
    pill: "bg-[var(--id-pill)]",
    pillText,
    mark: "",
    tile: "",
    fieldTile: "bg-[var(--id-pill)]",
    ground: "bg-[var(--id-pill)]",
    linkHover: "hover:bg-[var(--id-pill)]",
    underline: "decoration-[var(--id-dev)]",
    disc: "bg-[var(--id-disc)]",
    cap: "border-[var(--id-dev)]",
    drop: "border-[var(--id-dev)]",
    ink,
    divide: "divide-[var(--id-line)]",
    vars: {
      "--id-surface": surfaceHex,
      "--id-rule": dev,
      "--id-dev": dev,
      "--id-line": line,
      "--id-pill": pill,
      "--id-disc": disc,
    },
    markStyle: { backgroundColor: mark },
    tileStyle: { backgroundColor: T[30] },
  };
}

/**
 * Recipe builder for DAWI accents — the same documented coherence rules as
 * `buildRecipe`, expressed over a documented PAIR instead of a 10-step scale
 * (no tints are invented; owner requirement):
 *  - surface = the chosen official shade (rule → page paper, no field).
 *  - text NEVER uses the selected colour (same candidates / ≥4.5:1 rule).
 *  - devices = the pair's primary on light surfaces (amethyst when nearly
 *    invisible there, <1.5:1); the pair's light shade on dark surfaces.
 *  - pills / grounds / tiles = the pair's light shade (white when the surface
 *    IS the light shade, or when no official text reaches 4.5:1 on it).
 *  - hairlines = official amethyst-10 hairline on light surfaces and rule;
 *    the pair's light shade on dark surfaces.
 */
function buildDawiRecipe(color: DawiKey, shade: DawiShade | "rule"): Identity {
  const c = DAWI_COLORS[color];
  const rule = shade === "rule";
  const surfaceHex = rule ? PAPER_HEX : c.shades[shade];
  const dark = !rule && contrast(TEXT_COLORS.white, surfaceHex) > contrast(TEXT_COLORS.amethyst, surfaceHex);

  const headline = dark ? "text-white" : "text-amethyst";
  const body = dark
    ? pick(surfaceHex, [["text-amethyst-100", TEXT_COLORS.amethyst100], ["text-white", TEXT_COLORS.white]])
    : pick(surfaceHex, [
        ["text-amethyst-600", TEXT_COLORS.amethyst600],
        ["text-amethyst-800", TEXT_COLORS.amethyst800],
        ["text-amethyst", TEXT_COLORS.amethyst],
      ]);

  const dev = dark
    ? c.shades.light
    : contrast(c.shades.primary, surfaceHex) >= 1.5
      ? c.shades.primary
      : TEXT_COLORS.amethyst;

  let pill = shade === "light" ? "#FFFFFF" : c.shades.light;
  if (contrast(TEXT_COLORS.amethyst, pill) < 4.5 && contrast(TEXT_COLORS.white, pill) < 4.5) pill = "#FFFFFF";
  const pillText = contrast(TEXT_COLORS.amethyst, pill) >= 4.5 ? "text-amethyst" : "text-white";

  const disc = contrast(TEXT_COLORS.amethyst, c.shades.primary) >= 4.5 && !dark ? c.shades.primary : c.shades.light;
  const line = dark ? c.shades.light : HAIRLINE_HEX;
  const mark = contrast(c.shades.primary, PAPER_HEX) >= 1.3 ? c.shades.primary : TEXT_COLORS.amethyst600;
  const ink = dark ? "text-white" : "text-amethyst";

  return {
    key: dawiAccent(color, shade),
    family: null,
    dark,
    field: !rule,
    surface: rule ? "" : dark ? "bg-[var(--id-surface)] [&_:focus-visible]:outline-mauve!" : "bg-[var(--id-surface)]",
    rule: "bg-[var(--id-rule)]",
    ruleLine: "bg-[var(--id-line)]",
    hairline: "border-[var(--id-line)]",
    headline,
    body: body ?? "text-amethyst",
    pill: "bg-[var(--id-pill)]",
    pillText,
    mark: "",
    tile: "",
    fieldTile: "bg-[var(--id-pill)]",
    ground: "bg-[var(--id-pill)]",
    linkHover: "hover:bg-[var(--id-pill)]",
    underline: "decoration-[var(--id-dev)]",
    disc: "bg-[var(--id-disc)]",
    cap: "border-[var(--id-dev)]",
    drop: "border-[var(--id-dev)]",
    ink,
    divide: "divide-[var(--id-line)]",
    vars: {
      "--id-surface": surfaceHex,
      "--id-rule": dev,
      "--id-dev": dev,
      "--id-line": line,
      "--id-pill": pill,
      "--id-disc": disc,
    },
    markStyle: { backgroundColor: mark },
    tileStyle: { backgroundColor: c.shades.light },
  };
}

/** The text/surface pairs a DAWI recipe emits (for audits/tests). */
export function dawiTextPairs(color: DawiKey, shade: DawiShade | "rule"): [string, string, string][] {
  const id = buildDawiRecipe(color, shade);
  const surface = id.vars!["--id-surface"];
  const hex: Record<string, string> = {
    "text-amethyst": TEXT_COLORS.amethyst,
    "text-amethyst-800": TEXT_COLORS.amethyst800,
    "text-amethyst-600": TEXT_COLORS.amethyst600,
    "text-amethyst-100": TEXT_COLORS.amethyst100,
    "text-white": TEXT_COLORS.white,
  };
  return [
    ["headline", hex[id.headline], surface],
    ["body", hex[id.body], surface],
    ["ink", hex[id.ink], surface],
    ["pill", hex[id.pillText], id.vars!["--id-pill"]],
    ["disc-numeral", TEXT_COLORS.amethyst, id.vars!["--id-disc"]],
  ];
}

/** The complete identity for an admin `accent` value (paper fallback). */
export function identityFor(accent: string | null | undefined): Identity {
  const p = parseAccent(accent);
  if (p.kind === "paper") return fromLegacy("paper");
  if (p.kind === "legacy") return fromLegacy(p.key);
  if (p.kind === "dawi") return buildDawiRecipe(p.color, p.shade);
  return buildRecipe(p.family, p.tint);
}

/** The text/surface pairs a recipe emits (for audits/tests): [label, text, surface]. */
export function recipeTextPairs(family: FamilyKey, tint: TintStep | "rule"): [string, string, string][] {
  const id = buildRecipe(family, tint);
  const surface = id.vars!["--id-surface"];
  const hex: Record<string, string> = {
    "text-amethyst": TEXT_COLORS.amethyst,
    "text-amethyst-800": TEXT_COLORS.amethyst800,
    "text-amethyst-600": TEXT_COLORS.amethyst600,
    "text-amethyst-100": TEXT_COLORS.amethyst100,
    "text-white": TEXT_COLORS.white,
  };
  return [
    ["headline", hex[id.headline], surface],
    ["body", hex[id.body], surface],
    ["ink", hex[id.ink], surface],
    ["pill", hex[id.pillText], id.vars!["--id-pill"]],
    ["disc-numeral", TEXT_COLORS.amethyst, id.vars!["--id-disc"]],
  ];
}

/** Tints a family offers as a SURFACE (text can be hosted); the rest are
 * offered as `-rule` only. */
export function offeredTints(family: FamilyKey): TintStep[] {
  return TINT_STEPS.filter((t) => hostsText(BRAND_FAMILIES[family].tints[t]));
}

/**
 * Anatomy = admin `display_style` × identity (DF). Admin's display_style picks
 * the family; the identity picks its signature variant inside that family.
 *   carousel → "rail"   horizontal scroll rail, arrows + counter
 *   grid     → "columns" equal open columns (teal adds underlined headlines)
 *   list     → pink: "numbered" · wine: "text-led" · else "rows"
 *   featured → jet: "open21" · mauve: "feature-side" · pink: "lead-numbered"
 *              · teal: "columns" (underlined pair) · wine: "text-led"
 *              · else "lead-standfirst"
 * Unknown display_style values behave like "grid".
 */
export type Anatomy =
  | "rail"
  | "columns"
  | "rows"
  | "numbered"
  | "text-led"
  | "lead-standfirst"
  | "open21"
  | "feature-side"
  | "lead-numbered";

export function anatomyFor(displayStyle: string | null | undefined, id: Identity): Anatomy {
  switch (displayStyle) {
    case "carousel":
      return "rail";
    case "list":
      return id.family === "pink" ? "numbered" : id.family === "wine" ? "text-led" : "rows";
    case "featured":
      if (id.family === "jet") return "open21";
      if (id.family === "mauve") return "feature-side";
      if (id.family === "pink") return "lead-numbered";
      if (id.family === "teal") return "columns";
      if (id.family === "wine") return "text-led";
      return "lead-standfirst";
    default:
      return "columns";
  }
}

/**
 * §LBL — the ONE category-label condition (plan §2 Rev 3): a story's category
 * tag renders only when its category differs from the collection's own
 * category. Mixed collections (lead board) pass `null`, so tags always show;
 * single-category sections pass their slug, so same-category tags never show.
 */
export function showCategoryTag(
  storyCategory: string | null | undefined,
  collectionCategory: string | null | undefined,
): boolean {
  return !!storyCategory && storyCategory !== (collectionCategory ?? null);
}
