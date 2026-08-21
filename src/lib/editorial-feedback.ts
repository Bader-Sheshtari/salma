/**
 * Editorial Feedback Loop V1 — deterministic edit measurement + taxonomy.
 *
 * Pure functions only (no I/O, no LLM): the same inputs always produce the
 * same magnitudes, so the feedback data stays auditable. Thresholds are
 * documented inline and validated by unit tests.
 */

export type EditMagnitude = "none" | "minor" | "moderate" | "major";

/** Structured rejection reasons (kept small and useful on purpose). */
export const REJECT_REASONS: { code: string; label: string }[] = [
  { code: "not_important", label: "غير مهم" },
  { code: "weak_source", label: "مصدر ضعيف" },
  { code: "duplicate_or_already_covered", label: "مكرر / تمت تغطيته" },
  { code: "too_technical_or_niche", label: "تقني / متخصص جداً" },
  { code: "weak_evidence", label: "أدلة ضعيفة" },
  { code: "not_relevant_to_salma", label: "خارج اهتمام سلمى" },
  { code: "poor_editorial_angle", label: "زاوية تحريرية ضعيفة" },
  { code: "outdated", label: "قديم" },
  { code: "inaccurate_or_unreliable", label: "غير دقيق / غير موثوق" },
  { code: "other", label: "سبب آخر" },
];

const REJECT_REASON_CODES = new Set(REJECT_REASONS.map((r) => r.code));

/** Clamp a submitted rejection reason to the taxonomy (unknown → null). */
export function normalizeRejectReason(raw: unknown): string | null {
  const code = String(raw ?? "").trim();
  return REJECT_REASON_CODES.has(code) ? code : null;
}

/**
 * Light normalization: what we compute difference RATIOS on.
 * Collapses whitespace and strips punctuation so pure punctuation/whitespace
 * shuffles never contribute to edit distance.
 */
export function lightNormalize(text: string): string {
  return (text ?? "")
    .normalize("NFC")
    .replace(/[ـ]/g, "") // tatweel
    .replace(/[.,;:!?'"“”‘’«»…()\[\]{}\-–—ـ،؛؟]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strong normalization: what we test EQUALITY on. On top of lightNormalize it
 * folds common Arabic orthography variants (alef/hamza forms, taa marbuta,
 * final yaa, Arabic-Indic digits) so a spelling/orthography touch-up is never
 * treated as a meaningful editorial change.
 */
export function strongNormalize(text: string): string {
  return lightNormalize(text)
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ً-ْ]/g, "") // harakat
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .toLowerCase();
}

/**
 * Character-level Levenshtein distance ratio (distance / max length), used
 * for TITLES (short strings). 0 = identical, 1 = fully different.
 */
export function charEditRatio(a: string, b: string): number {
  const s = lightNormalize(a);
  const t = lightNormalize(b);
  if (s === t) return 0;
  const n = s.length;
  const m = t.length;
  if (n === 0 || m === 0) return 1;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m] / Math.max(n, m);
}

/** Deterministic cap so pathological inputs can't blow up the LCS matrix. */
const MAX_BODY_TOKENS = 6000;

/**
 * Word-token difference ratio for BODIES: 1 − (2·LCS / (|A| + |B|)) over
 * lightly-normalized word tokens. Token-level (not char-level) so the O(n·m)
 * LCS stays cheap on article-length texts, and moved/kept sentences count as
 * unchanged.
 */
export function tokenEditRatio(a: string, b: string): number {
  const ta = lightNormalize(a).split(" ").filter(Boolean).slice(0, MAX_BODY_TOKENS);
  const tb = lightNormalize(b).split(" ").filter(Boolean).slice(0, MAX_BODY_TOKENS);
  if (ta.length === 0 && tb.length === 0) return 0;
  if (ta.length === 0 || tb.length === 0) return 1;
  let prev = new Array<number>(tb.length + 1).fill(0);
  let curr = new Array<number>(tb.length + 1).fill(0);
  for (let i = 1; i <= ta.length; i++) {
    for (let j = 1; j <= tb.length; j++) {
      curr[j] =
        ta[i - 1] === tb[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[tb.length];
  return 1 - (2 * lcs) / (ta.length + tb.length);
}

/**
 * TITLE edit assessment vs the AI original.
 * - Punctuation/whitespace/orthography-only changes → not material.
 * - Otherwise material when the char ratio ≥ 0.10 (≈ one word swapped in a
 *   typical 8–12-word Arabic headline; a 1–2 character typo fix stays below).
 */
export function assessTitleEdit(
  aiTitle: string,
  finalTitle: string,
): { changed: boolean; material: boolean; ratio: number; magnitude: EditMagnitude } {
  const changed = (aiTitle ?? "").trim() !== (finalTitle ?? "").trim();
  if (!changed || strongNormalize(aiTitle) === strongNormalize(finalTitle)) {
    return { changed, material: false, ratio: 0, magnitude: "none" };
  }
  const ratio = charEditRatio(aiTitle, finalTitle);
  const magnitude: EditMagnitude =
    ratio < 0.1 ? "none" : ratio < 0.25 ? "minor" : ratio < 0.5 ? "moderate" : "major";
  return { changed, material: magnitude !== "none", ratio, magnitude };
}

/**
 * BODY edit magnitude vs the AI original, from the token difference ratio.
 * Thresholds (documented, deterministic):
 *   none     < 0.03  — touch-ups (typo, punctuation, a word or two)
 *   minor    < 0.15  — light editing (a few sentences adjusted)
 *   moderate < 0.40  — substantial rework of parts of the article
 *   major    ≥ 0.40  — the article was largely rewritten
 */
export function assessBodyEdit(
  aiBody: string,
  finalBody: string,
): { ratio: number; magnitude: EditMagnitude } {
  if (strongNormalize(aiBody ?? "") === strongNormalize(finalBody ?? "")) {
    return { ratio: 0, magnitude: "none" };
  }
  const ratio = tokenEditRatio(aiBody ?? "", finalBody ?? "");
  const magnitude: EditMagnitude =
    ratio < 0.03 ? "none" : ratio < 0.15 ? "minor" : ratio < 0.4 ? "moderate" : "major";
  return { ratio, magnitude };
}

/** Host of a URL for "did the source actually change" comparisons. */
export function urlHost(url: string | null | undefined): string {
  try {
    return new URL(String(url ?? "")).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(url ?? "").trim().toLowerCase();
  }
}

export type SampleLabel = "insufficient_data" | "early_signal" | "meaningful_sample";

/**
 * Deterministic sample-size labeling — tiny samples must never be presented
 * as learning. n<5 insufficient, 5–19 early signal, ≥20 meaningful.
 */
export function sampleLabel(n: number): SampleLabel {
  return n < 5 ? "insufficient_data" : n < 20 ? "early_signal" : "meaningful_sample";
}

export const SAMPLE_LABEL_AR: Record<SampleLabel, string> = {
  insufficient_data: "عينة غير كافية",
  early_signal: "إشارة مبكرة",
  meaningful_sample: "عينة معتبرة",
};
