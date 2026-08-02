// Pure semantic-deduplication logic for the news-ingestion agent (E1.2).
//
// Like registry.ts, this module has NO Deno/Supabase imports so its
// deterministic normalization + similarity + clustering can be unit-tested in
// isolation (see dedupe.test.ts). index.ts wires it into the run.
//
// Design intent (deliberately CONSERVATIVE): this checkpoint uses only local,
// deterministic string logic — no embeddings, no external/AI/vector calls. The
// cost of a false positive (silently dropping a genuinely new story) is far
// higher than a false negative (a rare near-duplicate draft an editor can spot),
// so every threshold is tuned to prefer KEEPING a pending draft when in doubt.

import { type RegistrySource, tierRank } from "./registry.ts";

// ---------------------------------------------------------------------------
// Thresholds (single tuning surface). Scores are 0..1 on the combined title
// metric below. These are intentionally high so only clearly-the-same headlines
// collapse; borderline pairs fall through and remain separate pending drafts.
// ---------------------------------------------------------------------------
/** A title pair at/above this is a high-confidence duplicate on its own. */
export const DUPLICATE_TITLE_THRESHOLD = 0.72;
/** Titles must be at least this similar before an excerpt match can confirm. */
export const EXCERPT_SUPPORT_TITLE_FLOOR = 0.6;
/** Excerpt similarity required to confirm a borderline title match. */
export const EXCERPT_SUPPORT_THRESHOLD = 0.8;

export type StoryText = {
  title: string;
  originalTitle?: string | null;
  excerpt?: string | null;
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Arabic-Indic (٠-٩) and extended Arabic-Indic (۰-۹) digits -> ASCII, so a
// figure written in either script compares equal.
const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

function foldDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d);
}

/**
 * Normalize an Arabic/English headline for comparison: lowercase, fold Arabic
 * digits, strip Arabic diacritics/tatweel, unify Arabic letter variants
 * (alef/ya/ta-marbuta/hamza forms), turn punctuation into spaces, and collapse
 * runs of whitespace. Returns "" when nothing usable remains.
 */
export function normalizeTitle(input: string): string {
  let s = foldDigits((input ?? "").toLowerCase());
  // Strip Arabic diacritics, superscript alef, and tatweel (kashida).
  s = s.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u0640]/g, "");
  // Unify Arabic letter variants.
  s = s
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627") // آأإٱ -> ا
    .replace(/\u0649/g, "\u064A") // ى -> ي
    .replace(/\u0629/g, "\u0647") // ة -> ه
    .replace(/\u0624/g, "\u0648") // ؤ -> و
    .replace(/\u0626/g, "\u064A") // ئ -> ي
    .replace(/\u0621/g, ""); // ء -> (drop)
  // Any non-letter/non-digit (punctuation, separators like - | – — » «) -> space.
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");
  return s.trim().replace(/\s+/g, " ");
}

// Generic connective words + headline noise + agency/branding tokens. Stored as
// raw strings and normalized through normalizeTitle so they match the tokens
// produced below regardless of diacritics/letter-variant spelling. Removing
// branding/agency tokens is what lets "…خبر - وكالة كونا" match the same
// headline without its agency tag.
const RAW_STOPWORDS = [
  // English connectives
  "the", "a", "an", "of", "to", "for", "in", "on", "and", "or", "with", "after",
  "as", "at", "by", "is", "are", "be", "its", "it", "over", "amid", "from",
  "say", "says", "said", "new",
  // English headline noise
  "breaking", "exclusive", "video", "watch", "live", "update", "updated",
  "photos", "photo", "gallery", "report", "latest", "news",
  // English agency/branding
  "reuters", "bbc", "cnn", "ap", "afp", "spa",
  // Arabic connectives
  "في", "من", "على", "عن", "إلى", "الى", "مع", "بعد", "عند", "أو", "أن", "التي", "الذي", "وفق",
  // Arabic headline noise
  "عاجل", "حصري", "فيديو", "بالفيديو", "بالصور", "صور", "مباشر", "تحديث",
  "شاهد", "خبر", "أخبار", "تقرير", "وكالة", "الأنباء",
  // Arabic agency/branding
  "وام", "كونا", "واس", "رويترز",
];
const STOPWORDS = new Set<string>(RAW_STOPWORDS.map(normalizeTitle));

// Strip the Arabic definite article from longer tokens so "المرض"/"مرض" and
// "اليمن"/"يمن" compare equal — including the common "لل" (لِ+الـ) contraction
// and a single proclitic (و ف ب ك ل) fused onto the article (بالمدرسة -> مدرسه).
function stripArticle(token: string): string {
  const m = token.match(/^(?:لل|[وفبكل]?ال)(.+)$/);
  if (m && m[1].length >= 2) return m[1];
  return token;
}

/**
 * Content tokens of a headline: normalized, split on spaces, branding/stopwords
 * removed, the definite article stripped, and single-character noise dropped
 * (numbers of any length are kept — they distinguish materially different
 * stories).
 */
export function contentTokens(input: string): string[] {
  return normalizeTitle(input)
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stripArticle)
    .filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)));
}

// ---------------------------------------------------------------------------
// Numeric conflict guard: two headlines that each carry multi-digit figures but
// share NONE of them describe materially different stories (different case
// counts, doses, years, recurring stats with new figures) and must NOT merge.
// ---------------------------------------------------------------------------
export function extractNumbers(input: string): Set<string> {
  // Drop thousands separators between digits, then take runs of >= 2 digits
  // (single digits are too noisy to be a reliable distinguisher).
  const s = foldDigits(input ?? "").replace(/(\d)[,\u066C.](\d)/g, "$1$2");
  return new Set(s.match(/\d{2,}/g) ?? []);
}

