// DF — Section identity map (docs/SALMA_HOMEPAGE_IMPLEMENTATION_PLAN.md §2 DF;
// docs/SALMA_HOMEPAGE_VISUAL_DIRECTION.md §2 identity map, §3 composition rules,
// §4 contrast rules). The ONE place where a homepage section's admin-managed
// `homepage_sections.accent` value is translated into a complete visual
// identity: surface, accent devices and text rules travel together, so changing
// `accent` in Admin always applies a coherent identity, never a partial restyle.
// No category slugs live here or in components; unknown/empty/legacy-hex values
// fall back to PAPER (paper surface + amethyst rule) — always safe.
//
// Pure module (no React/Next imports) so `node --test` can exercise it.
// Every class string is a literal so Tailwind's source scan picks it up.
// Colours: official palette + approved tints only (Phase 2a tokens); raw hex
// only where no token exists (pink-30 #FED5E3, jet-20 #D5D8D7 — official ramp
// values). DG is deferred: coloured TYPE is only amethyst / wine / jet.

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
export type IdentityKey = (typeof IDENTITY_KEYS)[number];

export type Identity = {
  key: IdentityKey;
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

const PAPER: Identity = {
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

const MAP: Record<IdentityKey, Identity> = {
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

/** Normalises an admin `accent` value to an identity key; anything unknown
 * (empty, null, legacy hex colours, typos) → "paper". */
export function identityKey(accent: string | null | undefined): IdentityKey {
  const v = (accent ?? "").trim().toLowerCase();
  return (IDENTITY_KEYS as readonly string[]).includes(v) ? (v as IdentityKey) : "paper";
}

/** The complete identity for an admin `accent` value (paper fallback). */
export function identityFor(accent: string | null | undefined): Identity {
  return MAP[identityKey(accent)];
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
      return id.key === "pink" ? "numbered" : id.key === "wine" ? "text-led" : "rows";
    case "featured":
      if (id.key === "jet") return "open21";
      if (id.key === "mauve") return "feature-side";
      if (id.key === "pink") return "lead-numbered";
      if (id.key === "teal") return "columns";
      if (id.key === "wine") return "text-led";
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
