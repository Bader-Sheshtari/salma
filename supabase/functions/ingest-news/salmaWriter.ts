// E1.3A — Salma editorial writing engine (pure, no Deno/Supabase imports).
//
// This module is the dedicated Arabic *writing* concern, deliberately kept
// separate from source selection (registry.ts) and semantic dedup (dedupe.ts).
// It is responsible for:
//   - selecting the writing profile for a verified story,
//   - building the Arabic writing instructions (prompt) for that profile,
//   - validating the article structure the model returns,
//   - computing a realistic reading time from the FINAL Arabic body,
//   - rejecting malformed or fact-ungrounded output (a validation failure must
//     prevent a pending draft from being created, with a clear reason).
//
// It has NO Deno/Supabase imports so it is unit-testable in isolation
// (see salmaWriter.test.ts). index.ts would wire these into a run later; this
// checkpoint is local implementation + testing only (no live model call added).

export const WRITER_PROMPT_VERSION = "e1.3a-salma-writer" as const;

// --- Profiles (Step 3) -----------------------------------------------------

export type WritingProfile =
  | "quick_news"
  | "standard_news"
  | "regulation_or_service"
  | "safety_alert"
  | "research_study";

// Target Arabic word band per profile. Outside the band is a WARNING (model
// variance is expected), never a hard block — only truly empty/degenerate
// output is malformed.
export const PROFILE_WORD_BANDS: Record<WritingProfile, { min: number; max: number }> = {
  quick_news: { min: 100, max: 160 },
  standard_news: { min: 180, max: 320 },
  regulation_or_service: { min: 160, max: 320 },
  safety_alert: { min: 120, max: 260 },
  research_study: { min: 200, max: 340 },
};

// Keyword signals used to pick a profile when the caller has no explicit one.
// Arabic + English tokens (foreign source titles are common). These lists are
// deliberately broad on the SENSITIVE side (safety/research): the cost of
// mis-routing a consequential story to the cheaper default model is higher than
// occasionally routing an ordinary story to the more careful sensitive model,
// so ambiguity is resolved toward the sensitive profiles (see selectProfile).
const SAFETY_KEYWORDS = [
  // Arabic — recalls / withdrawals / device & drug warnings.
  "تحذير", "تحذيرات", "سحب", "استدعاء", "حظر", "منع تداول", "تلوث", "ملوث",
  "آثار جانبية", "أعراض جانبية", "توقف عن استخدام", "توقفوا عن", "لا تستخدم",
  "خطر صحي", "مخاطر صحية", "دفعة", "تشغيلة", "عيب تصنيع", "خلل", "معيب",
  "تسمم", "تسمّم", "مبيد", "سام", "سامّ", "منتهي الصلاحية", "غير صالح",
  // Arabic — public-health warnings / outbreaks.
  "تفشٍ", "تفشي", "وباء", "جائحة", "عدوى", "فاشية", "إنذار", "طوارئ صحية",
  // English.
  "recall", "recalled", "withdraw", "withdrawal", "warning", "warns",
  "safety alert", "safety notice", "adverse", "side effect", "contaminat",
  "advisory", "outbreak", "poisoning", "hazard", "do not use", "defect",
  "batch", "lot number", "unsafe", "banned", "toxic",
];
const REGULATION_KEYWORDS = [
  "قرار", "لائحة", "تنظيم", "وزارة", "اعتماد", "الأهلية", "رسوم", "تصريح",
  "إلزامي", "يبدأ تطبيق", "خدمة جديدة", "منصة", "regulation", "policy", "eligib",
];
const RESEARCH_KEYWORDS = [
  // Arabic — studies / trials / observational designs.
  "دراسة", "دراسات", "بحث", "أبحاث", "باحثون", "باحثين", "الباحثون",
  "دورية", "مجلة علمية", "محكّمة", "محكمة", "عيّنة", "عينة", "مشاركين",
  "المشاركين", "تجربة سريرية", "تجارب سريرية", "رصدية", "رصدي", "فوجية",
  "حالة وشاهد", "أظهرت دراسة", "خلص الباحثون", "وفق دراسة", "بحسب دراسة",
  "تحليل تلوي", "تحليل بعدي", "استقصاء",
  // English.
  "study", "studies", "research", "researcher", "trial", "clinical trial",
  "observational", "cohort", "case-control", "journal", "peer-review",
  "peer reviewed", "randomized", "randomised", "meta-analysis", "participants",
  "sample size", "findings",
];

// Weak, ambiguity-resolving signals. On their own none of these picks a
// profile, but a medical SUBJECT paired with a RISK term is treated as a
// (possible) safety alert so an uncertain medicine/device/public-health warning
// is routed to the sensitive model rather than the cheaper default.
const MEDICAL_SUBJECT_HINTS = [
  "دواء", "أدوية", "عقار", "عقاقير", "لقاح", "تطعيم", "مصل", "جهاز طبي",
  "مستحضر", "مضاد حيوي", "حقنة", "حقن", "منتج طبي",
  "medicine", "medication", "drug", "vaccine", "medical device", "implant",
  "antibiotic", "injection", "supplement",
];
const RISK_HINTS = [
  "خطر", "خطير", "خطيرة", "ضار", "ضرر", "أضرار", "مخاطر", "قلق", "مقلق",
  "احذر", "يُحذّر", "تحذير", "مشبوه", "غير آمن",
  "risk", "warn", "danger", "harm", "concern", "unsafe", "alarm", "fear",
];

function containsAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

/** A conservative, deterministic sensitivity hint: does the text plausibly
 *  describe a safety alert or a study, even without a strong exact keyword?
 *  Returns the sensitive profile to prefer, or null. Ordering favors the more
 *  consequential safety_alert over research_study. */
export function sensitiveProfileHint(text: string): "safety_alert" | "research_study" | null {
  const t = text ?? "";
  // Strong exact signals first.
  if (containsAny(t, SAFETY_KEYWORDS)) return "safety_alert";
  if (containsAny(t, RESEARCH_KEYWORDS)) return "research_study";
  // Weak, ambiguity-resolving signal: a medical subject discussed alongside a
  // risk/warning term is treated as a possible safety alert (uncertain ->
  // sensitive). This never fires on benign "new medicine available" copy.
  if (containsAny(t, MEDICAL_SUBJECT_HINTS) && containsAny(t, RISK_HINTS)) return "safety_alert";
  return null;
}

/**
 * Choose the writing profile for a verified story. An explicit profile (from a
 * future classification step) always wins. Otherwise sensitivity is resolved
 * FIRST and conservatively: any strong or ambiguous safety/research signal wins
 * over the non-sensitive profiles, so a plausibly consequential story is routed
 * to the more careful sensitive model (see writerRouter.selectWriterModel)
 * rather than the cheaper default. Only once no sensitive signal is present do
 * we fall back to regulation/service, then quick vs. standard news by length.
 */
export function selectProfile(input: {
  explicit?: WritingProfile | null;
  sourceText: string;
  targetWords?: number;
}): WritingProfile {
  if (input.explicit) return input.explicit;
  const t = input.sourceText ?? "";
  const sensitive = sensitiveProfileHint(t);
  if (sensitive) return sensitive;
  if (containsAny(t, REGULATION_KEYWORDS)) return "regulation_or_service";
  if ((input.targetWords ?? 0) > 0 && (input.targetWords as number) <= 160) return "quick_news";
  return "standard_news";
}

// --- Arabic text helpers (Steps 4, 6, 8) -----------------------------------

const AR_DIGIT_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

/** Fold Arabic-Indic / extended digits to Western so numbers compare equal. */
export function foldDigits(s: string): string {
  return (s ?? "").replace(/[٠-٩۰-۹]/g, (d) => AR_DIGIT_MAP[d] ?? d);
}

/** Normalize for faithful text comparison: fold digits, strip diacritics and
 *  tatweel, unify punctuation to spaces, collapse whitespace, lowercase. */