export function numericConflict(a: string, b: string): boolean {
  const na = extractNumbers(a);
  const nb = extractNumbers(b);
  if (na.size === 0 || nb.size === 0) return false;
  for (const n of na) if (nb.has(n)) return false; // share a figure -> no conflict
  return true;
}

// ---------------------------------------------------------------------------
// Similarity: token-set Jaccard (bag of words) blended with token-bigram Dice
// (word order). Jaccard dominates; the bigram term guards against two headlines
// that share words in a different order actually meaning different things.
// ---------------------------------------------------------------------------
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function bigrams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) out.add(`${tokens[i]}\u0000${tokens[i + 1]}`);
  return out;
}

function diceBigram(a: string[], b: string[]): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return jaccard(new Set(a), new Set(b));
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return (2 * inter) / (ba.size + bb.size);
}

/** Combined 0..1 similarity of two headline strings (0 when either is empty). */
export function similarity(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const j = jaccard(new Set(ta), new Set(tb));
  const d = diceBigram(ta, tb);
  return 0.6 * j + 0.4 * d;
}

// Best title-vs-title score across a story's title and (when present) its
// original-language title, so a match on either language counts.
function bestTitleScore(a: StoryText, b: StoryText): number {
  const as = [a.title, a.originalTitle].filter((t): t is string => !!t && t.trim().length > 0);
  const bs = [b.title, b.originalTitle].filter((t): t is string => !!t && t.trim().length > 0);
  let best = 0;
  for (const x of as) for (const y of bs) best = Math.max(best, similarity(x, y));
  return best;
}

export type DuplicateVerdict = {
  duplicate: boolean;
  score: number;
  method: "semantic_title" | "semantic_title_excerpt" | null;
};

/**
 * Decide whether two stories are the same event. Titles are primary; the
 * excerpt is SUPPORTING context only — it can confirm a borderline title match
 * but never trigger a duplicate on its own. A numeric conflict (disjoint
 * multi-digit figures) always wins and keeps the stories separate.
 */
export function storyDuplicate(a: StoryText, b: StoryText): DuplicateVerdict {
  const titleA = `${a.title ?? ""} ${a.originalTitle ?? ""}`;
  const titleB = `${b.title ?? ""} ${b.originalTitle ?? ""}`;
  if (numericConflict(titleA, titleB)) return { duplicate: false, score: 0, method: null };

  const titleScore = bestTitleScore(a, b);
  if (titleScore >= DUPLICATE_TITLE_THRESHOLD) {
    return { duplicate: true, score: titleScore, method: "semantic_title" };
  }
  if (titleScore >= EXCERPT_SUPPORT_TITLE_FLOOR && a.excerpt && b.excerpt) {
    const exScore = similarity(a.excerpt, b.excerpt);
    if (exScore >= EXCERPT_SUPPORT_THRESHOLD) {
      return {
        duplicate: true,
        score: Math.max(titleScore, exScore),
        method: "semantic_title_excerpt",
      };
    }
  }
  return { duplicate: false, score: titleScore, method: null };
}

// ---------------------------------------------------------------------------
// Same-run clustering: greedy single-pass grouping. Each item is compared to the
// representative (first member) of existing clusters and joins the first match,
// otherwise it starts a new cluster. Order is preserved and deterministic.
// ---------------------------------------------------------------------------
export function clusterStories<T>(items: T[], getText: (t: T) => StoryText): T[][] {
  const clusters: T[][] = [];
  for (const item of items) {
    const text = getText(item);
    let placed = false;
    for (const cluster of clusters) {
      if (storyDuplicate(getText(cluster[0]), text).duplicate) {
        cluster.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([item]);
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// Best-source selection within a duplicate cluster. Ordering (strongest first):
//   1. registered & active source (matched registry entry)
//   2. final_source_allowed = true
//   3. lower tier number
//   4. higher trust score
//   5. primary/original source preferred (non-media source_type)
//   6. newer original publication date (only as a final tie-break)
// A Tier-1 original therefore always beats a Tier-2 media report of the story.
// ---------------------------------------------------------------------------
export type SourceRank = { source: RegistrySource | null; publishedDate?: string | null };

function isPrimaryType(source: RegistrySource | null): boolean {
  return !!source && source.source_type !== "media";
}

function dateValue(d: string | null | undefined): number {
  if (!d) return 0;
  const t = Date.parse(d);
  return Number.isNaN(t) ? 0 : t;
}

/** Comparator: < 0 when `a` is the stronger representative than `b`. */
export function betterSource(a: SourceRank, b: SourceRank): number {
  const aReg = a.source ? 1 : 0;
  const bReg = b.source ? 1 : 0;
  if (aReg !== bReg) return bReg - aReg;

  const aFinal = a.source?.final_source_allowed ? 1 : 0;
  const bFinal = b.source?.final_source_allowed ? 1 : 0;
  if (aFinal !== bFinal) return bFinal - aFinal;

  const tier = tierRank(a.source) - tierRank(b.source);
  if (tier !== 0) return tier;

  const trust = (b.source?.trust_score ?? 0) - (a.source?.trust_score ?? 0);
  if (trust !== 0) return trust;

  const prim = (isPrimaryType(b.source) ? 1 : 0) - (isPrimaryType(a.source) ? 1 : 0);
  if (prim !== 0) return prim;

  return dateValue(b.publishedDate) - dateValue(a.publishedDate);
}

/** Index of the strongest representative in a cluster (0 for an empty input). */
export function pickBestIndex(ranks: SourceRank[]): number {
  let best = 0;
  for (let i = 1; i < ranks.length; i++) {
    if (betterSource(ranks[i], ranks[best]) < 0) best = i;
  }
  return best;
}
