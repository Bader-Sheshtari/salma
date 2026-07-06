/**
 * Internal-search text utilities: Arabic-aware normalization plus a lightweight
 * fuzzy scorer. Kept framework-free (no `server-only`) so it can run on the
 * server during the query and, if ever needed, on the client too.
 *
 * The site is Arabic-first, and Postgres has no Arabic text-search config, so we
 * normalize in JS: fold the common letter variants readers type inconsistently
 * (hamza forms, ة/ه, ي/ى), strip diacritics/tatweel, and collapse spacing. This
 * lets "احمد" match "أحمد" and "مستشفي" match "مستشفى" without a DB extension.
 */

const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/** Normalize Arabic + Latin text for comparison. */
export function normalize(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFKC")
    .replace(DIACRITICS, "") // tashkīl, superscript alef, tatweel
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627") // أ إ آ ٱ → ا
    .replace(/\u0629/g, "\u0647") // ة → ه
    .replace(/\u0649/g, "\u064A") // ى → ي
    .replace(/\u0624/g, "\u0648") // ؤ → و
    .replace(/\u0626/g, "\u064A") // ئ → ي
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop punctuation
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Split normalized text into word tokens. */
export function tokenize(input: string): string[] {
  const n = normalize(input);
  return n ? n.split(" ").filter(Boolean) : [];
}

/** Levenshtein edit distance between two short words (row-swap DP). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Edits tolerated for a typo match, scaled by word length: short words demand
 * near-exact spelling (a single edit changes their meaning), longer words allow
 * more slack. Keeps precision high while catching real spelling mistakes.
 */
function maxEdits(len: number): number {
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

/** Drop the Arabic definite article "ال" so "سرطان" matches "السرطان". */
function stripAl(w: string): string {
  return w.startsWith("\u0627\u0644") && w.length > 4 ? w.slice(2) : w;
}

/**
 * Typo-tolerant similarity of two words (0..1). Returns 0 unless they are within
 * a length-scaled edit budget (also comparing definite-article-stripped forms),
 * otherwise a closeness score that shrinks with each edit.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const dist = Math.min(editDistance(a, b), editDistance(stripAl(a), stripAl(b)));
  const budget = maxEdits(Math.max(a.length, b.length));
  if (dist > budget) return 0;
  return 1 - dist / (Math.max(a.length, b.length) + 1);
}

/**
 * A weighted field: its text and how much a match counts. `fuzzy: false` limits
 * it to exact substring hits — used for bulk text like article bodies, where
 * typo-tolerant matching would otherwise pull in loosely-related items.
 */
export type Field = { text: string | null | undefined; weight: number; fuzzy?: boolean };

/**
 * Score a query against an item's weighted fields. Returns 0 when the item is
 * not a plausible match. Each query token scores its best hit across the item's
 * words — an exact substring counts full weight, a close typo counts partial —
 * and we require most tokens to land so unrelated items are filtered out.
 */
export function scoreFields(query: string, fields: Field[]): number {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;

  // Build the per-field word lists once.
  const parts = fields
    .map((f) => ({
      words: tokenize(f.text ?? ""),
      weight: f.weight,
      joined: normalize(f.text ?? ""),
      fuzzy: f.fuzzy !== false,
    }))
    .filter((p) => p.words.length > 0);
  if (parts.length === 0) return 0;

  let total = 0;
  let matchedTokens = 0;

  for (const qt of qTokens) {
    let best = 0;
    for (const p of parts) {
      // Substring hit (e.g. query "قطر" inside "قطري") → strong, field-weighted.
      if (p.joined.includes(qt)) {
        best = Math.max(best, 2 * p.weight);
        continue;
      }
      // Otherwise the closest word within the typo budget. Only fuzzy-match
      // fields that opt in (not bulk body text).
      if (!p.fuzzy) continue;
      for (const w of p.words) {
        const sim = similarity(qt, w);
        if (sim > 0) best = Math.max(best, sim * 1.5 * p.weight);
      }
    }
    if (best > 0) matchedTokens++;
    total += best;
  }

  // Require a majority of query tokens to match, so multi-word queries stay
  // precise rather than matching on a single common word.
  const needed = Math.max(1, Math.ceil(qTokens.length * 0.6));
  if (matchedTokens < needed) return 0;

  return total;
}