export function normalizeForCompare(text: string): string {
  return foldDigits(text ?? "")
    .replace(/[\u064B-\u065F\u0610-\u061A\u0670]/g, "") // harakat
    .replace(/\u0640/g, "") // tatweel
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Count Arabic (or any-script) words: whitespace tokens containing a letter or
 *  number. Punctuation-only tokens are ignored. */
export function countWords(text: string): number {
  const tokens = (text ?? "").trim().split(/\s+/).filter(Boolean);
  return tokens.filter((tok) => /[\p{L}\p{N}]/u.test(tok)).length;
}

// Arabic news reading pace. Deliberately deterministic and shared so a short
// article never gets an inflated model-estimated reading time (Step 8).
export const WORDS_PER_MINUTE = 180;

/** Realistic reading time in whole minutes from the FINAL Arabic body. Always
 *  at least 1; a ~120-word quick item is 1 minute, not the old default of 3. */
export function readingTimeMinutes(body: string): number {
  const words = countWords(body);
  if (words === 0) return 1;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

// --- Style: banned promotional / ceremonial phrases (Step 4) ---------------

export const BANNED_PROMO_PHRASES = [
  "اكتشاف مذهل",
  "ثورة طبية",
  "لن تصدق",
  "في إطار حرصها",
  "ضمن جهودها المتواصلة",
  "في إطار حرص",
  "ضمن جهود",
  "حرصاً منها",
  "تحت رعاية",
  "بكل فخر",
  "إنجاز غير مسبوق",
  "الأول من نوعه",
] as const;

/** Return every banned promotional/ceremonial phrase found in the text. */
export function detectPromoPhrases(text: string): string[] {
  const t = text ?? "";
  return BANNED_PROMO_PHRASES.filter((p) => t.includes(p));
}

// --- Headline rules (Step 5) -----------------------------------------------

const HEADLINE_MIN_WORDS = 7;
const HEADLINE_MAX_WORDS = 14;
// Only "extremely" short/long is flagged, to avoid noise on borderline titles.
const HEADLINE_HARD_SHORT = 4;
const HEADLINE_HARD_LONG = 18;

/** Strip a trailing source/brand suffix like " - رويترز" / " | Al Jazeera" from
 *  a headline. Returns the cleaned title and whether anything was removed. */
export function stripSourceBrand(title: string, brand?: string | null): { title: string; stripped: boolean } {
  let t = (title ?? "").trim();
  const before = t;
  // Generic trailing " - X" / " | X" / " – X" separators (news aggregator style).
  t = t.replace(/\s*[-–—|]\s*[^-–—|]{1,40}$/u, "").trim();
  if (brand) {
    const b = brand.trim();
    if (b) {
      // Remove the brand token wherever it appears (headline must not carry it).
      const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(new RegExp(`\\s*[-–—|:]?\\s*${escaped}\\s*$`, "iu"), "").trim();
      t = t.replace(new RegExp(escaped, "iu"), "").replace(/\s{2,}/g, " ").trim();
    }
  }
  return { title: t || before, stripped: t !== before && !!t };
}

/**
 * Validate a generated headline. Returns non-blocking warnings plus a cleaned
 * title (brand suffix removed). Headline issues are warnings, not hard rejects:
 * only fact-grounding and malformed structure block a draft (Steps 5, 7).
 */
export function validateHeadline(
  title: string,
  opts: { originalTitle?: string | null; brand?: string | null } = {},
): { warnings: string[]; cleanTitle: string } {
  const warnings: string[] = [];
  const raw = (title ?? "").trim();
  const { title: cleanTitle, stripped } = stripSourceBrand(raw, opts.brand);
  if (stripped) warnings.push("headline_source_brand_removed");

  const words = countWords(cleanTitle);
  if (words < HEADLINE_HARD_SHORT) warnings.push("headline_too_short");
  else if (words > HEADLINE_HARD_LONG) warnings.push("headline_too_long");
  else if (words < HEADLINE_MIN_WORDS || words > HEADLINE_MAX_WORDS) {
    warnings.push("headline_length_outside_ideal");
  }

  const promo = detectPromoPhrases(cleanTitle);
  if (promo.length) warnings.push("headline_promotional");

  // Copied-from-original detection: near-identical to the source headline.
  if (opts.originalTitle) {
    const a = normalizeForCompare(cleanTitle);
    const b = normalizeForCompare(opts.originalTitle);
    if (a && b && (a === b || jaccard(a, b) >= 0.8)) warnings.push("headline_duplicates_original");
  }
  return { warnings, cleanTitle };
}

function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// --- Fact grounding (Step 7, blocking) -------------------------------------

/** Extract standalone numeric tokens (digits folded, thousands separators
 *  removed) from a text. Used to require every generated number to exist in the
 *  verified source material. */
export function extractNumbers(text: string): string[] {
  const folded = foldDigits(text ?? "");
  const matches = folded.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return matches.map((m) => m.replace(/,/g, ""));
}

/**
 * Normalize a numeric token for grounding comparison by removing insignificant
 * leading zeros ("01" ≡ "1", "09" ≡ "9", "007" ≡ "7") while keeping a literal
 * zero. This makes an ISO date component like `01`/`09` in the source compare
 * equal to the same day/month rendered without padding in the Arabic body
 * (e.g. source `2026-09-01` vs "1 سبتمبر 2026" / "01 سبتمبر 2026"). Numeric
 * value is unchanged, so genuinely unsupported numbers are still flagged. */
export function normalizeNumberToken(token: string): string {
  const stripped = token.replace(/^0+(?=\d)/, "");
  return stripped === "" ? "0" : stripped;
}

// --- Locale- and scale-aware numeric grounding -----------------------------
//
// A figure is "supported" when its NUMERIC VALUE appears in the source, even if
// the two sides write it with different formatting conventions. This corrects a
// class of false positives where a faithful Arabic draft renders a grouped
// source figure with a scale word ("330,000" → "330 ألف") or where a European
// source uses period-thousands / comma-decimals ("15.000" = 15000, "1,5" = 1.5).
// It never loosens the safeguard: a value genuinely absent from the source (in
// ANY convention) still yields `unsupported_number`, and any token that cannot
// be interpreted unambiguously fails CLOSED (treated as unsupported), never as a
// permissive match. The validator remains the authority.

/** Separator convention for interpreting a SOURCE figure. `en` = comma
 *  thousands + period decimal (English/Arabic digital text and the safe default
 *  when the language is unknown); `eu` = period thousands + comma decimal
 *  (Spanish/German/Italian/… ). Draft (always Arabic) is parsed as `en`. */
export type NumberLocale = "en" | "eu";

// ISO-639 (2/3-letter) languages that use the European convention (comma decimal,
// period/space thousands). Best-effort and deliberately conservative: an unknown
// or unmapped language falls back to `en`, which reproduces the previous
// comma-as-thousands behaviour and never corrupts a token (ambiguous groupings
// fail closed rather than being coerced).
const EU_NUMBER_LANGS = new Set([
  "es", "spa", "pt", "por", "de", "deu", "ger", "it", "ita", "fr", "fra", "fre",
  "nl", "nld", "dut", "ro", "ron", "rum", "ru", "rus", "el", "ell", "gre",
  "ca", "cat", "gl", "glg", "pl", "pol", "cs", "ces", "cze", "sk", "slk", "slo",
  "sl", "slv", "hr", "hrv", "sr", "srp", "bg", "bul", "uk", "ukr", "hu", "hun",
  "tr", "tur", "da", "dan", "sv", "swe", "nb", "no", "nor", "fi", "fin", "is", "isl",
]);

/** Map a source language code to its numeric separator convention. */
export function numberLocaleForLang(lang?: string | null): NumberLocale {
  const l = (lang ?? "").trim().toLowerCase();
  return EU_NUMBER_LANGS.has(l) ? "eu" : "en";
}

// Adjacent scale words that multiply the immediately preceding figure. Arabic
// (ألف/مليون/مليار + common plurals and the hamza-less spelling) and English
// (thousand/million/billion, optionally plural). No other multipliers, no
// rounding, no inferred arithmetic.
const SCALE_WORDS: { re: RegExp; exp: number }[] = [
  { re: /^(?:ألف|آلاف|الف|آلآف)$/u, exp: 3 },
  { re: /^(?:مليون|ملايين)$/u, exp: 6 },
  { re: /^(?:مليار|مليارات|بليون)$/u, exp: 9 },
  { re: /^thousands?$/i, exp: 3 },
  { re: /^millions?$/i, exp: 6 },
  { re: /^billions?$/i, exp: 9 },
];

function scaleExponent(word: string | undefined): number {
  if (!word) return 0;
  for (const s of SCALE_WORDS) if (s.re.test(word)) return s.exp;
  return 0;
}

/** Canonical decimal string: strip insignificant leading/trailing zeros so
 *  "0330"→"330", "2.50"→"2.5", "15.0"→"15". Keeps a literal zero. */
function canonicalDecimal(intDigits: string, frac: string): string {
  let i = intDigits.replace(/^0+(?=\d)/, "");
  if (i === "") i = "0";
  const f = frac.replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

/** Shift a canonical decimal right by `exp` places (×10^exp) using string
 *  arithmetic so no floating-point error is introduced. */
function applyScale(canon: string, exp: number): string {
  if (exp === 0) return canon;
  const [ipRaw, fpRaw = ""] = canon.split(".");
  let ip = ipRaw;
  let fp = fpRaw;
  if (fp.length <= exp) {
    ip = ip + fp + "0".repeat(exp - fp.length);
    fp = "";
  } else {
    ip = ip + fp.slice(0, exp);
    fp = fp.slice(exp);
  }
  return canonicalDecimal(ip, fp);
}

/**
 * Parse one numeric token (digits + separators, already digit-folded) into its
 * canonical numeric value under `locale`, or null when the representation is
 * ambiguous / malformed for that locale (fail closed). Thousands groups must be
 * exactly three digits; at most one decimal separator is allowed.
 */
export function parseNumberToken(token: string, locale: NumberLocale): string | null {
  if (!/^[0-9]+(?:[.,][0-9]+)*$/.test(token)) return null;
  const thou = locale === "eu" ? "." : ",";
  const dec = locale === "eu" ? "," : ".";
  const decCount = (token.match(dec === "." ? /\./g : /,/g) ?? []).length;
  if (decCount > 1) return null; // more than one decimal separator → invalid

  let intPart = token;
  let fracPart = "";
  if (decCount === 1) {
    const idx = token.lastIndexOf(dec);
    intPart = token.slice(0, idx);
    fracPart = token.slice(idx + 1);
    if (!/^[0-9]+$/.test(fracPart)) return null; // decimal digits only (no thousands after a decimal)
  }

  const thouRe = thou === "." ? /\./g : /,/g;
  const thouCount = (intPart.match(thouRe) ?? []).length;
  if (thouCount > 0) {
    const groups = intPart.split(thou === "." ? "." : ",");
    if (groups.length < 2) return null;
    if (!/^[0-9]{1,3}$/.test(groups[0])) return null;
    for (let i = 1; i < groups.length; i++) {
      if (!/^[0-9]{3}$/.test(groups[i])) return null; // invalid grouping → fail closed
    }
    intPart = groups.join("");
  } else if (!/^[0-9]+$/.test(intPart)) {
    return null;
  }
  return canonicalDecimal(intPart, fracPart);
}

/**
 * Scan `text` for numeric figures (each with an optional adjacent scale word)
 * and return, per figure, the raw numeric token as written and its canonical
 * value (null when unparseable/ambiguous). Arabic-Indic digits and the Arabic
 * thousands/decimal separators (٬ ٫) are folded first so both sides compare
 * equal. Used to require every generated figure's VALUE to exist in the source.
 */
export function extractNumberEntries(
  text: string,
  locale: NumberLocale,
): { raw: string; value: string | null }[] {
  const folded = foldDigits(text ?? "")
    .replace(/٬/g, ",") // Arabic thousands separator
    .replace(/٫/g, "."); // Arabic decimal separator
  const re =
    /(\d[\d.,]*)\s*(ألف|آلاف|الف|آلآف|مليون|ملايين|مليار|مليارات|بليون|thousands?|millions?|billions?)?/giu;
  const out: { raw: string; value: string | null }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) {
    if (!m[1]) {
      if (m.index === re.lastIndex) re.lastIndex++;
      continue;
    }
    const raw = m[1].replace(/[.,]+$/, ""); // drop a trailing sentence separator
    let value = parseNumberToken(raw, locale);
    const exp = scaleExponent(m[2]);
    if (value !== null && exp > 0) value = applyScale(value, exp);
    out.push({ raw, value });
  }
  return out;
}

/** PII-free diagnostic for one unsupported figure — logged (Deno runtime only,
 *  silent under `node --test`) so a real rejection can be proven, not inferred.
 *  Records ONLY numeric tokens/values, the source language, and normalization
 *  state — never article text, drafts, or quotes. */
function logNumberDiagnostic(d: {
  token: string;
  tokenValue: string | null;
  sourceValues: string[];
  sourceLang: string | null;
  locale: NumberLocale;
}): void {
  if (typeof Deno === "undefined") return; // no-op in unit tests
  try {
    console.warn(
      "[num-fidelity] " +
        JSON.stringify({
          code: "unsupported_number",
          token: d.token,
          token_value: d.tokenValue,
          normalization_attempted: true,
          source_lang: d.sourceLang,
          number_locale: d.locale,
          source_values: d.sourceValues.slice(0, 40),
        }),
    );
  } catch {
    // diagnostics must never affect validation
  }
}

/** Extract quoted spans (Arabic «…», ASCII "…", curly “…”). */
export function extractQuotes(text: string): string[] {
  const out: string[] = [];
  const patterns = [/«([^»]+)»/g, /"([^"]+)"/g, /\u201C([^\u201D]+)\u201D/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text ?? "")) !== null) {
      const q = m[1].trim();
      if (q) out.push(q);
    }
  }
  return out;
}

