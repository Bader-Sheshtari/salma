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
function causationAsserted(text: string): boolean {
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
    /التخلص من (?:المنتج|الدواء|المستحضر|العبوة)/, /تخلص(?:وا)? من (?:المنتج|الدواء|العبوة)/,
    /إتلاف (?:المنتج|الدواء|العبوة)/, /رمي (?:المنتج|الدواء|العبوة)/,
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

/**
 * Conservative, blocking fact-grounding checks. Any error here must prevent a
 * pending draft. Nothing is silently repaired — a factual contradiction is a
 * rejection, not a rewrite.
 */
export function checkFactGrounding(
  article: { title: string; excerpt: string; body: string },
  source: { sourceText: string; mustPreserve?: string[] },
  profile: WritingProfile,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const generated = `${article.title}\n${article.excerpt}\n${article.body}`;
  const srcNorm = normalizeForCompare(source.sourceText);
  const srcNumbers = new Set(extractNumbers(source.sourceText).map(normalizeNumberToken));

  // 1) Every generated number/date must exist in the verified source material.
  //    Compared with leading zeros normalized so an ISO date component
  //    (e.g. `01`/`09` in `2026-09-01`) matches the same day/month written
  //    without padding in the Arabic body ("1 سبتمبر 2026").
  for (const n of extractNumbers(generated)) {
    if (!srcNumbers.has(normalizeNumberToken(n))) {
      errors.push(`unsupported_number:${n}`);
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

  // 5) Essential entities (drug/product/org/country names, batch numbers, the
  //    officially requested action) must be preserved. For a safety alert a
  //    missing or altered essential entity is BLOCKING — a recall notice that
  //    drops the drug/batch/authority it concerns is dangerous, so it must never
  //    become a pending draft. For every other profile it stays a non-blocking
  //    warning (the entity may be legitimately paraphrased elsewhere).
  const genNorm = normalizeForCompare(generated);
  for (const ent of source.mustPreserve ?? []) {
    const e = normalizeForCompare(ent);
    if (e && !genNorm.includes(e)) {
      if (profile === "safety_alert") errors.push(`missing_essential_entity:${ent}`);
      else warnings.push(`missing_essential_entity:${ent}`);
    }
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
    for (const a of srcAud.facility) {
      if (!srcAud.patient.has(a) && genAud.patient.has(a)) {
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
  }
  return { errors: dedupeStrings(errors), warnings: dedupeStrings(warnings) };
}

function dedupeStrings(xs: string[]): string[] {
  return [...new Set(xs)];
}

// --- Parsing the model output (Step 10: strict structured output) ----------
//
// The writer contract is a SINGLE bare JSON object with EXACTLY three string
// fields — title, excerpt, body. Parsing is deliberately strict and purely
// deterministic: it never repairs, rewrites, or infers article content. Any
// deviation — surrounding prose, more than one object, a truncated/unterminated
// object, a malformed/invalid-fence payload, or a schema violation (missing,
// extra, empty, non-string, or oversized fields) — is a rejection carrying a
// specific safe reason, so malformed output can never become a pending draft.
// read_minutes is NOT part of this schema; it is always computed locally from
// the final Arabic body (see readingTimeMinutes).

export type WriterArticle = {
  title: string;
  excerpt: string;
  body: string;
};

// Only these keys may appear on the writer object; any other key is rejected.
const WRITER_ALLOWED_FIELDS = ["title", "excerpt", "body"] as const;

// Conservative upper bounds. Output beyond these is treated as an unsafe schema
// violation rather than trusted content (a real Arabic article — even the long
// research_study band — sits far under these caps).
const WRITER_MAX_TITLE_CHARS = 300;
const WRITER_MAX_EXCERPT_CHARS = 1000;
const WRITER_MAX_BODY_CHARS = 20000;

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
  // No unexpected fields beyond the three-field schema.
  for (const key of Object.keys(o)) {
    if (!(WRITER_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: "writer_output_schema_invalid" };
    }
  }
  // Every schema field must be present and string-typed.
  for (const key of WRITER_ALLOWED_FIELDS) {
    if (!(key in o) || typeof o[key] !== "string") {
      return { ok: false, error: "writer_output_schema_invalid" };
    }
  }
  const title = (o.title as string).trim();
  const excerpt = (o.excerpt as string).trim();
  const body = (o.body as string).trim();
  // title and body must be non-empty; caps guard against unsafe lengths.
  if (!title || !body) return { ok: false, error: "writer_output_schema_invalid" };
  if (
    title.length > WRITER_MAX_TITLE_CHARS ||
    excerpt.length > WRITER_MAX_EXCERPT_CHARS ||
    body.length > WRITER_MAX_BODY_CHARS
  ) {
    return { ok: false, error: "writer_output_schema_invalid" };
  }
  return { ok: true, article: { title, excerpt, body } };
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
  source: { sourceText: string; originalTitle?: string | null; brand?: string | null; mustPreserve?: string[] };
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
- عربية فصحى حديثة سهلة الفهم، صحفية لا حكومية، هادئة وذكية وموثوقة، مناسبة للكويت والخليج دون لهجة غير ضرورية، ومفهومة لغير المتخصّص.
- تجنّب: نسخ عنوان المصدر، وذكر اسم المصدر في العنوان، والإثارة، والوعود المبالغ فيها، والعبارات المراسمية أو الدعائية، والمقدّمات غير الضرورية، والخاتمات المكرّرة، والاقتباسات المختلقة، والنصائح أو التأويلات غير المدعومة.
- عبارات ممنوعة صراحةً: ${bannedList}.

العنوان:
- عادةً 7–14 كلمة، ينقل التطوّر الفعلي، جذّاب دون مبالغة.
- لا تنسخ العنوان الأصلي ولا تُنهِ العنوان باسم المصدر أو الموقع.
- حافظ على أسماء الأدوية والمنظمات والدول والخدمات الأساسية، وميّز بين الإعلان والتطبيق المؤكّد.

المقدّمة والنص:
- افتح بإجابة سريعة: ماذا حدث، أين، من المتأثّر، وما الجديد. لا تكرّر العنوان كأول جملة.
- فقرات قصيرة، واشرح المصطلحات الطبية بالعربية المبسّطة.
- يجب أن تبقى الأرقام والتواريخ وأحجام الدراسات وأسماء الأدوية والمنظمات والدول والإجراءات الرسمية أمينة تماماً للمادة المصدرية.

استخدم فقط الحقائق والاستشهادات المُتحقَّق منها والمُرفقة. لا تختلق رقماً أو تاريخاً أو اقتباساً أو ادّعاءً.

أعد كائن JSON واحداً فقط، دون أي نص قبله أو بعده ودون أسيجة برمجية (\`\`\`)، ويحتوي هذه الحقول الثلاثة فقط لا غير: {"title":"…","excerpt":"…","body":"فقرات مفصولة بسطر فارغ"}`;
}
