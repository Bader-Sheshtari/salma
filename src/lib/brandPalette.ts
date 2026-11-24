// SALMA official palette — SOURCE OF TRUTH: Salma Brand Guidelines (PDF),
// pages 11–14 ("Primary colors", "Primary colors tints", "Secondary colors",
// "Secondary colors tints"). Every hex below is transcribed verbatim from the
// guideline's text layer (pdftotext) and cross-checked against the rendered
// swatches — nothing here is derived or computed.
//
// Note (verbatim, not corrected): Vanilla Custard 50 is #FAF4D0 in the
// guideline, i.e. slightly more saturated than its 60 step (#F9F3D3). It is
// kept exactly as published.
//
// Pure module (no React/Next imports) so `node --test` can exercise it.

export const TINT_STEPS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10] as const;
export type TintStep = (typeof TINT_STEPS)[number];

export type BrandFamily = {
  /** Stable key used in `homepage_sections.accent` (e.g. "teal", "teal-20"). */
  key: FamilyKey;
  ar: string;
  en: string;
  /** Primary or secondary palette (guideline pages 11 vs 13). */
  group: "primary" | "secondary";
  /** Official tint scale, 100 (base) → 10. */
  tints: Record<TintStep, string>;
};

export const FAMILY_KEYS = [
  "amethyst",
  "mauve",
  "vanilla",
  "seashell",
  "golden",
  "pumpkin",
  "frost",
  "pink",
  "wine",
  "coffee",
  "jet",
  "teal",
] as const;
export type FamilyKey = (typeof FAMILY_KEYS)[number];

const scale = (hexes: string[]): Record<TintStep, string> =>
  Object.fromEntries(TINT_STEPS.map((s, i) => [s, hexes[i]])) as Record<TintStep, string>;

export const BRAND_FAMILIES: Record<FamilyKey, BrandFamily> = {
  amethyst: {
    key: "amethyst",
    ar: "أميثست داكن",
    en: "Dark Amethyst",
    group: "primary",
    tints: scale(["#1D0446", "#341D59", "#4A366B", "#61507E", "#776890", "#8E82A3", "#A59BB5", "#BBB4C8", "#D2CCDA", "#E8E6ED"]),
  },
  mauve: {
    key: "mauve",
    ar: "موف",
    en: "Mauve",
    group: "primary",
    tints: scale(["#C6A9FD", "#CBB2FD", "#D1BBFD", "#D6C4FD", "#DCCDFE", "#E2D4FE", "#E7DDFE", "#EDE6FE", "#F3EEFE", "#F9F7FF"]),
  },
  vanilla: {
    key: "vanilla",
    ar: "فانيلا كاسترد",
    en: "Vanilla Custard",
    group: "primary",
    tints: scale(["#F5E9A4", "#F6ECB0", "#F7EEBC", "#F8F1C7", "#F9F3D3", "#FAF4D0", "#FBF6DD", "#FCF8E8", "#FDFBF2", "#FEFDF9"]),
  },
  seashell: {
    key: "seashell",
    ar: "صدفي",
    en: "Seashell",
    group: "primary",
    tints: scale(["#F1E5E0", "#F2E8E4", "#F3EBE7", "#F5EEEB", "#F6F1EE", "#F8F2F0", "#F9F5F3", "#FAF7F6", "#FCFAF9", "#FDFCFB"]),
  },
  golden: {
    key: "golden",
    ar: "ذهبي اللقاح",
    en: "Golden Pollen",
    group: "secondary",
    tints: scale(["#FBCF50", "#FBD462", "#FCD973", "#FCDD84", "#FDE296", "#FDE7A8", "#FDECB9", "#FEF1CA", "#FEF5DC", "#FFFAEE"]),
  },
  pumpkin: {
    key: "pumpkin",
    ar: "قرع متبّل",
    en: "Pumpkin Spice",
    group: "secondary",
    tints: scale(["#FF7307", "#FF8120", "#FF8F39", "#FF9D51", "#FFAB6A", "#FFB983", "#FFC79C", "#FFD5B5", "#FFE3CD", "#FFF1E6"]),
  },
  frost: {
    key: "frost",
    ar: "أزرق ثلجي",
    en: "Frosted Blue",
    group: "secondary",
    tints: scale(["#8AD4DD", "#96D8E0", "#A1DDE4", "#ADE1E7", "#B9E5EB", "#C4EAEE", "#D0EEF1", "#DCF2F5", "#E8F6F8", "#F3FBFC"]),
  },
  pink: {
    key: "pink",
    ar: "وردي ضبابي",
    en: "Pink Mist",
    group: "secondary",
    tints: scale(["#FC97B9", "#FCA1C0", "#FDACC7", "#FDB6CE", "#FDC1D5", "#FECBDC", "#FED5E3", "#FEE0EA", "#FEEAF1", "#FFF5F8"]),
  },
  wine: {
    key: "wine",
    ar: "نبيذي",
    en: "Wine Plum",
    group: "secondary",
    tints: scale(["#662832", "#753D46", "#85535B", "#946970", "#A37E84", "#B29498", "#C2A9AD", "#D1BEC2", "#E0D4D6", "#F0EAEA"]),
  },
  coffee: {
    key: "coffee",
    ar: "بن",
    en: "Coffee Bean",
    group: "secondary",
    tints: scale(["#2D1318", "#422B2F", "#574246", "#6C5A5D", "#817174", "#96898C", "#ABA1A3", "#C0B8BA", "#D5D0D1", "#EAE7E8"]),
  },
  jet: {
    key: "jet",
    ar: "أسود نفاث",
    en: "Jet Black",
    group: "secondary",
    tints: scale(["#2B3A36", "#404E4A", "#55615E", "#6B7572", "#808986", "#959C9A", "#AAB0AF", "#BFC4C3", "#D5D8D7", "#EAEBEB"]),
  },
  teal: {
    key: "teal",
    ar: "أخضر مزرق هادئ",
    en: "Muted Teal",
    group: "secondary",
    tints: scale(["#8FB8AD", "#9ABFB5", "#A5C6BD", "#B1CDC6", "#BCD4CE", "#C7DCD6", "#D2E3DE", "#DDEAE6", "#E9F1EF", "#F4F8F7"]),
  },
};

// ------------------------------------------------------------------ contrast
// WCAG 2.x relative luminance / contrast ratio (pure, exact formula).

export function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Text colours a surface may use (official palette only, DG-safe). */
export const TEXT_COLORS = {
  amethyst: "#1D0446",
  amethyst800: "#341D59",
  amethyst600: "#61507E",
  amethyst100: "#E8E6ED",
  white: "#FFFFFF",
} as const;

/** Can this surface host the recipe's text (headline AND body ≥4.5:1 with
 * the official text colours)? Surfaces that can't are offered as `-rule` only. */
export function hostsText(surface: string): boolean {
  const darkText = contrast(TEXT_COLORS.amethyst, surface) >= 4.5 && contrast(TEXT_COLORS.amethyst800, surface) >= 4.5;
  const lightText = contrast(TEXT_COLORS.white, surface) >= 4.5 && contrast(TEXT_COLORS.amethyst100, surface) >= 4.5;
  return darkText || lightText;
}