// Strong efficacy/approval claims that must be explicitly supported by the
// source (Step 7: no unsupported "proven/approved/available/effective").
const CLAIM_KEYWORDS = [
  "أثبت", "مثبت", "مضمون", "علاج نهائي", "شفاء تام", "آمن تماماً", "آمن تماما",
  "معتمد رسمياً", "فعّال بنسبة", "يقضي نهائياً", "يشفي",
];
// Causation verbs vs. association markers (research_study, Step 3E / Step 7).
const CAUSATION_MARKERS = ["يسبب", "يسبّب", "يؤدي إلى", "يمنع", "يعالج", "يقي من"];
const ASSOCIATION_MARKERS = ["ارتبط", "مرتبط", "علاقة", "ترافق", "associat", "correlat", "link"];
// Arabic negation particles that turn a causal verb into an explicit denial of
// causation (e.g. "لا يسبّب", "لا يسمح بالجزم بأن أحدهما يسبّب الآخر"). Matched
// as whole words only, so they never fire inside unrelated tokens such as
// "علاج"/"العلاج" (which contain the letters ل+ا but are not the particle "لا").
const NEGATION_MARKERS = ["لا", "لم", "لن", "ليس", "ليست", "دون", "بدون", "بلا", "غير"];

/** Does the clause contain an Arabic negation particle as a standalone word?
 *  Matched at a word boundary, allowing only the proclitics و/ف ("ولا"، "فلا")
 *  to attach — so it fires on real negation but never inside unrelated words
 *  that merely contain the letters (e.g. "علاج"، "إلا"، "أولاد"). */
function hasNegationWord(clause: string): boolean {
  return NEGATION_MARKERS.some((neg) =>
    new RegExp(`(?:^|[^\\p{L}])[وف]?${neg}(?:$|[^\\p{L}])`, "u").test(clause)
  );
}

/**
 * Is causation actually *asserted* somewhere in the text? A causal verb only
 * counts as an assertion when the clause leading up to it carries no negation
 * particle. This lets explicitly negated causal language pass —
 *   "لا يسبّب"، "لا يسمح بالجزم بأن أحدهما يسبّب الآخر" —
 * while a genuine association→causation upgrade ("… يؤدي إلى الإصابة") still
 * counts. Clauses are bounded by sentence/clause punctuation so a negation in a
 * different clause cannot mask a later un-negated causal claim.
 */
export function causationAsserted(text: string): boolean {
  const src = text ?? "";
  for (const marker of CAUSATION_MARKERS) {
    let idx = src.indexOf(marker);
    while (idx !== -1) {
      const before = src.slice(0, idx);
      const boundary = Math.max(
        before.lastIndexOf("."),
        before.lastIndexOf("،"),
        before.lastIndexOf("؛"),
        before.lastIndexOf("!"),
        before.lastIndexOf("؟"),
        before.lastIndexOf("\n"),
      );
      const clause = before.slice(boundary + 1);
      if (!hasNegationWord(clause)) return true;
      idx = src.indexOf(marker, idx + marker.length);
    }
  }
  return false;
}

// --- Safety-alert official actions & unaffected-batch reassurance (Step 7) --

// The reader-directed official actions a safety authority may explicitly
// request. Each canonical code carries conservative Arabic + English patterns.
// Detection is deterministic and used ONLY for safety_alert grounding: the
// article must preserve the source's action(s), must not invent an action the
// source never stated, and must keep an explicit "other batches are safe"
// reassurance when the source clearly makes one. Everything is derived from the
// verified source text — never from model output or discovery leads.
const OFFICIAL_ACTION_PATTERNS: { code: string; patterns: RegExp[] }[] = [
  { code: "stop_use", patterns: [
    /التوقف عن (?:الاستخدام|الاستعمال|استخدام|استعمال|تناول)/,
    /توقف(?:وا)? عن (?:الاستخدام|الاستعمال|استخدام|استعمال|تناول)/,
    /عدم (?:استخدام|استعمال|تناول)/,
    /لا تستخدم/, /لا تستعمل/, /الكف عن/,
    /stop using/, /discontinue/, /do not use/, /cease use/,
  ] },
  { code: "avoid", patterns: [/تجنب/, /الامتناع عن/, /avoid/, /refrain from/] },
  { code: "return", patterns: [
    /إعادة (?:المنتج|الدواء|المستحضر|العبوة)/, /أعيدوا/, /إرجاع/, /استرجاع/,
    /إعادة المنتج إلى مكان الشراء/, /إعادة العبوة إلى الصيدلية/, /الاستبدال أو الإرجاع/,
    /return (?:the|it|them|any|all|unused|recalled|product|item|medication|drug)/,
    /return\b[^.]{0,20}(?:place|point) of purchase/,
    /return\b\s+or\s+(?:discard|dispose|destroy|replacement)/,
    /return\s*\/\s*replacement/, /return or replacement/, /replacement or return/,
    /arranging (?:for )?return/,
  ] },
  { code: "discard", patterns: [
    // Deterministic Arabic equivalence for "dispose of it": the disposal verb
    // (التخلص من / تخلصوا من / إتلاف / رمي) followed by an explicit reference to
    // the affected product OR to its stock/quantities OR by an attached object
    // pronoun (‑ه/‑ها/‑هما) that, in a recall context, refers back to the same
    // product. This is a bounded whitelist of grammatical variants — never
    // free-form fuzzy matching — so "التخلص منه" counts the same as
    // "التخلص من المنتج", while an unrelated pronoun cannot invent a discard.
    /التخلص من (?:ال)?(?:منتج|دواء|مستحضر|عبوة|عبوات|كمية|كميات|مخزون)/,
    /التخلص من الكميات المتأثرة/,
    /التخلص من(?:ه|ها|هما)/,
    /تخلص(?:وا)? من (?:ال)?(?:منتج|دواء|عبوة|عبوات|كمية|كميات|مخزون)/,
    /تخلص(?:وا)? من(?:ه|ها|هما)/,
    /إتلاف (?:ال)?(?:منتج|دواء|عبوة|عبوات|كمية|كميات|مخزون)/,
    /إتلاف الكميات المتأثرة/,
    /إتلاف(?:ه|ها|هما)/,
    /رمي (?:ال)?(?:منتج|دواء|عبوة)/,
    /discard/, /dispose of/, /throw (?:it|them|the product|the item)? ?away/,
  ] },
  { code: "check", patterns: [
    /التحقق من/, /تحقق(?:وا)? من/, /افحص(?:وا)?/, /فحص (?:العبوة|المنتج|الرقم)/,
    /check (?:the|your|whether|if|for)/,
  ] },
  { code: "contact", patterns: [
    /التواصل مع/, /الاتصال (?:بـ|ب)/, /تواصلوا/, /راجعوا الجهة/,
    /contact (?:the|your|their|a) /, /reach out to/,
  ] },
  { code: "seek_help", patterns: [
    /مراجعة (?:الطبيب|الطوارئ|أقرب)/, /استشارة (?:الطبيب|طبيب|مختص)/,
    /راجع(?:وا)? الطبيب/, /اتصل(?:وا)? بالطبيب/,
    /طلب (?:المساعدة|الرعاية|المشورة) الطبية/,
    /seek (?:medical|immediate|urgent|emergency)/, /consult (?:a |your |their )?doctor/,
    /contact (?:their|your|a|the) (?:doctor|physician|health ?care provider|healthcare provider)/,
  ] },
];

/** Light normalize for action/reassurance matching: fold digits, strip Arabic
 *  diacritics/tatweel, lowercase, collapse whitespace — but KEEP sentence
 *  punctuation so bounded reassurance patterns still work. */
function lightNormalize(s: string): string {
  return foldDigits(s ?? "")
    .replace(/[\u064B-\u065F\u0610-\u061A\u0670\u0640]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** The canonical official-action codes explicitly present in the text (deduped). */
export function extractOfficialActions(text: string): string[] {
  const t = lightNormalize(text);
  const out: string[] = [];
  for (const { code, patterns } of OFFICIAL_ACTION_PATTERNS) {
    if (patterns.some((re) => re.test(t))) out.push(code);
  }
  return [...new Set(out)];
}

// Audience markers used to attribute an official action to WHO must perform it.
// A recall commonly directs some actions only at the supply chain (distributors,
// retailers, pharmacies, healthcare facilities) — e.g. "return to place of
// purchase or discard" — while patients/consumers are told to stop use and
// contact a doctor. The generated Arabic article must not tell patients to
// perform an action the source directed only at facilities.
const FACILITY_AUDIENCE_MARKERS = [
  "distributor", "retailer", "wholesaler", "pharmacy", "pharmacies",
  "healthcare facilit", "health care facilit", "hospital", "clinic",
  "موزع", "تاجر", "صيدلي", "منشأة", "منشآت", "مستشفى", "عيادة",
];
const PATIENT_AUDIENCE_MARKERS = [
  "patient", "consumer", "مريض", "مرضى", "مستهلك", "الجمهور",
];

/** Split text into clauses and attribute the official actions in each clause to
 *  the audience that clause addresses. A clause with no explicit audience marker
 *  contributes to neither set (we stay conservative and never guess). */
export function officialActionsByAudience(
  text: string,
): { facility: Set<string>; patient: Set<string> } {
  const facility = new Set<string>();
  const patient = new Set<string>();
  const clauses = lightNormalize(text).split(/[.!?؟؛،\n]+/);
  for (const clause of clauses) {
    if (!clause.trim()) continue;
    const actions = extractOfficialActions(clause);
    if (actions.length === 0) continue;
    const isFacility = FACILITY_AUDIENCE_MARKERS.some((m) => clause.includes(m));
    const isPatient = PATIENT_AUDIENCE_MARKERS.some((m) => clause.includes(m));
    if (isFacility) for (const a of actions) facility.add(a);
    if (isPatient) for (const a of actions) patient.add(a);
  }
  return { facility, patient };
}

// Explicit reassurance that OTHER batches/lots are unaffected/safe — dropping it
// can cause needless alarm, so a safety alert must keep it when the source has it.
const UNAFFECTED_BATCH_PATTERNS = [
  /(?:باقي|بقية|سائر|جميع) (?:الدفعات|التشغيلات)[^.،؛]{0,40}?(?:غير متأثرة|غير مشمولة|آمنة|سليمة|لا تتأثر)/,
  /(?:الدفعات|التشغيلات) الأخرى[^.،؛]{0,40}?(?:غير متأثرة|غير مشمولة|آمنة|سليمة|لا تتأثر)/,
  /other (?:lots?|batches)[^.]{0,40}?(?:not affected|unaffected|are safe|remain safe)/,
];

/** Does the text explicitly reassure that other batches/lots are unaffected? */
export function hasUnaffectedBatchStatement(text: string): boolean {
  const t = lightNormalize(text);
  return UNAFFECTED_BATCH_PATTERNS.some((re) => re.test(t));
}

// --- Editorial information hierarchy: profile-aware entity visibility ------
//
// A fact required for VALIDATION/PRESERVATION is not automatically required to
// appear in the PUBLISHED article — but whether a fact is reader-essential is
// NOT decided by how it looks. A NUMBER can be essential (a study's sample size
// or effect, a regulation's fee/deadline, a safety alert's batch when several
// variants exist) or verification-only (an NDC, a distribution/expiry date, a
// DOI). Visibility therefore depends on the article PROFILE and the surrounding
// SOURCE CONTEXT, not on a blanket numeric/code-like shape test.
//
// `mustPreserve` still means "do not alter or contradict" (the number/quote
// checks bind any value that DOES appear); this layer only decides which
// entities the visible article is REQUIRED to surface.

// Three visibility classes for a preserved entity in a given article context:
//   - "essential"          → the article must surface it (reader can't act /
//                            understand / identify the finding without it).
//   - "conditional"        → surface it only when it's needed to disambiguate
//                            the affected product (safety alerts: lot/strength/
//                            dosage form/population/manufacturer).
//   - "verification_only"  → keep for grounding, omit from the visible story
//                            unless genuinely necessary (NDC/registration/
//                            distribution/expiry/packaging/DOI/internal IDs).
export type EntityVisibility = "essential" | "conditional" | "verification_only";

/**
 * Shape gate: is this entity an opaque code / bare number rather than a
 * reader-facing name? A genuine name ("Papaverine Hydrochloride", "الكويت",
 * "هيئة الغذاء والدواء") carries a run of ≥4 letters and is NEVER a candidate
 * for omission — only code-like tokens are even considered verification-only.
 */
export function isCodeLikeEntity(entity: string): boolean {
  const compact = foldDigits((entity ?? "").trim()).replace(/[\s.\-/#:]/g, "");
  if (compact === "") return false;
  if (/^\d+$/.test(compact)) return true; // pure number
  // A digit-bearing token with no real multi-letter word (e.g. "L2291", "AB12C").
  return /\d/.test(compact) && !/[A-Za-z\u0600-\u06FF]{4,}/.test(compact);
}

// Context cues (matched in a small window around the entity in the source).
// Verification-only labels apply across every profile.
const VERIFICATION_ONLY_CUES = [
  "ndc", "registration", "reg no", "reg. no", "رقم التسجيل", "التسجيل",
  "expir", "expiry", "expiration", "الصلاحية", "انتهاء",
  "distribut", "توزيع", "وزّع", "وزع",
  "packag", "carton", "التغليف", "التعبئة", "عبوة رقم",
  "doi", "issn", "pmid", "identifier",
];
// Numeric facts that are normally reader-essential, per profile.
const ESSENTIAL_NUMERIC_CUES: Record<WritingProfile, string[]> = {
  quick_news: [
    "start", "starts", "begins", "يبدأ", "hour", "hours", "ساعة", "الساعة",
    "am", "pm", "صباح", "مساء", "location", "في", "from", "من",
  ],
  standard_news: [
    "percent", "%", "نسبة", "بنسبة", "قتل", "أصيب", "بلغ", "عدد",
  ],
  regulation_or_service: [
    "fee", "fees", "رسوم", "fine", "fines", "penalty", "غرامة", "دينار", "kd",
    "effective", "effect", "يبدأ", "يسري", "اعتبار", "starting",
    "deadline", "مهلة", "الموعد النهائي", "eligib", "الأهلية", "سن",
  ],
  safety_alert: [
    // Numbers that are always reader-relevant even in a safety alert are rare;
    // the risk/population figures below help keep them visible.
    "%", "نسبة", "cases", "حالة", "حالات",
  ],
  research_study: [
    "participant", "participants", "مشارك", "مشاركا", "subject", "subjects",
    "sample", "عيّنة", "عينة", "enrolled", "شملت", "n =", "n=",
    "percent", "%", "نسبة", "بنسبة", "week", "weeks", "أسبوع", "شهر", "month",
    "months", "year", "years", "سنة", "عام", "duration", "مدة", "followed",
    "متابعة", "risk", "odds", "hazard", "reduction", "increase", "decrease",
    "انخفاض", "ارتفاع", "زيادة",
  ],
};
// Safety-alert identifiers that only matter to pin down WHICH product/variant.
const SAFETY_CONDITIONAL_CUES = [
  "lot", "lots", "batch", "batches", "دفعة", "دفعات", "تشغيلة", "تشغيلات",
  "mg", "mcg", "ml", "ملغ", "مغ", "ميكروغرام", "strength", "concentration",
  "تركيز", "قوة", "dosage", "dose", "جرعة", "capsule", "tablet", "injection",
  "حقن", "أقراص", "كبسول", "manufactur", "الشركة المصنّعة", "المصنّعة",
];

function matchesAny(text: string, cues: string[]): boolean {
  return cues.some((c) => text.includes(c));
}

/** A code with a hyphen/slash or a ≥6-digit run reads as an opaque identifier
 *  (NDC / registration) even without a labeling cue. */
function isOpaqueIdentifier(entity: string): boolean {
  const e = foldDigits((entity ?? "").trim());
  if (/[-/]/.test(e)) return true;
  return /\d{6,}/.test(e.replace(/[\s.]/g, ""));
}

/** Lowercased/folded window immediately before and after the entity's first
 *  occurrence in the source. The preceding label ("Lot 25202", "sample of 800")
 *  is the strongest signal, so it is weighted first by the caller. */
function entityContext(sourceText: string, entity: string): { before: string; after: string } {
  const src = foldDigits(sourceText ?? "").toLowerCase();
  const needle = foldDigits(entity ?? "").toLowerCase().trim();
  if (!needle) return { before: "", after: "" };
  const idx = src.indexOf(needle);
  if (idx === -1) return { before: "", after: "" };
  return {
    before: src.slice(Math.max(0, idx - 24), idx),
    after: src.slice(idx + needle.length, idx + needle.length + 16),
  };
}

/**
 * Decide how visible a preserved entity should be, given the article profile and
 * the source context around it. Names are always essential; only code-like
 * tokens can be verification-only. The label PRECEDING the value dominates
 * ("Lot 25202" → conditional even though "NDC …" follows it), then the trailing
 * context, then a shape fallback (opaque codes default to verification-only, a
 * bare short number defaults to essential — a number may be essential).
 */
export function classifyEntityVisibility(
  entity: string,
  profile: WritingProfile,
  sourceText: string,
): EntityVisibility {
  if (!isCodeLikeEntity(entity)) return "essential"; // reader-facing name/identity
  const { before, after } = entityContext(sourceText, entity);
  const essentialCues = ESSENTIAL_NUMERIC_CUES[profile];
  const conditionalCues = profile === "safety_alert" ? SAFETY_CONDITIONAL_CUES : [];

  // Preceding label wins.
  if (matchesAny(before, VERIFICATION_ONLY_CUES)) return "verification_only";
  if (matchesAny(before, essentialCues)) return "essential";
  if (matchesAny(before, conditionalCues)) return "conditional";
  // Then the trailing context ("8400 participants", "25202 lot").
  if (matchesAny(after, VERIFICATION_ONLY_CUES)) return "verification_only";
  if (matchesAny(after, essentialCues)) return "essential";
  if (matchesAny(after, conditionalCues)) return "conditional";
  // No informative context: an opaque identifier is verification-only; any other
  // bare number stays essential (omitting a possibly-essential figure is worse).
  return isOpaqueIdentifier(entity) ? "verification_only" : "essential";
}

/**
 * For a safety alert, is a CONDITIONAL identifier (lot/strength/variant) actually
 * needed for an accurate, unambiguous warning? It is needed when the source
 * describes multiple lots or multiple strengths (the reader must know which one).
 * It is NOT needed when the source clearly scopes the recall to a single batch —
 * the reader action ("stop using the recalled product") stays accurate without
 * the code.
 */
export function safetyIdentifierNeeded(sourceText: string): boolean {
  const t = lightNormalize(sourceText);
  const singleBatch =
    /(?:one|a single|only one|single)\s+(?:lot|batch)/.test(t) ||
    /دفعة واحدة|دفعة محددة|تشغيلة واحدة/.test(t);
  if (singleBatch) return false;
  // Multiple distinct strengths → ambiguous without the strength.
  const strengths = new Set((t.match(/\d+(?:\.\d+)?\s?(?:mg|mcg|ml|ملغ|مغ|ميكروغرام)/g) ?? []));
  if (strengths.size > 1) return true;
  // Multiple lot/batch codes near a plural lot/batch mention → ambiguous.
  const lotSpans = (t.match(/(?:lots?|batches|دفعات|دفعتين|تشغيلات|دفعتان)[^.]{0,80}/g) ?? []).join(" ");
  const lotNums = new Set((foldDigits(lotSpans).match(/\b[a-z]?\d{3,}\b/g) ?? []));
  if (lotNums.size > 1) return true;
  return false;
}

// --- Arabic-first foreign-name naming contract -----------------------------
//
// A reader-essential FOREIGN proper name (medicine/company/product/institution)
// whose exact identity matters must appear in the visible article as:
//   «Arabic name/transliteration (Exact Original Name)»
// at the FIRST mention only, then Arabic alone afterward. The exact original
// identity has to survive (so the reader can pin down the product), but purely
// formal/regulatory suffixes ("for Injection", "USP", "Inc.", "Ltd", …) are
// removable — they are not part of the essential identity. This layer enforces
// that contract deterministically WITHOUT weakening factual validation and
// WITHOUT accepting fuzzy transliterations: the exact original identity string
// must still be present verbatim (inside the first-mention parenthetical).

// Removable formal/regulatory suffix words that are NOT part of an entity's
// essential identity. Only stripped as trailing tokens preceded by space/comma.
const REMOVABLE_NAME_SUFFIXES = [
  "for injection",
  "injection",
  "for solution",
  "solution",
  "for suspension",
  "suspension",
  "usp",
  "bp",
  "inc",
  "llc",
  "ltd",
  "plc",
  "corp",
  "corporation",
  "company",
  "gmbh",
  "ndc",
  "lot",
];

/**
 * Return an entity's ESSENTIAL identity by removing trailing formal/regulatory
 * suffixes (e.g. "Cyclophosphamide for Injection, USP" → "Cyclophosphamide",
 * "Sunny Pharmtech Inc." → "Sunny Pharmtech"). A chemical descriptor that IS
 * part of the identity (e.g. "Hydrochloride") is kept. Only standalone trailing
 * tokens (preceded by whitespace/comma) are stripped, so a name like "Aramco"
 * is never truncated.
 */
export function stripFormalSuffixes(name: string): string {
  let s = (name ?? "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const tok of REMOVABLE_NAME_SUFFIXES) {
      const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`[\\s,]+${esc}\\.?\\s*$`, "i");
      if (re.test(s)) {
        s = s.replace(re, "").trim();
        changed = true;
        break;
      }
    }
  }
  return s.replace(/[\s,]+$/, "").trim();
}

const ARABIC_LETTER_RE = /[\u0600-\u06FF]/;

/** Every case-insensitive occurrence of the multi-word `identity` phrase in
 *  `text`, each tagged with whether it is an Arabic-first parenthetical gloss:
 *  the phrase sits immediately inside "(" and an Arabic letter appears just
 *  before that "(" (e.g. "سيكلوفوسفاميد (Cyclophosphamide)"). */
function findIdentityOccurrences(
  text: string,
  identity: string,
): { index: number; isGloss: boolean }[] {
  const t = text ?? "";
  const tokens = identity
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tokens.length) return [];
  const re = new RegExp(tokens.join("\\s+"), "gi");
  const out: { index: number; isGloss: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(t[i])) i--;
    let isGloss = false;
    if (i >= 0 && t[i] === "(") {
      const before = t.slice(Math.max(0, i - 30), i);
      isGloss = ARABIC_LETTER_RE.test(before);
    }
    out.push({ index: m.index, isGloss });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

export type ForeignNameStatus = {
  // "ok": exact identity present, first mention is an Arabic-first gloss, not in
  //       the title, not repeated. "missing": exact identity absent everywhere.
  // "flagged": present but violates a placement/repetition/title rule.
  status: "ok" | "missing" | "flagged";
  present: boolean;
  firstMentionGloss: boolean;
  englishFirst: boolean;
  englishInTitle: boolean;
  englishRepeated: boolean;
};

/**
 * Deterministically evaluate the Arabic-first naming contract for one protected
 * foreign entity. The exact ORIGINAL identity (formal suffixes stripped) must
 * appear verbatim; the first visible mention must be an Arabic-first
 * parenthetical gloss; the title must stay Arabic-only; and the English form
 * must not repeat after the first mention.
 */
export function foreignEssentialNameStatus(input: {
  title: string;
  visible: string; // excerpt + body (the reader-facing story, minus the title)
  entity: string;
}): ForeignNameStatus {
  const identity = stripFormalSuffixes(input.entity);
  const occ = findIdentityOccurrences(input.visible ?? "", identity);
  const titleOcc = findIdentityOccurrences(input.title ?? "", identity);
  const present = occ.length > 0 || titleOcc.length > 0;
  if (!present) {
    return {
      status: "missing",
      present: false,
      firstMentionGloss: false,
      englishFirst: false,
      englishInTitle: false,
      englishRepeated: false,
    };
  }
  const firstMentionGloss = occ.length > 0 && occ[0].isGloss;
  const englishFirst = occ.length > 0 && !occ[0].isGloss;
  const englishInTitle = titleOcc.length > 0;
  const englishRepeated = occ.length >= 2;
  const clean = firstMentionGloss && !englishInTitle && !englishRepeated;
  return {
    status: clean ? "ok" : "flagged",
    present: true,
    firstMentionGloss,
    englishFirst,
    englishInTitle,
    englishRepeated,
  };
}

/**
 * Conservative, blocking fact-grounding checks. Any error here must prevent a
 * pending draft. Nothing is silently repaired — a factual contradiction is a
 * rejection, not a rewrite.
 */
export function checkFactGrounding(
  article: { title: string; excerpt: string; body: string },
  source: { sourceText: string; mustPreserve?: string[]; sourceLang?: string | null },
  profile: WritingProfile,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const generated = `${article.title}\n${article.excerpt}\n${article.body}`;
  const srcNorm = normalizeForCompare(source.sourceText);

  // 1) Every generated figure's VALUE must exist in the verified source, compared
  //    across formatting conventions: the source is read with its own locale's
  //    separators (Spanish "15.000" = 15000, "1,5" = 1.5), the draft (Arabic) with
  //    the English convention, and an adjacent Arabic/English scale word is folded
  //    in ("330 ألف" = 330000) so a faithful rendering of a grouped source figure
  //    matches. Leading zeros are still normalized so an ISO date component
  //    (`01`/`09` in `2026-09-01`) matches "1 سبتمبر 2026". A value genuinely
  //    absent in ANY convention, or a token that cannot be parsed unambiguously,
  //    still yields `unsupported_number` (fail closed) — the safeguard is intact.
  const sourceLocale = numberLocaleForLang(source.sourceLang);
  const srcNumbers = new Set(
    extractNumberEntries(source.sourceText, sourceLocale)
      .map((e) => e.value)
      .filter((v): v is string => v !== null),
  );
  for (const entry of extractNumberEntries(generated, "en")) {
    if (entry.value === null || !srcNumbers.has(entry.value)) {
      errors.push(`unsupported_number:${entry.raw}`);
      logNumberDiagnostic({
        token: entry.raw,
        tokenValue: entry.value,
        sourceValues: [...srcNumbers],
        sourceLang: source.sourceLang ?? null,
        locale: sourceLocale,
      });
    }
  }

  // 2) No invented quotations — a quoted span must appear in the source.
  for (const q of extractQuotes(article.body)) {
    const qn = normalizeForCompare(q);
    if (qn && !srcNorm.includes(qn)) errors.push("invented_quotation");
  }

  // 3) No unsupported strong efficacy/approval claim.
  for (const kw of CLAIM_KEYWORDS) {
    if (generated.includes(kw) && !source.sourceText.includes(kw)) {
      errors.push(`unsupported_claim:${kw}`);
    }
  }

  // 4) Research stories must not upgrade association into causation. Explicitly
  //    negated causal language ("لا يسبّب"، "لا يسمح بالجزم بأن أحدهما يسبّب
  //    الآخر") is NOT an upgrade and must pass.
  if (profile === "research_study") {
    const usesCausation = causationAsserted(article.body);
    const srcIsAssociation = containsAny(source.sourceText, ASSOCIATION_MARKERS);
    const srcIsCausation = causationAsserted(source.sourceText);
    if (usesCausation && srcIsAssociation && !srcIsCausation) {
      errors.push("association_as_causation");
    }
  }

  // 5) Reader-meaningful essential entities (drug/product/org/country names) must
  //    be preserved. For a safety alert a missing or altered essential identity
  //    is BLOCKING — a recall notice that drops the drug/authority it concerns is
  //    dangerous, so it must never become a pending draft. For every other
  //    profile it stays a non-blocking warning (the entity may be legitimately
  //    paraphrased elsewhere).
  //
  //    Whether an entity is REQUIRED to appear is decided by profile-aware
  //    relevance, not by the shape of the entity alone (a number may be essential
  //    in one profile and pure verification detail in another):
  //    - "verification_only" (NDC/registration/expiry/distribution/DOI codes):
  //      never required — omitting neither blocks nor warns. Values remain bound
  //      by the number/quote checks above wherever they DO appear.
  //    - "conditional" (safety lot/batch/strength/formulation): required only
  //      when the source is ambiguous enough that dropping it would make the
  //      warning unable to identify the affected product (safetyIdentifierNeeded).
  //      A single explicitly-scoped batch is omittable.
  //    - "essential" (drug/product/org/country names, and profile-relevant
  //      numbers like a study's sample size or a regulation's fine/date): must be
  //      preserved. Missing is BLOCKING for a safety alert (a recall that drops
  //      the drug/authority it concerns is dangerous), a warning elsewhere.
  const genNorm = normalizeForCompare(generated);
  const identifierNeeded = safetyIdentifierNeeded(source.sourceText);
  for (const ent of source.mustPreserve ?? []) {
    const vis = classifyEntityVisibility(ent, profile, source.sourceText);
    if (vis === "verification_only") continue;
    if (vis === "conditional" && !identifierNeeded) continue;

    // The essential identity (formal/regulatory suffixes removed) is what must
    // survive — never a shortened or altered form. A FOREIGN essential name is
    // held to the Arabic-first naming contract (exact original once, inside a
    // first-mention gloss, Arabic-only title, no English repetition); a native
    // Arabic essential name keeps the plain presence check.
    const identity = stripFormalSuffixes(ent);
    const idNorm = normalizeForCompare(identity);
    if (!idNorm) continue;
    const foreign = /[a-z]/.test(idNorm);

    if (!foreign) {
      if (!genNorm.includes(idNorm)) {
        if (profile === "safety_alert") errors.push(`missing_essential_entity:${ent}`);
        else warnings.push(`missing_essential_entity:${ent}`);
      }
      continue;
    }

    const rep = foreignEssentialNameStatus({
      title: article.title,
      visible: `${article.excerpt}\n${article.body}`,
      entity: ent,
    });
    if (rep.status === "missing") {
      // Exact original identity absent (or only a shortened/altered form present)
      // — blocking for a safety alert, a warning elsewhere. Unchanged severity.
      if (profile === "safety_alert") errors.push(`missing_essential_entity:${ent}`);
      else warnings.push(`missing_essential_entity:${ent}`);
      continue;
    }
    // Present, but flag placement/repetition deviations (advisory — the editorial
    // gate independently blocks title-English and inline English-only). These
    // never weaken factual validation.
    if (rep.englishInTitle) warnings.push(`essential_entity_english_in_title:${ent}`);
    if (rep.englishFirst) warnings.push(`essential_entity_not_arabic_first:${ent}`);
    if (rep.englishRepeated) warnings.push(`essential_entity_english_repeated:${ent}`);
  }

  // 6) Safety-alert official actions & unaffected-batch reassurance (blocking).
  //    Everything here is derived ONLY from the verified source text:
  //    - if the source explicitly instructs an official action (stop/avoid/
  //      return/discard/check/contact/seek help), the article MUST preserve at
  //      least one such action — dropping the "what to do" from a recall is
  //      dangerous;
  //    - the article must NOT invent an action the source never stated — an
  //      unfounded "return the product"/"seek emergency care" can cause harm;
  //    - an explicit "other batches are safe" reassurance in the source must be
  //      kept, so the alert does not needlessly condemn unaffected stock;
  //    - if the source directed an action only at the supply chain
  //      (distributors/retailers/pharmacies/facilities) and the article hands
  //      that same action to patients/consumers, this is BLOCKING for a safety
  //      alert — telling patients to "return"/"discard" a recalled medicine
  //      when only facilities were instructed to do so is unsafe guidance.
  if (profile === "safety_alert") {
    const srcActions = new Set(extractOfficialActions(source.sourceText));
    const genActions = new Set(extractOfficialActions(generated));
    if (srcActions.size > 0) {
      const preserved = [...srcActions].some((a) => genActions.has(a));
      if (!preserved) errors.push("missing_official_action");
    }
    for (const a of genActions) {
      if (!srcActions.has(a)) errors.push(`invented_official_action:${a}`);
    }
    if (hasUnaffectedBatchStatement(source.sourceText) && !hasUnaffectedBatchStatement(generated)) {
      errors.push("missing_unaffected_batch_statement");
    }
    // Conservative audience check: only flag an action the SOURCE gave to
    // facilities but NOT to patients, when the ARTICLE puts that action in a
    // patient-addressed clause. We do NOT fire when the source gives the same
    // action to both audiences, nor when the article keeps it correctly aimed
    // at facilities. For a safety alert this is BLOCKING (misdirected recall
    // guidance can cause harm); other profiles keep it as a warning.
    const srcAud = officialActionsByAudience(source.sourceText);
    const genAud = officialActionsByAudience(generated);
    // Facility-only source action handed to patients (dangerous), and the
    // symmetric case — a patient-only source action handed to facilities — so a
    // facility instance can never silently satisfy a patient action or vice
    // versa. Both directions are BLOCKING for a safety alert.
    for (const a of srcAud.facility) {
      if (!srcAud.patient.has(a) && genAud.patient.has(a)) {
        errors.push(`audience_misdirected_action:${a}`);
      }
    }
    for (const a of srcAud.patient) {
      if (!srcAud.facility.has(a) && genAud.facility.has(a)) {
        errors.push(`audience_misdirected_action:${a}`);
      }
    }
  } else {
    // Non-safety profiles: same misdirected-audience signal, but advisory only.
    const srcAud = officialActionsByAudience(source.sourceText);
    const genAud = officialActionsByAudience(generated);
    for (const a of srcAud.facility) {
      if (!srcAud.patient.has(a) && genAud.patient.has(a)) {
        warnings.push(`audience_misdirected_action:${a}`);
      }
    }
    for (const a of srcAud.patient) {
      if (!srcAud.facility.has(a) && genAud.facility.has(a)) {
        warnings.push(`audience_misdirected_action:${a}`);
      }
    }
  }
  return { errors: dedupeStrings(errors), warnings: dedupeStrings(warnings) };
}

function dedupeStrings(xs: string[]): string[] {
  return [...new Set(xs)];
}

// --- Editorial quality: compression & reader relevance (warnings only) -----
//
// These checks NEVER block a draft and NEVER touch factual validation — a fully
// grounded article is always allowed through. They surface *editorial* signals
// that a technically-correct article reads like a regulatory notice rather than
// an attractive Arabic news story, so the writer prompt / a reviewer can tighten
// it. All are advisory warnings.

// Distinct long English technical tokens beyond this are flagged (an Arabic
// story rarely needs more than a couple of Latin labels).
export const EDITORIAL_MAX_ENGLISH_TOKENS = 3;
// Verification-only identifiers (lot/NDC/registration codes) visible beyond this
// are flagged as regulatory clutter.
export const EDITORIAL_MAX_IDENTIFIERS = 2;
// Excerpt vs. title / opening-paragraph near-duplication threshold.
const EDITORIAL_DUP_JACCARD = 0.7;

// A Latin-script run of ≥4 chars starting with a letter: a candidate English
// technical token / medicine name inside an Arabic article.
const LATIN_TOKEN_RE = /[A-Za-z][A-Za-z0-9]{3,}/g;
// A bare numeric/hyphen code of the "0517-4002-25" / "25202" shape: reads as a
// regulatory identifier when printed in prose.
const CODE_TOKEN_RE = /\b\d[\d\-/]{3,}\d\b/g;

/**
 * Deterministic editorial-quality warnings for a written article. Purely
 * advisory: the returned strings are added to `warnings` only and never affect
 * whether a draft is created. `opts.verificationOnly` is the subset of
 * mustPreserve classified as verification-only for this profile (see
 * classifyEntityVisibility) so we can tell how many verification-only codes
 * leaked into the visible story.
 */
export function editorialQualityWarnings(
  article: { title: string; excerpt: string; body: string },
  profile: WritingProfile,
  opts: { verificationOnly?: string[] } = {},
): string[] {
  const warnings: string[] = [];
  const title = (article.title ?? "").trim();
  const excerpt = (article.excerpt ?? "").trim();
  const body = (article.body ?? "").trim();
  const titleBody = `${title}\n${body}`;

  // Distinct Latin word-tokens and their frequency across title + body.
  const wordCounts = new Map<string, number>();
  for (const tok of foldDigits(titleBody).match(LATIN_TOKEN_RE) ?? []) {
    const key = tok.toLowerCase();
    if (!/[a-z]{4,}/.test(key)) continue; // an alphabetic word, not a bare code
    wordCounts.set(key, (wordCounts.get(key) ?? 0) + 1);
  }
  // 1) The same long English (medicine) name repeated — it should appear once,
  //    only when needed to identify the product.
  if ([...wordCounts.values()].some((c) => c >= 2)) {
    warnings.push("editorial_english_name_repeated");
  }
  // 5) Too many DISTINCT English technical tokens overall.
  if (wordCounts.size > EDITORIAL_MAX_ENGLISH_TOKENS) {
    warnings.push("editorial_excess_english_tokens");
  }

  // 2) Excessive verification-only identifiers surfaced in the visible article:
  //    Category-C mustPreserve entities that DID appear, plus any bare code-shape
  //    token (e.g. an NDC) present in the prose.
  const visibleNorm = normalizeForCompare(`${titleBody}\n${excerpt}`);
  let idCount = 0;
  for (const ent of opts.verificationOnly ?? []) {
    const e = normalizeForCompare(ent);
    if (e && visibleNorm.includes(e)) idCount++;
  }
  idCount += (foldDigits(titleBody).match(CODE_TOKEN_RE) ?? []).length;
  if (idCount > EDITORIAL_MAX_IDENTIFIERS) {
    warnings.push("editorial_excess_identifiers");
  }

  // 3) Excerpt duplicating the title or the opening paragraph (wasted line).
  if (excerpt) {
    const ex = normalizeForCompare(excerpt);
    const ti = normalizeForCompare(title);
    if (ex && ti && (ex === ti || jaccard(ex, ti) >= EDITORIAL_DUP_JACCARD)) {
      warnings.push("editorial_excerpt_duplicates_title");
    } else {
      const firstPara = normalizeForCompare((body.split(/\n\s*\n/)[0] ?? ""));
      if (ex && firstPara && (firstPara.includes(ex) || jaccard(ex, firstPara) >= EDITORIAL_DUP_JACCARD)) {
        warnings.push("editorial_excerpt_duplicates_opening");
      }
    }
  }

  // 4) Body exceeds the profile's normal upper band — a compression opportunity
  //    (distinct from the neutral word_count_outside_band signal, this one names
  //    the editorial fix: an over-long article that should be tightened).
  const band = PROFILE_WORD_BANDS[profile];
  if (body && countWords(body) > band.max) {
    warnings.push("editorial_body_over_length");
  }

  return dedupeStrings(warnings);
}

// --- Parsing the model output (Step 10: strict structured output) ----------
//
// The writer contract is a SINGLE bare JSON object with three REQUIRED string
// fields — title, excerpt, body — plus one OPTIONAL string field, summary (the
// admin "باختصار" quick-summary box). Parsing is deliberately strict and purely
// deterministic: it never repairs, rewrites, or infers article content. Any
// deviation — surrounding prose, more than one object, a truncated/unterminated
// object, a malformed/invalid-fence payload, or a schema violation (a missing
// required field, an unknown field, an empty required value, a non-string, or an
// oversized field) — is a rejection carrying a specific safe reason, so
// malformed output can never become a pending draft. read_minutes is NOT part of
// this schema; it is always computed locally from the final Arabic body (see
// readingTimeMinutes).

export type WriterArticle = {
  title: string;
  excerpt: string;
  body: string;
  // One-sentence reader summary for the "باختصار" box. Optional and additive:
  // absent when the model returns the legacy three-field object.
  summary?: string;
};

// Only these keys may appear on the writer object; any other key is rejected.
const WRITER_ALLOWED_FIELDS = ["title", "excerpt", "body", "summary"] as const;
// The subset that MUST be present and non-empty (summary is optional).
const WRITER_REQUIRED_FIELDS = ["title", "excerpt", "body"] as const;

// Conservative upper bounds. Output beyond these is treated as an unsafe schema
// violation rather than trusted content (a real Arabic article — even the long
// research_study band — sits far under these caps).
const WRITER_MAX_TITLE_CHARS = 300;
const WRITER_MAX_EXCERPT_CHARS = 1000;
const WRITER_MAX_BODY_CHARS = 20000;
const WRITER_MAX_SUMMARY_CHARS = 400;

// The specific, non-repairing rejection reasons parseWriterOutput may return.
export type WriterParseError =
  | "writer_output_truncated"
  | "writer_output_code_fence_invalid"
  | "writer_output_extra_text"
  | "writer_output_multiple_objects"
  | "writer_output_invalid_json"
  | "writer_output_schema_invalid";

/**
 * Scan from the `{` at `start` for its matching top-level `}`, honoring JSON
 * string quoting and escapes so a brace inside a string is never miscounted.
 * Returns the closing-brace index (closed=true), or closed=false when the
 * object never closes — an unterminated / truncated object.
 */
function scanJsonObject(s: string, start: number): { end: number; closed: boolean } {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { end: i, closed: true };
    }
  }
  return { end: s.length - 1, closed: false };
}

/**
 * Unwrap a single Markdown code fence that wraps the WHOLE payload. It engages
 * only when the (trimmed) text starts with a fence, so a stray backtick inside
 * an otherwise-bare object is left untouched. The fence must span the entire
 * text, carry only an optional `json` info string, and contain no nested fence;
 * anything else is a code_fence_invalid rejection. Returns the inner text on a
 * valid fence, or the unchanged text when there was no leading fence.
 */
function unwrapCodeFence(
  text: string,
): { ok: true; text: string } | { ok: false; error: WriterParseError } {
  if (!text.startsWith("```")) return { ok: true, text };
  const m = text.match(/^```([^\n`]*)\n([\s\S]*?)\n?```$/);
  if (!m) return { ok: false, error: "writer_output_code_fence_invalid" };
  const lang = m[1].trim().toLowerCase();
  if (lang && lang !== "json") return { ok: false, error: "writer_output_code_fence_invalid" };
  if (m[2].includes("```")) return { ok: false, error: "writer_output_code_fence_invalid" };
  return { ok: true, text: m[2].trim() };
}

/**
 * Strictly parse the raw writer response into a WriterArticle. Accepts EXACTLY
 * one bare JSON object, or that same single object wrapped in one ```json code
 * fence. Rejects — with a specific reason, never a throw and never a silent
 * repair — surrounding prose, multiple objects, truncated/unterminated JSON,
 * malformed JSON, an invalid fence, and any schema violation (missing, extra,
 * empty, non-string, or oversized title/excerpt/body).
 */
export function parseWriterOutput(
  raw: string,
): { ok: true; article: WriterArticle } | { ok: false; error: WriterParseError } {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { ok: false, error: "writer_output_invalid_json" };

  const unfenced = unwrapCodeFence(trimmed);
  if (!unfenced.ok) return unfenced;
  const text = unfenced.text.trim();

  const open = text.indexOf("{");
  if (open === -1) return { ok: false, error: "writer_output_invalid_json" };
  // Any non-whitespace before the object is introductory prose.
  if (text.slice(0, open).trim() !== "") return { ok: false, error: "writer_output_extra_text" };

  const { end, closed } = scanJsonObject(text, open);
  if (!closed) return { ok: false, error: "writer_output_truncated" };

  // Content after the first complete object: another object → multiple_objects,
  // otherwise trailing prose → extra_text.
  const after = text.slice(end + 1).trim();
  if (after !== "") {
    return {
      ok: false,
      error: after.startsWith("{") ? "writer_output_multiple_objects" : "writer_output_extra_text",
    };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(open, end + 1));
  } catch {
    return { ok: false, error: "writer_output_invalid_json" };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "writer_output_schema_invalid" };
  }

  const o = obj as Record<string, unknown>;
  // No unexpected fields beyond the allowed schema.
  for (const key of Object.keys(o)) {
    if (!(WRITER_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: "writer_output_schema_invalid" };
    }
  }
  // Every REQUIRED field must be present and string-typed.
  for (const key of WRITER_REQUIRED_FIELDS) {
    if (!(key in o) || typeof o[key] !== "string") {
      return { ok: false, error: "writer_output_schema_invalid" };
    }
  }
  // The optional summary, when present, must be a string too.
  if ("summary" in o && typeof o.summary !== "string") {
    return { ok: false, error: "writer_output_schema_invalid" };
  }
  const title = (o.title as string).trim();
  const excerpt = (o.excerpt as string).trim();
  const body = (o.body as string).trim();
  const summary = "summary" in o ? (o.summary as string).trim() : "";
  // title and body must be non-empty; caps guard against unsafe lengths.
  if (!title || !body) return { ok: false, error: "writer_output_schema_invalid" };
  if (
    title.length > WRITER_MAX_TITLE_CHARS ||
    excerpt.length > WRITER_MAX_EXCERPT_CHARS ||
    body.length > WRITER_MAX_BODY_CHARS ||
    summary.length > WRITER_MAX_SUMMARY_CHARS
  ) {
    return { ok: false, error: "writer_output_schema_invalid" };
  }
  const article: WriterArticle = { title, excerpt, body };
  // Only attach summary when the model actually supplied a non-empty one, so the
  // legacy three-field object still parses to an identical shape.
  if (summary) article.summary = summary;
  return { ok: true, article };
}

// --- Orchestrator: validate a written article (Steps 2, 5, 6, 7, 8, 9) -----

export type ArticleValidation = {
  ok: boolean;
  profile: WritingProfile;
  cleanTitle: string;
  readMinutes: number;
  wordCount: number;
  warnings: string[];
  errors: string[];
  // A single, clear reason when ok === false (for the audit / logs). When ok is
  // true this is undefined and the draft may be created (status="pending").
  rejectionReason?: string;
};

const MIN_BODY_WORDS = 25; // shorter than this is not a real article for any profile

/**
 * Validate a written article end-to-end. Blocking checks (malformed structure,
 * fact grounding) set ok=false and a rejectionReason so the caller does NOT
 * create a pending draft. Everything else (headline/length/style) is a warning.
 * Reading time is always recomputed from the final Arabic body (Step 8).
 */
export function validateArticle(input: {
  article: { title: string; excerpt: string; body: string; profile?: WritingProfile };
  source: {
    sourceText: string;
    originalTitle?: string | null;
    brand?: string | null;
    mustPreserve?: string[];
    // Source language (ISO code) for locale-aware numeric grounding. Optional;
    // absent → English convention (safe default). See numberLocaleForLang.
    sourceLang?: string | null;
  };
}): ArticleValidation {
  const { article, source } = input;
  const profile = selectProfile({ explicit: article.profile ?? null, sourceText: source.sourceText });
  const errors: string[] = [];
  const warnings: string[] = [];

  const title = (article.title ?? "").trim();
  const body = (article.body ?? "").trim();
  const wordCount = countWords(body);
  const readMinutes = readingTimeMinutes(body);

  // Structural / malformed guard (blocking).
  if (title.length < 4) errors.push("malformed_output:title");
  if (!body) errors.push("malformed_output:body");
  else if (wordCount < MIN_BODY_WORDS) errors.push("malformed_output:body_too_short");

  // Headline (warnings only) — also yields the brand-stripped title.
  const head = validateHeadline(title, { originalTitle: source.originalTitle, brand: source.brand });
  warnings.push(...head.warnings);

  // Body/style promotional phrases (warnings).
  if (detectPromoPhrases(body).length) warnings.push("body_promotional");

  // Length band (warning).
  const band = PROFILE_WORD_BANDS[profile];
  if (body && (wordCount < band.min || wordCount > band.max)) {
    warnings.push(`word_count_outside_band:${profile}`);
  }

  // Fact grounding (blocking) — only meaningful when there is a body to check.
  if (body) {
    const fg = checkFactGrounding({ title: head.cleanTitle, excerpt: article.excerpt ?? "", body }, source, profile);
    errors.push(...fg.errors);
    warnings.push(...fg.warnings);

    // Editorial quality (advisory only — never blocking, never touches factual
    // validation). Profile-aware verification-only identifiers from mustPreserve
    // are passed through so leaked verification-only codes can be counted.
    const verificationOnly = (source.mustPreserve ?? []).filter(
      (e) => classifyEntityVisibility(e, profile, source.sourceText) === "verification_only",
    );
    warnings.push(
      ...editorialQualityWarnings(
        { title: head.cleanTitle, excerpt: article.excerpt ?? "", body },
        profile,
        { verificationOnly },
      ),
    );
  }

  const ok = errors.length === 0;
  return {
    ok,
    profile,
    cleanTitle: head.cleanTitle,
    readMinutes,
    wordCount,
    warnings: dedupeStrings(warnings),
    errors: dedupeStrings(errors),
    rejectionReason: ok ? undefined : errors[0],
  };
}

// --- Writing instructions / prompt (Steps 2, 3, 4, 5, 6) -------------------

const PROFILE_INSTRUCTIONS: Record<WritingProfile, string> = {
  quick_news:
    "خبر قصير مباشر (~100–160 كلمة): عنوان مباشر، مقدّمة قصيرة، ثمّ 2–4 فقرات موجزة تنقل الخبر دون حشو.",
  standard_news:
    "خبر معياري (~180–320 كلمة): وضّح السياق، واشرح ما الذي تغيّر ومن المتأثّر. أضف فقرة \"لماذا يهمّ؟\" فقط إذا كان ذلك مدعوماً بالمصدر، ولا تُقحمها في كل خبر.",
  regulation_or_service:
    "قرار وزاري / لائحة / خدمة رقمية / أهلية أو وصول (~160–320 كلمة): اشرح ما الذي تغيّر، ومتى يبدأ، ومن المشمول، وما الذي يحتاج القارئ لفعله، ومن أين جاءت التفاصيل الرسمية. تجنّب تماماً عبارات المديح أو الدعاية المؤسسية.",
  safety_alert:
    "تحذير سلامة (دواء/جهاز/غذاء/منتج/صحة عامة، ~120–260 كلمة): اذكر ما الذي يتعلّق به التحذير، والمنتج/الدفعة/الفئة/المكان المتأثّر عند توفّره، والإجراء الذي طلبته الجهة الرسمية صراحةً، وما الذي لا يزال غير مؤكّد. لا تخترع نصائح طبية تتجاوز المصدر الرسمي.",
  research_study:
    "دراسة محكّمة (~200–340 كلمة): اشرح ما درسه الباحثون، وحجم/فئة العيّنة عند توفّرها، والنتيجة الأساسية، ومعناها العملي، وحدودها، وهل تغيّر الممارسة أم أنها أوّلية. لا تصف الارتباط على أنه سببية، ولا تبالغ في الدراسات المخبرية أو على الحيوان أو الرصدية أو المبكّرة.",
};

/**
 * Build the Arabic writing instructions for a profile. This is the writer
 * prompt (prompt version e1.3a-salma-writer). It is intentionally distinct from
 * the discovery/selection prompt in index.ts and is NOT wired into a live model
 * call this checkpoint. `body` must be plain Arabic paragraphs separated by
 * blank lines (the frontend renders paragraphs only — no Markdown/HTML).
 */
export function buildWritingInstructions(profile: WritingProfile): string {
  const bannedList = BANNED_PROMO_PHRASES.map((p) => `«${p}»`).join("، ");
  return `أنت محرّر صحي في منصة "سلمى". حوّل المادة المصدرية المُتحقَّق منها إلى خبر صحي عربي واضح وجذّاب وموجز وموثوق. (إصدار التعليمات: ${WRITER_PROMPT_VERSION})

نوع الكتابة المطلوب:
${PROFILE_INSTRUCTIONS[profile]}

أسلوب سلمى:
- عربية فصحى صحفية حديثة سهلة الفهم، هادئة وذكية وموثوقة، مناسبة للكويت والخليج دون لهجة غير ضرورية، ومفهومة لغير المتخصّص. اكتب كصحفي لا كناسخٍ لبيان رسمي، وابتعد عن اللغة المراسمية أو التنظيمية أو الدعائية.
- تجنّب: نسخ عنوان المصدر، وذكر اسم المصدر في العنوان، والإثارة، والوعود المبالغ فيها، والمقدّمات غير الضرورية، والخاتمات المكرّرة، والاقتباسات المختلقة، والنصائح أو التأويلات غير المدعومة.
- عبارات ممنوعة صراحةً: ${bannedList}.

مبدأ التركيز التحريري (مهم):
- ليست كل معلومة وردت في المصدر لازمةً للنشر. احتفظ بالحقائق التقنية للتحقّق فقط، ولا تُقحمها في النص المرئي إلا إذا كان القارئ يحتاجها فعلاً ليتعرّف على المنتج أو يتّخذ الإجراء الصحيح.
- احذف من النص المرئي — ما لم تكن ضرورية حقاً — أرقام الدفعات/التشغيلات، وأرقام NDC أو التسجيل الداخلية، وتواريخ التوزيع أو انتهاء الصلاحية، والتركيز الدوائي الدقيق وتفاصيل التغليف، والاسم الإنجليزي الرسمي الطويل للمنتج.

العنوان:
- عادةً 8–12 كلمة، ينقل التطوّر الفعلي بلغة عربية سلسة وجذّابة دون مبالغة.
- لا تنسخ العنوان الأصلي ولا تُنهِ العنوان باسم المصدر أو الموقع.
- حافظ على هوية المنتج والدواء والجهة والدولة بلغة مفهومة. اذكر الاسم الإنجليزي للمنتج مرّة واحدة فقط وعند الحاجة للتعريف به، ولا تكرّر الاسم الإنجليزي الكامل.

المقتطف (excerpt):
- جملة واحدة واضحة (≈30–35 كلمة كحدّ أقصى) تلخّص الجوهر.
- لا تكرّر العنوان ولا الجملة الأولى من النص حرفياً.

المقدّمة والنص:
- افتح بالخبر نفسه: ماذا حدث، أين، من المتأثّر، وما الجديد — لا بلغة إعلانية ولا بتكرار العنوان.
- عادةً 3–4 فقرات قصيرة (للأخبار السريعة وتحذيرات السلامة نحو 90–150 كلمة إجمالاً)، واشرح المصطلحات الطبية بالعربية المبسّطة.
- ترجم القياسات بشكل طبيعي عند الحاجة، ولا تكتب التواريخ بالصيغة الأمريكية الخام إلا إذا كان التاريخ نفسه مهمّاً.
- يجب أن تبقى الأرقام والتواريخ وأحجام الدراسات وأسماء الأدوية والمنظمات والدول والإجراءات الرسمية — حيثما ذُكرت — أمينة تماماً للمادة المصدرية.

الملخّص «باختصار» (اختياري):
- إن أضفته، فاجعله جملة واحدة موجزة للقارئ المستعجل، مختلفةً عن المقتطف ولا تكرّره.

استخدم فقط الحقائق والاستشهادات المُتحقَّق منها والمُرفقة. لا تختلق رقماً أو تاريخاً أو اقتباساً أو ادّعاءً.

أعد كائن JSON واحداً فقط، دون أي نص قبله أو بعده ودون أسيجة برمجية (\`\`\`)، بالحقول التالية فقط لا غير (والحقل summary اختياري): {"title":"…","excerpt":"…","summary":"…","body":"فقرات مفصولة بسطر فارغ"}`;
}
