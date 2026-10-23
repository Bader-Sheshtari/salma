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

export const WRITER_PROMPT_VERSION = "e2.2-salma-writer" as const;

// --- Profiles (Step 3) -----------------------------------------------------

// "quick_news" is RETIRED from selection (e2.0: length follows significance, not
// a pre-chosen short format). The member is kept only for back-compat with
// stored/explicitly-passed values; its writing guidance and monitoring band are
// the standard_news ones.
export type WritingProfile =
  | "quick_news"
  | "standard_news"
  | "regulation_or_service"
  | "safety_alert"
  | "research_study";

// e2.0 MONITORING bands (Arabic words) per profile — deliberately wide. They are
// not writing targets (the prompts carry no numeric word targets); outside the
// band is a WARNING only (word_count_outside_band), never a hard block — only
// truly empty/degenerate output is malformed. salmaEditor.ts reads the same
// band.max for its editorial_body_over_length signal, so the writer and editor
// stay consistent.
const NEWS_MONITORING_BAND = { min: 60, max: 500 } as const;
export const PROFILE_WORD_BANDS: Record<WritingProfile, { min: number; max: number }> = {
  quick_news: { ...NEWS_MONITORING_BAND }, // retired — same as standard_news
  standard_news: { ...NEWS_MONITORING_BAND },
  regulation_or_service: { ...NEWS_MONITORING_BAND },
  safety_alert: { ...NEWS_MONITORING_BAND },
  research_study: { min: 60, max: 600 },
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
 * we fall back to regulation/service, then standard news. quick_news is never
 * selected (e2.0); an explicit stored "quick_news" is still honoured as-is for
 * back-compat (its prompt guidance and band are the standard_news ones).
 */
export function selectProfile(input: {
  explicit?: WritingProfile | null;
  sourceText: string;
  // Retired (e2.0): length no longer picks a profile. Accepted and ignored so
  // existing callers keep compiling.
  targetWords?: number;
}): WritingProfile {
  if (input.explicit) return input.explicit;
  const t = input.sourceText ?? "";
  const sensitive = sensitiveProfileHint(t);
  if (sensitive) return sensitive;
  if (containsAny(t, REGULATION_KEYWORDS)) return "regulation_or_service";
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
 *  tatweel, unify punctuation to spaces, collapse whitespace, lowercase.
 *  P2-B8: also folds Arabic ORTHOGRAPHIC variants that never change a word —
 *  alef forms (أ إ آ ٱ → ا), hamza carriers (ؤ → و, ئ → ي, bare ء dropped),
 *  alef maqsura (ى → ي) and taa marbuta (ة → ه) — on BOTH sides of every
 *  comparison, so «الهيئة» ≡ «الهيئه» and «إدارة» ≡ «ادارة». Letters that
 *  distinguish different words (e.g. ت vs ة, ك vs ق) are never merged. */
export function normalizeForCompare(text: string): string {
  return foldDigits(text ?? "")
    .replace(/[\u064B-\u065F\u0610-\u061A\u0670]/g, "") // harakat
    .replace(/\u0640/g, "") // tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    // Limitation (P2R-11): a bare hamza is DROPPED, not mapped, so words that
    // differ only by a final/medial bare ء compare equal (جزء ≡ جز, بدء ≡ بد).
    // Both sides fold identically and no drug/organisation name in our
    // fixtures differs only by a bare ء; entity matching stays token-exact.
    .replace(/ء/g, "")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

// --- P2-B8: Arabic-aware token matching for entity presence ----------------
//
// Entity presence (writer missing_essential_entity + editor dropped-entity
// guard) compares on folded TOKENS: normalizeForCompare's orthographic folds,
// plus a leading definite article / article-bearing proclitic (ال، وال، بال،
// فال، كال، لل) and the feminine nisba ending (-ية → -ي) so «السعودية» ≡
// «سعودية» ≡ «سعودي». Matching is TOKEN-EXACT on contiguous token runs — never
// a fuzzy/edit-distance match — so two different drug names can never become
// equal (a one-letter difference survives every fold).

/** Fold one already-normalized token (see normalizeForCompare). */
export function foldArabicToken(tok: string): string {
  let t = tok ?? "";
  if (!/[\u0600-\u06FF]/.test(t)) return t;
  const m = t.match(/^(?:[وف]?[بك]?ال|[وف]?لل)(.{2,})$/u);
  if (m) t = m[1];
  if (t.length > 3 && t.endsWith("يه")) t = t.slice(0, -1);
  return t;
}

/** Folded token list of a text, for token-run entity matching. */
export function arabicMatchTokens(text: string): string[] {
  return normalizeForCompare(text).split(" ").filter(Boolean).map(foldArabicToken);
}

/** A text token with a leading conjunction/preposition proclitic removed
 *  («وإدارة» → «إدارة», «لشركة» → «شركة»), or null when none applies. */
function stripTextProclitic(tok: string): string | null {
  const m = tok.match(/^[وف]?[بلك]?(.{3,})$/u);
  if (!m || m[1] === tok || !/^[\u0600-\u06FF]/.test(tok)) return null;
  return foldArabicToken(m[1]);
}

/** Does `hay` contain `needle`'s folded tokens as one contiguous run? The
 *  FIRST text token of the run may carry a proclitic (و/ف + ب/ل/ك) that the
 *  entity itself does not — «وإدارة الغذاء والدواء» contains «إدارة الغذاء
 *  والدواء». Only the text side is ever stripped, never the entity. */
export function containsFoldedPhrase(hay: string[], needleText: string): boolean {
  const needle = arabicMatchTokens(needleText);
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] === needle[j]) continue;
      if (j === 0 && stripTextProclitic(hay[i]) === needle[0]) continue;
      continue outer;
    }
    return true;
  }
  return false;
}

// P2-B8: narrow, fixed regulator equivalence groups (English name/acronym ↔ the
// canonical Arabic name). Shared by the writer entity check and the editor
// dropped-entity guard. A preserved regulator entity is satisfied by ANY
// member of its own group; groups never overlap (the US FDA «إدارة» and the
// Saudi SFDA «هيئة» stay distinct).
export const REGULATOR_EQUIVALENTS: readonly (readonly string[])[] = [
  [
    "FDA", "U.S. FDA", "US FDA", "Food and Drug Administration",
    "U.S. Food and Drug Administration", "US Food and Drug Administration",
    "إدارة الغذاء والدواء", "إدارة الغذاء والدواء الأمريكية", "هيئة الغذاء والدواء الأمريكية",
  ],
  ["WHO", "World Health Organization", "World Health Organisation", "منظمة الصحة العالمية"],
  ["EMA", "European Medicines Agency", "وكالة الأدوية الأوروبية", "الوكالة الأوروبية للأدوية"],
  [
    // P2R-2: no bare «هيئة الغذاء والدواء» — only Saudi-qualified forms.
    "SFDA", "Saudi Food and Drug Authority", "Saudi FDA",
    "هيئة الغذاء والدواء السعودية", "الهيئة العامة للغذاء والدواء السعودية",
    // P2R2-H: the SFDA's official Arabic name, with or without «السعودية».
    "الهيئة العامة للغذاء والدواء",
  ],
  [
    "CDC", "U.S. CDC", "Centers for Disease Control and Prevention",
    "Centers for Disease Control", "مراكز السيطرة على الأمراض والوقاية منها",
    "مراكز مكافحة الأمراض والوقاية منها", "المراكز الأمريكية لمكافحة الأمراض",
    "مراكز السيطرة على الأمراض", "مراكز مكافحة الأمراض",
  ],
];

/** The regulator group an entity belongs to (exact normalized match), or null. */
export function regulatorGroup(entity: string): readonly string[] | null {
  const n = normalizeForCompare(entity);
  if (!n) return null;
  for (const g of REGULATOR_EQUIVALENTS) {
    if (g.some((v) => normalizeForCompare(v) === n)) return g;
  }
  return null;
}

// P2R-2: tokens that, right before/after a member, make it ANOTHER country's
// regulator (Saudi FDA, «إدارة الغذاء والدواء السعودية»).
const REGULATOR_FOREIGN_QUALIFIERS = new Set(["saudi", "سعودي", "sfda"]);

/** Is a regulator entity present in `text` under ANY member of its group?
 *  P2R-2: an all-caps acronym member (FDA, WHO, EMA, CDC, SFDA, "U.S. FDA")
 *  matches only as a case-sensitive whole word — the English pronoun "who"
 *  never counts as the WHO; every other member matches as a folded token run
 *  that is NOT qualified by a Saudi marker immediately before/after it, so
 *  "Saudi FDA" / «… السعودية» never satisfy the US FDA group. */
export function regulatorPresent(group: readonly string[], text: string): boolean {
  const raw = text ?? "";
  const hay = arabicMatchTokens(raw);
  const isSaudiGroup = group.includes("SFDA");
  return group.some((v) => {
    if (/^[A-Z.\s]{2,10}$/.test(v)) {
      const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
      const re = new RegExp(`(?<![A-Za-z])${esc}(?![A-Za-z])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        if (isSaudiGroup) return true;
        const before = raw.slice(Math.max(0, m.index - 12), m.index);
        const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 20);
        if (/saudi\s*$/i.test(before) || /سعودي/.test(before)) continue;
        if (/^\s*(?:in Saudi|of Saudi|في السعودي|بالسعودي|السعودي)/i.test(after)) continue;
        return true;
      }
      return false;
    }
    // English qualifies BEFORE the name ("Saudi Food and Drug …"), Arabic
    // AFTER it («إدارة الغذاء والدواء السعودية») — «مسؤول سعودي وإدارة الغذاء
    // والدواء» is a Saudi official AND the US FDA, not a Saudi regulator.
    // P2R2-H: a postfix «في السعودية» / "in Saudi …" also disqualifies.
    return foldedRuns(hay, v).some(([i, j]) =>
      isSaudiGroup ||
      (!["saudi", "sfda"].includes(hay[i - 1] ?? "") &&
        !REGULATOR_FOREIGN_QUALIFIERS.has(hay[j] ?? "") &&
        !(["في", "in", "of"].includes(hay[j] ?? "") && REGULATOR_FOREIGN_QUALIFIERS.has(hay[j + 1] ?? "")) &&
        stripTextProclitic(hay[j] ?? "") !== "سعودي")
    );
  });
}

/** Every [start, end) token run in `hay` matching `needleText` (same rules as
 *  containsFoldedPhrase). */
function foldedRuns(hay: string[], needleText: string): [number, number][] {
  const needle = arabicMatchTokens(needleText);
  const out: [number, number][] = [];
  if (!needle.length) return out;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] === needle[j]) continue;
      if (j === 0 && stripTextProclitic(hay[i]) === needle[0]) continue;
      continue outer;
    }
    out.push([i, i + needle.length]);
  }
  return out;
}

/** Arabic-aware presence of a NATIVE (Arabic-script) or country/regulator
 *  entity: the legacy normalized-substring check OR a folded token-run match.
 *  Only ever ADDS ways for a genuinely present entity to be recognised; a
 *  missing name still fails. */
export function arabicEntityPresent(entityIdentity: string, text: string): boolean {
  const idNorm = normalizeForCompare(entityIdentity);
  if (!idNorm) return false;
  if (normalizeForCompare(text).includes(idNorm)) return true;
  return containsFoldedPhrase(arabicMatchTokens(text), entityIdentity);
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

/** Number entries WITH their character span in `text` (same scan as
 *  extractNumberEntries; foldDigits and the ٬/٫ folds are length-preserving, so
 *  the indices address the original text). Used to exempt the components of a
 *  FULLY grounded date from the per-number check (P2-A1). */
function scanNumberEntries(
  text: string,
  locale: NumberLocale,
): { raw: string; value: string | null; start: number; end: number }[] {
  const folded = foldDigits(text ?? "").replace(/٬/g, ",").replace(/٫/g, ".");
  const re =
    /(\d[\d.,]*)\s*(ألف|آلاف|الف|آلآف|مليون|ملايين|مليار|مليارات|بليون|thousands?|millions?|billions?)?/giu;
  const out: { raw: string; value: string | null; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) {
    if (!m[1]) {
      if (m.index === re.lastIndex) re.lastIndex++;
      continue;
    }
    const raw = m[1].replace(/[.,]+$/, "");
    let value = parseNumberToken(raw, locale);
    const exp = scaleExponent(m[2]);
    if (value !== null && exp > 0) value = applyScale(value, exp);
    out.push({ raw, value, start: m.index, end: m.index + raw.length });
  }
  return out;
}

// --- P2-A1: date grounding (unsupported_date, blocking) --------------------
//
// A date in the draft must match a date the verified source states, compared
// as a DATE (day + month [+ year]) under folding: month name ↔ numeric month,
// zero padding, and day/month order both ways for an all-numeric date. A
// matching day number and year existing SOMEWHERE in the source is not enough
// — «10 أكتوبر 2026» against a source that says "as of October 7, 2026" is an
// unsupported date even though 10 and 2026 both occur in the source. A year
// alone («2026») or a month alone is NOT a date token (the number check
// already covers a bare year). Same repairable class as unsupported_number.

export type DateToken = {
  raw: string;
  start: number; // span in the ORIGINAL text
  end: number;
  // Every (day, month, year) reading of the token; an all-numeric d/m/y yields
  // both day-first and month-first readings when both are valid.
  readings: { d: number | null; m: number; y: number | null }[];
  // P2R-4: a day RANGE / pair («7 و8 أكتوبر», "between October 1 and 7") —
  // every reading is an endpoint that must be supported, not an alternative.
  requireAll?: boolean;
};

// Month lexicon on the date-fold (diacritics stripped, alef folded, lowercase).
// Gulf/Egyptian, Levantine and English names (+ common English abbreviations).
const MONTH_NAMES: [string, number][] = [
  ["يناير", 1], ["كانون الثاني", 1], ["فبراير", 2], ["شباط", 2], ["مارس", 3], ["اذار", 3],
  ["ابريل", 4], ["نيسان", 4], ["مايو", 5], ["ايار", 5], ["يونيو", 6], ["يونيه", 6], ["حزيران", 6],
  ["يوليو", 7], ["يوليه", 7], ["تموز", 7], ["اغسطس", 8], ["اب", 8], ["سبتمبر", 9], ["ايلول", 9],
  ["اكتوبر", 10], ["تشرين الاول", 10], ["نوفمبر", 11], ["تشرين الثاني", 11], ["ديسمبر", 12],
  ["كانون الاول", 12],
  ["january", 1], ["jan", 1], ["february", 2], ["feb", 2], ["march", 3], ["mar", 3],
  ["april", 4], ["apr", 4], ["may", 5], ["june", 6], ["jun", 6], ["july", 7], ["jul", 7],
  ["august", 8], ["aug", 8], ["september", 9], ["sept", 9], ["sep", 9], ["october", 10],
  ["oct", 10], ["november", 11], ["nov", 11], ["december", 12], ["dec", 12],
  // Radar sources include European languages (accents are folded by dateFold).
  // es / pt / fr / de / it — only names not already listed above.
  ["enero", 1], ["febrero", 2], ["marzo", 3], ["abril", 4], ["mayo", 5], ["junio", 6],
  ["julio", 7], ["agosto", 8], ["septiembre", 9], ["setiembre", 9], ["octubre", 10],
  ["noviembre", 11], ["diciembre", 12],
  ["janeiro", 1], ["fevereiro", 2], ["marco", 3], ["maio", 5], ["junho", 6], ["julho", 7],
  ["setembro", 9], ["outubro", 10], ["novembro", 11], ["dezembro", 12],
  ["janvier", 1], ["fevrier", 2], ["mars", 3], ["avril", 4], ["mai", 5], ["juin", 6],
  ["juillet", 7], ["aout", 8], ["septembre", 9], ["octobre", 10], ["novembre", 11], ["decembre", 12],
  ["januar", 1], ["februar", 2], ["marz", 3], ["juni", 6], ["juli", 7], ["oktober", 10], ["dezember", 12],
  ["gennaio", 1], ["febbraio", 2], ["aprile", 4], ["maggio", 5], ["giugno", 6], ["luglio", 7],
  ["settembre", 9], ["ottobre", 10], ["dicembre", 12],
];
const MONTH_LOOKUP = new Map(MONTH_NAMES.map(([n, v]) => [n, v]));
const MONTH_ALT = [...MONTH_NAMES]
  .map(([n]) => n)
  .sort((a, b) => b.length - a.length)
  .map((n) => n.replace(/ /g, "\\s+"))
  .join("|");
// A month word: optional Arabic proclitic (و/ب/ل/ف), the name, an optional
// abbreviation dot, never inside a longer word; optional dual naming
// «أكتوبر/تشرين الأول».
const MONTH_RE_SRC =
  `(?<![\\p{L}])[وبلف]?(${MONTH_ALT})\\.?(?![\\p{L}])(?:\\s*/\\s*(?:${MONTH_ALT})(?![\\p{L}]))?`;
const DAY_SRC = `(\\d{1,2})(?:st|nd|rd|th|er|o|º)?\\.?`;
const YEAR_SRC = `(?:عام\\s+|سنة\\s+|de\\s+|del\\s+)?(\\d{4})(?!\\d)`;
// Connector between a day and its month: Arabic «من»/«شهر», English "of",
// Romance "de"/"del".
const DAY_MONTH_JOIN = `[\\s\\-/]*(?:(?:من|of|de|del)\\s+)?(?:شهر\\s+)?`;
// P2R-4: second day of a pair/range ("7 and 8", «1 و7», "1-7", "1 to 7").
const DAY_RANGE_SRC = `(?:\\s*(?:[-–&]|and|to|through|و|إلى|الى|حتى)\\s*(\\d{1,2})(?!\\d))?`;
// P2R-4: month words too ambiguous to count as a standalone month mention
// (English modal "may", verb "march", «مارس» "practised", «آب» "father").
const AMBIGUOUS_STANDALONE_MONTHS = new Set(["may", "mar", "mai", "mars", "marco", "march", "اب", "مارس"]);

/** Length-tracked date fold: digits → Western, Arabic diacritics/tatweel
 *  dropped, alef forms → ا, Latin accents dropped (é → e), lowercase. `map[i]` is the original index of the
 *  i-th folded character. */
function dateFold(text: string): { s: string; map: number[] } {
  const src = foldDigits(text ?? "");
  let s = "";
  const map: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (/[ً-ٟؐ-ؚٰـ]/.test(c)) continue;
    let o = /[أإآٱ]/.test(c) ? "ا" : c.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (o.length !== 1) o = c;
    s += o;
    map.push(i);
  }
  return { s, map };
}

function monthOf(word: string | undefined): number | null {
  if (!word) return null;
  return MONTH_LOOKUP.get(word.replace(/\s+/g, " ")) ?? null;
}

function validDay(d: number): boolean {
  return d >= 1 && d <= 31;
}

/** Extract every date token from a text (ISO, all-numeric d/m/y or m/d/y with a
 *  year, and month-name forms carrying a day and/or a year). */
export function extractDateTokens(text: string): DateToken[] {
  const { s, map } = dateFold(text);
  const out: DateToken[] = [];
  const taken: [number, number][] = [];
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  const push = (a: number, b: number, readings: DateToken["readings"], requireAll = false) => {
    if (!readings.length || !free(a, b)) return;
    taken.push([a, b]);
    const start = map[a];
    const end = map[b - 1] + 1;
    out.push({
      raw: foldDigits(text).slice(start, end).trim(),
      start,
      end,
      readings,
      ...(requireAll && readings.length > 1 ? { requireAll: true } : {}),
    });
  };
  const run = (
    re: RegExp,
    f: (m: RegExpExecArray) => DateToken["readings"] | { readings: DateToken["readings"]; all: boolean },
  ) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const r = f(m);
      if (Array.isArray(r)) push(m.index, m.index + m[0].length, r);
      else push(m.index, m.index + m[0].length, r.readings, r.all);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  };
  // 1) ISO yyyy-mm-dd (also / and .), e.g. a "2026-10-07T…" timestamp.
  run(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g, (m) => {
    const y = +m[1], mo = +m[2], d = +m[3];
    return mo >= 1 && mo <= 12 && validDay(d) ? [{ d, m: mo, y }] : [];
  });
  // 2) All-numeric a/b/yyyy (or yy): both day-first and month-first readings.
  run(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/.-])/g, (m) => {
    const a = +m[1], b = +m[2];
    let y = +m[3];
    if (m[3].length === 2) y += 2000;
    const r: DateToken["readings"] = [];
    if (b >= 1 && b <= 12 && validDay(a)) r.push({ d: a, m: b, y });
    if (a >= 1 && a <= 12 && validDay(b) && a !== b) r.push({ d: b, m: a, y });
    return r;
  });
  // 3) Day[–Day] [من] [شهر] Month [, Year] — «7 أكتوبر 2026», «7 و8 أكتوبر»,
  //    "7 October 2026", "07-Oct-2026" (P2R-4: hyphen/slash separators).
  run(
    new RegExp(
      `(?<!\\d)${DAY_SRC}${DAY_RANGE_SRC}${DAY_MONTH_JOIN}${MONTH_RE_SRC}(?:[\\s,،\\-/]+${YEAR_SRC})?`,
      "gu",
    ),
    (m) => {
      const d = +m[1], mo = monthOf(m[3]);
      const y = m[4] ? +m[4] : null;
      if (!mo || !validDay(d)) return [];
      const r: DateToken["readings"] = [{ d, m: mo, y }];
      if (m[2] && validDay(+m[2])) r.push({ d: +m[2], m: mo, y });
      return { readings: r, all: true };
    },
  );
  // 4) Month Day[–Day][, Year] — "October 7, 2026", "Oct. 1-7, 2026",
  //    "October 7 and 8", "between October 1 and 7". P2R-4: «مارس» is a month
  //    only before a day-less year or after a day (shapes 3/5), never here.
  run(
    new RegExp(`${MONTH_RE_SRC}\\s+${DAY_SRC}${DAY_RANGE_SRC}(?![\\d])(?:,?\\s+${YEAR_SRC})?`, "gu"),
    (m) => {
      if (m[1] === "مارس") return [];
      const mo = monthOf(m[1]);
      const d1 = +m[2];
      if (!mo || !validDay(d1)) return [];
      const y = m[4] ? +m[4] : null;
      const r: DateToken["readings"] = [{ d: d1, m: mo, y }];
      if (m[3] && validDay(+m[3])) r.push({ d: +m[3], m: mo, y });
      return { readings: r, all: true };
    },
  );
  // 5) Month Year (no day) — «أكتوبر 2026», "October 2026".
  run(new RegExp(`${MONTH_RE_SRC}[\\s,،]+${YEAR_SRC}`, "gu"), (m) => {
    const mo = monthOf(m[1]);
    return mo ? [{ d: null, m: mo, y: +m[2] }] : [];
  });
  return out.sort((a, b) => a.start - b.start);
}

/** Months the source MENTIONS: from its date tokens plus standalone,
 *  unambiguous month words (P2R-4). */
function sourceMonths(sourceText: string, tokens: DateToken[]): Set<number> {
  const out = new Set<number>(tokens.flatMap((t) => t.readings.map((r) => r.m)));
  const { s } = dateFold(sourceText);
  const re = new RegExp(MONTH_RE_SRC, "gu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const w = m[1].replace(/\s+/g, " ");
    if (AMBIGUOUS_STANDALONE_MONTHS.has(w)) continue;
    const mo = monthOf(w);
    if (mo) out.add(mo);
  }
  return out;
}

/** Is a draft date reading supported by a source date reading? Month must
 *  match; a draft day must equal a stated source day; a draft year must equal
 *  the source date's year, or — when that source date carries no year — the
 *  year must itself occur as a number in the source. */
function dateReadingSupported(
  a: DateToken["readings"][number],
  s: DateToken["readings"][number],
  srcNumbers: Set<string>,
): boolean {
  if (a.m !== s.m) return false;
  if (a.d !== null && s.d !== a.d) return false;
  if (a.y !== null) {
    if (s.y !== null) return s.y === a.y;
    if (a.d === null) return false; // "month year" needs a source date with that year
    return srcNumbers.has(String(a.y));
  }
  return true;
}

/** Draft date tokens that match no source date. */
export function unsupportedDates(
  draftText: string,
  sourceText: string,
  srcNumbers: Set<string> = new Set(),
): { supported: DateToken[]; unsupported: DateToken[] } {
  const srcTokens = extractDateTokens(sourceText);
  // A source range/pair contributes BOTH endpoints as stated dates.
  const src = srcTokens.flatMap((t) => t.readings);
  const months = sourceMonths(sourceText, srcTokens);
  const readingOk = (a: DateToken["readings"][number]) =>
    src.some((s) => dateReadingSupported(a, s, srcNumbers)) ||
    // P2R-4: a day-less "month year" is supported when the source mentions
    // that month and the year occurs anywhere in the source.
    (a.d === null && a.y !== null && months.has(a.m) && srcNumbers.has(String(a.y)));
  const supported: DateToken[] = [];
  const unsupported: DateToken[] = [];
  for (const tok of extractDateTokens(draftText)) {
    // A draft range/pair needs EVERY endpoint supported; a numeric d/m
    // ambiguity needs ANY reading.
    const ok = tok.requireAll ? tok.readings.every(readingOk) : tok.readings.some(readingOk);
    (ok ? supported : unsupported).push(tok);
  }
  return { supported, unsupported };
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

// P2R-1 (replaces the P2-FIX3 word-count / speech-verb heuristic, which was
// both leaky — «آمن تماماً» after «وصفت» passed — and too narrow — «بحسب»
// misfired as a speech verb). A «»/"…"/“…” span is EXEMPT from the
// invented-quotation check ONLY when it is demonstrably a transliterated source
// NAME: (a) it carries no claim/safety word, AND (b) its consonant skeleton
// matches a Latin token sequence of the verified source at ≥ 0.8 (the P2-A4
// transliteration mapper; digits kept, acronyms also read letter by letter).
// «كار-تي» (CAR-T), «تراي نت إكس» (TriNetX), «سي دي 19» (CD19), «نيتشر»
// (Nature) are exempt; every other span is checked as before, whatever its
// length or the words around it.
const QUOTE_CLAIM_LEXICON = [
  "آمن", "أمان", "خطر", "خطير", "فعال", "فعالية", "شفاء", "مضمون", "تحت السيطرة", "لا خطر", "نهائي",
].map((w) => normalizeForCompare(w));
export const QUOTE_NAME_MATCH_THRESHOLD = 0.8;

// P2R2-A: the ~200 most common English words. A Latin window containing any of
// them is never treated as a source NAME — sentence-initial "Some"/"There"
// matched short Arabic words («سام»، «ثورة») in the P2R review.
const ENGLISH_COMMON_WORDS = new Set(`
the be to of and a in that have i it for not on with he as you do at this but his by
from they we say her she or an will my one all would there their what so up out if
about who get which go me when make can like time no just him know take people into
year your good some could them see other than then now look only come its over think
also back after use two how our work first well way even new want because any these
give day most us is are was were been has had did does said says may might must shall
should very more such many much each own same both few under while where why through
during before between against again further once here those off down above below until
being having doing very per via whether however since though although still yet ever
never always often also several another every either neither nor upon within without
among across around behind beyond near toward towards onto off out about rare serious
urgent immediate good safe risk warning recall recalls recalled recalling product
products patient patients people health food drug drugs company companies report
reports reported according announced announce today said state states united national
department agency administration consumers consumer customers customer use used using
lot lots batch batches number numbers label labels date dates sold distributed store
stores market markets retail online information contact call please note notice
`.split(/\s+/).filter(Boolean));

type LatinWindow = { variants: SkelTok[][]; len: number };
const latinWindowCache = new Map<string, LatinWindow[]>();

/** A token reads as an acronym / mixed-case name (CD19, CAR, TriNetX, HeFH). */
function isAcronymish(t: string): boolean {
  return (t.match(/[A-Z]/g) ?? []).length >= 2 || (/[A-Z]/.test(t) && /\d/.test(t));
}

/**
 * Latin token windows (1–3 adjacent tokens joined only by space/hyphen/slash)
 * with skeleton variants (each token phonetic or, for an acronym, spelled
 * letter by letter). P2R2-A: a window is kept only when it is a plausible
 * PROPER NAME — no token is a common English word, and it is multi-token, or an
 * acronym/mixed-case token, or a token that appears capitalised in a
 * NON-sentence-initial position somewhere in the text ("published in Nature").
 * `requireName: false` (the draft's own gloss parentheses) skips only the
 * proper-name test, never the common-word test.
 */
function latinWindows(text: string, requireName: boolean): LatinWindow[] {
  const key = `${requireName ? "n" : "g"}\u0000${text ?? ""}`;
  const hit = latinWindowCache.get(key);
  if (hit) return hit;
  const src = text ?? "";
  const toks: { t: string; start: number; end: number }[] = [];
  const re = /[A-Za-z][A-Za-z0-9]*|[0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) toks.push({ t: m[0], start: m.index, end: m.index + m[0].length });
  // Tokens seen capitalised mid-sentence (not at text start / after . ! ? : or a line break).
  const midCaps = new Set<string>();
  for (const tk of toks) {
    if (!/^[A-Z]/.test(tk.t)) continue;
    const before = src.slice(0, tk.start).replace(/[\s"'“”«»(\[]+$/u, "");
    if (before && !/[.!?:؟\n]$/.test(before)) midCaps.add(tk.t);
  }
  const options = (t: string): SkelTok[][] => {
    const seen = new Map<string, SkelTok[]>();
    const put = (sk: SkelTok[]) => {
      if (sk.length) seen.set(sk.map((x) => [...x].sort().join("")).join("|"), sk);
    };
    for (const v of latinVariants(t)) put(v);
    if (/^[A-Z0-9]{1,6}$/.test(t) && /[A-Z]/.test(t)) put(letterNameSkeleton(t));
    return [...seen.values()];
  };
  const common = (t: string) => ENGLISH_COMMON_WORDS.has(t.toLowerCase());
  const out: LatinWindow[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!/^[A-Z0-9]/.test(toks[i].t) || common(toks[i].t)) continue;
    let combos: SkelTok[][] = options(toks[i].t);
    const parts = [toks[i].t];
    for (let k = i; k < Math.min(toks.length, i + 3); k++) {
      if (k > i) {
        if (!/^[\s\-/]*$/.test(src.slice(toks[k - 1].end, toks[k].start))) break;
        if (common(toks[k].t)) break;
        parts.push(toks[k].t);
        const next = options(toks[k].t);
        const merged: SkelTok[][] = [];
        for (const a of combos) for (const b of next) merged.push(collapseSkeleton([...a, ...b]));
        combos = merged.slice(0, 64);
      }
      const name = parts.length >= 2 || parts.some(isAcronymish) || parts.some((p) => midCaps.has(p));
      if ((!requireName || name) && combos.length) {
        out.push({ variants: combos, len: Math.min(...combos.map((c) => c.length)) });
      }
    }
  }
  if (latinWindowCache.size > 32) latinWindowCache.clear();
  latinWindowCache.set(key, out);
  return out;
}

/** The Latin text inside the draft's own gloss parentheses «عربي (Latin)». */
function draftGlossLatin(draftText: string): string {
  return [...(draftText ?? "").matchAll(/\(([^()\n]{1,80})\)/g)]
    .map((m) => m[1])
    .filter((x) => /[A-Za-z]/.test(x))
    .join("\n");
}

/** Is quoted span `q` a transliterated NAME (see above)? P2R2-A: its skeleton
 *  needs ≥3 consonants (under every variant), no claim word, and a ≥0.8 match
 *  against (a) a Latin sequence in the draft's own gloss parentheses, or (b) a
 *  plausible proper-name sequence of the verified source. */
export function isTransliteratedSourceName(q: string, sourceText: string, draftText = ""): boolean {
  if (!/[؀-ۿ]/.test(q ?? "")) return false;
  const qn = normalizeForCompare(q);
  if (QUOTE_CLAIM_LEXICON.some((w) => qn.includes(w))) return false;
  const ar = arabicVariants(q.replace(/[-–]/g, " "));
  if (Math.min(...ar.map((a) => a.length)) < 3) return false;
  const arLen = Math.max(...ar.map((a) => a.length));
  const windows = [...latinWindows(draftGlossLatin(draftText), false), ...latinWindows(sourceText, true)];
  for (const w of windows) {
    if (w.len > arLen * 2 || arLen > w.len * 2) continue;
    if (bestSkeletonRatio(ar, w.variants) >= QUOTE_NAME_MATCH_THRESHOLD) return true;
  }
  return false;
}

/** Extract quotation spans (Arabic «…», ASCII "…", curly “…”). With the
 *  verified `sourceText`, a span that is a transliterated source name is not a
 *  quotation (isTransliteratedSourceName); without it, every span is returned. */
export function extractQuotes(text: string, sourceText?: string): string[] {
  const out: string[] = [];
  const src = text ?? "";
  const patterns = [/«([^»]+)»/g, /"([^"]+)"/g, /\u201C([^\u201D]+)\u201D/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const q = m[1].trim();
      if (!q) continue;
      if (sourceText !== undefined && isTransliteratedSourceName(q, sourceText, src)) continue;
      out.push(q);
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
    // P2-FIX1: transitive imperative/plural ("أوقف/أوقفوا استخدام …").
    /أوقف(?:وا)? (?:الاستخدام|الاستعمال|استخدام|استعمال|تناول)/,
    /stop using/, /discontinue/, /do not use/, /cease use/,
  ] },
  { code: "avoid", patterns: [/تجنب/, /الامتناع عن/, /avoid/, /refrain from/] },
  { code: "return", patterns: [
    /إعادة (?:المنتج|الدواء|المستحضر|العبوة)/, /أعيدوا/, /إرجاع/, /استرجاع/,
    // P2-FIX1 / P2R-3: singular imperative "أعد/أعده/أعدها" counts as a return
    // ONLY with an explicit object in the pattern — the product/stock
    // (المنتج/العبوات/الكميات…) or a return destination (إلى المورد/الصيدلية/
    // مكان الشراء…). A bare «أعدّه»/«أعدها» is the verb "prepared" («تقرير أعدّه
    // فريق»، «دراسة أعدها باحثون») and never an official action.
    /(?:^|[^\p{L}])[وف]?أعد(?:ه|ها|هما)?(?![\p{L}])\s*(?:ال)?(?:منتج|دواء|مستحضر|عبوة|عبوات|كمية|كميات|مخزون)(?![\p{L}])/u,
    /(?:^|[^\p{L}])[وف]?أعد(?:ه|ها|هما)?(?![\p{L}])\s*(?:إلى|الى)\s*(?:ال)?(?:مورد|موزع|صيدلية|صيدلي|شركة|بائع|متجر|مكان الشراء|نقطة الشراء)/u,
    /(?:^|[^\p{L}])[وف]?أعد(?:ه|ها|هما)?(?![\p{L}])\s*(?:(?:إلى|الى)\s*)?مكان الشراء/u,
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
    //
    // P2-FIX2: the bounded object whitelist also names the product FORMS a
    // recall commonly refers to (أقراص/حقن/بخاخ/مستحضرات) and the stock words
    // "غير المستخدم"/"المتبقي" (the unused/remaining product), e.g.
    // «التخلّص من غير المستخدم أو إعادته». Still a closed list — no fuzzy match.
    /التخلص من (?:ال)?(?:منتج|دواء|مستحضر|عبوة|عبوات|كمية|كميات|مخزون|أقراص|حقن|بخاخ|متبقي)/,
    /التخلص من غير المستخدم/,
    /التخلص من الكميات المتأثرة/,
    /التخلص من(?:ه|ها|هما)/,
    /تخلص(?:وا)? من (?:ال)?(?:منتج|دواء|مستحضر|عبوة|عبوات|كمية|كميات|مخزون|أقراص|حقن|بخاخ|متبقي)/,
    /تخلص(?:وا)? من غير المستخدم/,
    /تخلص(?:وا)? من(?:ه|ها|هما)/,
    /إتلاف (?:ال)?(?:منتج|دواء|مستحضر|عبوة|عبوات|كمية|كميات|مخزون|أقراص|حقن|بخاخ|متبقي)/,
    /إتلاف غير المستخدم/,
    /إتلاف الكميات المتأثرة/,
    /إتلاف(?:ه|ها|هما)/,
    /رمي (?:ال)?(?:منتج|دواء|مستحضر|عبوة|أقراص|حقن|بخاخ|متبقي)/,
    /رمي غير المستخدم/,
    /discard/, /dispose of/, /throw (?:it|them|the product|the item)? ?away/,
  ] },
  { code: "check", patterns: [
    /التحقق من/, /تحقق(?:وا)? من/, /افحص(?:وا)?/, /فحص (?:العبوة|المنتج|الرقم)/,
    /check (?:the|your|whether|if|for)/,
  ] },
  { code: "contact", patterns: [
    /التواصل مع/, /الاتصال (?:بـ|ب)/, /تواصلوا/, /راجعوا الجهة/,
    // P2-FIX1: imperative singular/plural source forms ("اتصل/اتصلوا بالشركة",
    // "تواصل/تواصلوا مع", "راجع/راجعوا الشركة/الصيدلية"). A call to the DOCTOR /
    // emergency stays seek_help only, so it never licenses an invented
    // "contact the company" in the article.
    /(?:^|[^\p{L}])[وف]?اتصل(?:وا)? (?:بـ ?|ب)(?!(?:ال)?طبيب|الطوارئ|أقرب|اقرب)/u,
    // P2R-3: «تواصل مع» counts as contact only with an explicit object (the
    // company / regulator / pharmacy / supplier); «تواصل مع الطبيب» is seek_help.
    /(?:^|[^\p{L}])[وف]?تواصل(?:وا)? مع (?:ال)?(?:شركة|هيئة|جهة|صيدلية|صيدلي|مورد|موزع|مصنع)/u,
    /(?:^|[^\p{L}])[وف]?راجع(?:وا)? (?:الجهة|الشركة|الصيدلية|الصيدلي|المورد|الموزع|مكان الشراء)/u,
    /contact (?:the|your|their|a) /, /reach out to/,
  ] },
  { code: "seek_help", patterns: [
    /مراجعة (?:الطبيب|الطوارئ|أقرب)/, /استشارة (?:الطبيب|طبيب|مختص)/,
    /راجع(?:وا)? الطبيب/, /اتصل(?:وا)? بالطبيب/,
    // P2-FIX1: imperative forms aimed at a clinician / emergency care.
    /(?:^|[^\p{L}])[وف]?راجع(?:وا)? (?:طبيب|الطوارئ|أقرب|اقرب)/u,
    /(?:^|[^\p{L}])[وف]?اتصل(?:وا)? (?:بـ ?|ب)(?:طبيب|الطوارئ|أقرب|اقرب)/u,
    /(?:^|[^\p{L}])[وف]?تواصل(?:وا)? مع (?:ال)?طبيب/u,
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

// --- Arabic-first COUNTRY equivalence (narrow, fixed vocabulary) -----------
//
// English country terms extracted into mustPreserve from an English source
// (fetchSourceText.COUNTRY_TERMS) are NOT product/brand identities: demanding
// the literal "Kuwait" inside an Arabic article misclassifies a translation as
// a dropped fact and rejects correct Arabic-first writing. This fixed map lets
// the entity checks accept the canonical Arabic name as full preservation of
// the SAME entity. It is deliberately limited to the exact English terms the
// extractor emits \u2014 drug/product/company names keep the strict verbatim
// Arabic-first gloss contract unchanged, and the country itself remains
// REQUIRED (in either language) with unchanged severity.
const COUNTRY_ARABIC_EQUIVALENTS: Record<string, string[]> = {
  kuwait: ["\u0627\u0644\u0643\u0648\u064A\u062A"],
  saudi: ["\u0627\u0644\u0633\u0639\u0648\u062F\u064A\u0629", "\u0627\u0644\u0633\u0639\u0648\u062F\u064A\u0647"],
  emirates: ["\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062A", "\u0627\u0644\u0627\u0645\u0627\u0631\u0627\u062A"],
  uae: ["\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062A", "\u0627\u0644\u0627\u0645\u0627\u0631\u0627\u062A"],
  qatar: ["\u0642\u0637\u0631"],
  bahrain: ["\u0627\u0644\u0628\u062D\u0631\u064A\u0646"],
  oman: ["\u0639\u0645\u0627\u0646"],
};

/** The accepted Arabic equivalents (normalized) for a known English country
 *  term, keyed by the entity's normalized essential identity; [] otherwise. */
export function arabicCountryEquivalents(idNorm: string): string[] {
  const eqs = COUNTRY_ARABIC_EQUIVALENTS[idNorm];
  return eqs ? eqs.map((e) => normalizeForCompare(e)) : [];
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

// --- P2-A4: transliteration plausibility (name_transliteration_suspect) -----
//
// REVIEW-ONLY signal, never blocking. For a glossed identity «عربي (Latin)» the
// Arabic rendering before the parenthesis is reduced to a CONSONANT skeleton
// and compared with the Latin name's consonant skeleton (longest common
// subsequence over compatible sound classes). A rendering that loses or swaps
// consonants (سكيترا for Spectra — the P is gone) scores low and is flagged for
// a human; a faithful one (سبكترا) scores ~1. The exact Latin identity inside
// the gloss is still what the factual entity check validates — this layer only
// warns that the Arabic spelling may be invented.

// Sound classes. Latin consonants map to one or more classes; each Arabic
// letter maps to the set of Latin classes it can render. Vowels (and the
// Arabic long-vowel/hamza letters) carry no skeleton weight.
const AR_SKELETON: Record<string, string[]> = {
  "ب": ["B", "P"], "پ": ["P"], "ت": ["T"], "ط": ["T"], "ث": ["T", "S"], "ج": ["J", "G"],
  "چ": ["CH"], "ح": ["H"], "خ": ["K", "H"], "د": ["D"], "ض": ["D"], "ذ": ["D", "Z"],
  "ر": ["R"], "ز": ["Z", "S"], "س": ["S", "Z"], "ص": ["S"], "ش": ["SH", "CH", "S"],
  "ظ": ["Z", "D"], "غ": ["G"], "گ": ["G"], "ف": ["F", "V", "P"], "ڤ": ["V", "F"],
  "ق": ["K", "G"], "ك": ["K", "G", "CH"], "ل": ["L"], "م": ["M"], "ن": ["N"], "ه": ["H"],
};
// Arabic letters that are vowels / hamza seats / ignorable for the skeleton.
const AR_SKELETON_SKIP = /[اأإآٱءؤئوىيةعـً-ٰٟ]/;

type SkelTok = Set<string>;

function collapseSkeleton(toks: SkelTok[]): SkelTok[] {
  const out: SkelTok[] = [];
  for (const t of toks) {
    const prev = out[out.length - 1];
    // Collapse only an IDENTICAL adjacent class (a doubled consonant / shadda),
    // never two different letters that merely share a class.
    if (prev && prev.size === t.size && [...t].every((c) => prev.has(c))) continue;
    out.push(new Set(t));
  }
  return out;
}

/** Consonant skeleton of an Arabic word/phrase (vowel letters dropped,
 *  adjacent same-class consonants — shadda/doubling — collapsed). Digit runs
 *  (Arabic-Indic folded) are kept as exact tokens («سي دي 19» ↔ CD19).
 *  P2R-7 variants: `tch` reads «تش» as ONE sound (نيتشر ↔ Nature); `dropFinalH`
 *  treats a word-final ه as silent (نستله ↔ Nestle). */
export function arabicSkeleton(
  word: string,
  opts: { tch?: boolean; dropFinalH?: boolean } = {},
): SkelTok[] {
  const toks: SkelTok[] = [];
  const w = foldDigits(word ?? "");
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    if (/\d/.test(ch)) {
      let j = i;
      while (j + 1 < w.length && /\d/.test(w[j + 1])) j++;
      toks.push(new Set([`#${w.slice(i, j + 1)}`]));
      i = j;
      continue;
    }
    if (AR_SKELETON_SKIP.test(ch)) continue;
    if (opts.tch && ch === "ت" && w[i + 1] === "ش") {
      toks.push(new Set(["T", "CH", "SH"]));
      i++;
      continue;
    }
    if (opts.dropFinalH && ch === "ه" && !/[\u0600-\u06FF]/.test(w[i + 1] ?? "")) continue;
    const cls = AR_SKELETON[ch];
    if (cls) toks.push(new Set(cls));
  }
  return collapseSkeleton(toks);
}

/** Consonant skeleton of a Latin word (digraphs ph/sh/ch/th/kh/gh/ck/qu/pf,
 *  soft c/g before e/i/y, x = k+s, vowels and w/y dropped). Digit runs are
 *  exact tokens. P2R-7 variants: `keepH` keeps every h (Boehringer ↔ بوهرنجر,
 *  whose h Arabic voices); `initialXasZ` reads a word-initial x as ز (Xarelto ↔
 *  زاريلتو) instead of كس. */
export function latinSkeleton(
  word: string,
  opts: { keepH?: boolean; initialXasZ?: boolean } = {},
): SkelTok[] {
  const w = (word ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const toks: SkelTok[] = [];
  const add = (...c: string[]) => toks.push(new Set(c));
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const n = w[i + 1] ?? "";
    if (/\d/.test(c)) {
      let j = i;
      while (j + 1 < w.length && /\d/.test(w[j + 1])) j++;
      add(`#${w.slice(i, j + 1)}`);
      i = j;
      continue;
    }
    const two = c + n;
    if (two === "ph") { add("F"); i++; continue; }
    if (two === "sh") { add("SH"); i++; continue; }
    if (two === "ch") { add("CH", "SH", "K"); i++; continue; }
    if (two === "th") { add("T"); i++; continue; }
    if (two === "kh") { add("K", "H"); i++; continue; }
    if (two === "gh") { add("G"); i++; continue; }
    if (two === "ck") { add("K"); i++; continue; }
    if (two === "qu") { add("K"); i++; continue; }
    if (two === "pf" && i === 0) { add("F"); i++; continue; } // Pfizer: silent p
    if ("aeiouwy".includes(c)) continue;
    // h is voiced only before a vowel (Humira, Hydro); a silent h after a
    // consonant (Rhine), before a consonant (John) or word-final (Sarah) is
    // dropped — unless the keepH variant is being scored.
    if (!opts.keepH && c === "h" && (n === "" || !"aeiouy".includes(n) || (i > 0 && !"aeiou".includes(w[i - 1])))) continue;
    const soft = n !== "" && "eiy".includes(n);
    switch (c) {
      case "b": case "p": add("B", "P"); break;
      case "t": add("T"); break;
      case "d": add("D"); break;
      case "j": add("J"); break;
      case "g": if (soft) add("G", "J"); else add("G"); break;
      case "k": case "q": add("K"); break;
      case "c": if (soft) add("S", "Z"); else add("K"); break;
      case "x":
        if (i === 0 && opts.initialXasZ) add("Z", "S");
        else { add("K"); add("S", "Z"); }
        break;
      case "s": add("S", "Z"); break;
      case "z": add("Z", "S"); break;
      case "f": add("F"); break;
      case "v": add("V", "F"); break;
      case "l": add("L"); break;
      case "m": add("M"); break;
      case "n": add("N"); break;
      case "r": add("R"); break;
      case "h": add("H"); break;
      default: break;
    }
  }
  return collapseSkeleton(toks);
}

// Spelled-out English letter names as Arabic writes them in acronyms
// (CD → «سي دي», T → «تي», X → «إكس»): the consonant skeleton of each name.
const LETTER_NAME_SKELETON: Record<string, string[][]> = {
  a: [], b: [["B", "P"]], c: [["S", "Z"]], d: [["D"]], e: [], f: [["F"]], g: [["J", "G"]],
  h: [["T"], ["SH", "CH"]], i: [], j: [["J", "G"]], k: [["K"]], l: [["L"]], m: [["M"]], n: [["N"]],
  o: [], p: [["B", "P"]], q: [["K"]], r: [["R"]], s: [["S", "Z"]], t: [["T"]], u: [],
  v: [["F", "V"]], w: [["D"], ["B", "P"], ["L"]], x: [["K"], ["S", "Z"]], y: [], z: [["Z", "S"]], 
};

/** Skeleton of an acronym read letter by letter («سي دي 19» for CD19). */
export function letterNameSkeleton(token: string): SkelTok[] {
  const toks: SkelTok[] = [];
  const t = (token ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (/\d/.test(c)) {
      let j = i;
      while (j + 1 < t.length && /\d/.test(t[j + 1])) j++;
      toks.push(new Set([`#${t.slice(i, j + 1)}`]));
      i = j;
      continue;
    }
    for (const cls of LETTER_NAME_SKELETON[c] ?? []) toks.push(new Set(cls));
  }
  return collapseSkeleton(toks);
}

function skeletonLcs(a: SkelTok[], b: SkelTok[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const match = [...a[i - 1]].some((c) => b[j - 1].has(c));
      dp[i][j] = match ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Skeleton similarity in [0,1]: LCS / max(len). Symmetric — a rendering that
 *  drops a consonant (سكيترا vs Spectra) or adds one is penalised. */
export function skeletonSimilarity(arabic: string, latin: string): number {
  return bestSkeletonRatio(arabicVariants(arabic), latinVariants(latin));
}

/** The Arabic skeleton variants scored for a rendering (P2R-7). */
function arabicVariants(arabic: string): SkelTok[][] {
  return [
    arabicSkeleton(arabic),
    arabicSkeleton(arabic, { tch: true }),
    arabicSkeleton(arabic, { dropFinalH: true }),
    arabicSkeleton(arabic, { tch: true, dropFinalH: true }),
  ];
}

/** The Latin skeleton variants scored for a word (P2R-7). */
function latinVariants(latin: string): SkelTok[][] {
  return [
    latinSkeleton(latin),
    latinSkeleton(latin, { keepH: true }),
    latinSkeleton(latin, { initialXasZ: true }),
    latinSkeleton(latin, { keepH: true, initialXasZ: true }),
  ];
}

/** Best LCS / max(len) over every (Arabic, Latin) skeleton variant pair. A
 *  variant only ever reads a letter the way the other script plausibly writes
 *  it, so a genuinely lost/swapped consonant (سكيترا vs Spectra) still scores
 *  low under every variant. */
function bestSkeletonRatio(as: SkelTok[][], ls: SkelTok[][]): number {
  let best = 0;
  for (const a of as) {
    if (!a.length) continue;
    for (const l of ls) {
      if (!l.length) continue;
      best = Math.max(best, skeletonLcs(a, l) / Math.max(a.length, l.length));
    }
  }
  return best;
}

// Final threshold, tuned on the P2 fixture set (see salmaWriter.test.ts "P2-A4"):
// the brief's starting value 0.6 let both known-bad renderings (سكيترا/Spectra
// and إنليكيسايد/enlicitide, each 0.8 — one consonant lost of five) through, so
// it was raised. Every one of the 20 correct fixture pairs scores 1.0.
export const TRANSLITERATION_SUSPECT_THRESHOLD = 0.85;

// Latin words that are normally TRANSLATED, not transliterated (descriptors,
// institution words, nationality adjectives). They are excluded from scoring so
// «جامعة هارفارد (Harvard University)» is judged on "Harvard" alone.
const TRANSLATED_LATIN_WORDS = new Set([
  "the", "of", "and", "for", "in", "on", "at", "a", "an", "us", "u", "s", "uk",
  "university", "hospital", "hospitals", "health", "healthcare", "food", "drug", "drugs",
  "administration", "organization", "organisation", "ministry", "center", "centre",
  "centers", "centres", "institute", "institutes", "national", "international", "world",
  "company", "co", "pharmaceuticals", "pharmaceutical", "pharma", "medical", "medicine",
  "medicines", "laboratories", "laboratory", "labs", "foundation", "association", "society",
  "college", "school", "agency", "authority", "department", "council", "clinic", "clinics",
  "research", "cancer", "heart", "disease", "diseases", "control", "prevention", "services",
  "service", "human", "public", "general", "group", "holdings", "global", "sciences",
  "science", "biotech", "therapeutics", "european", "union", "federal", "state", "royal",
  "children", "childrens", "women", "care", "system", "network", "trust", "board",
  "commission", "office", "bureau", "corporation", "inc", "ltd", "llc", "plc", "gmbh", "sa",
  "ag", "nv", "american", "british", "french", "german", "japanese", "swiss", "canadian",
  "chinese", "indian", "korean", "saudi", "kuwaiti", "emirati", "arab", "arabian", "gulf",
  "middle", "east", "australian", "danish", "swedish", "dutch", "italian", "spanish",
  "hydrochloride", "sodium", "potassium", "calcium", "injection", "tablets", "tablet",
  "capsules", "capsule", "solution", "suspension", "usp", "bp", "ndc", "lot",
]);

/** The Arabic text immediately before the `(` that opens a gloss at
 *  `parenIdx` (up to ~40 chars, stopping at punctuation / a line break). */
export function arabicRenderingWindow(text: string, parenIdx: number): string {
  const before = (text ?? "").slice(Math.max(0, parenIdx - 40), parenIdx);
  const cut = before.split(/[.,،؛:!?؟«»"()\[\]\n“”]/);
  return (cut[cut.length - 1] ?? "").trim();
}

/** Strip a leading definite article / article-bearing proclitic for scoring. */
function stripArticle(w: string): string {
  const m = w.match(/^(?:[وف]?[بك]?ال|[وف]?لل)(.{2,})$/u);
  return m ? m[1] : w;
}

/**
 * Score an Arabic rendering window against a Latin identity: each scorable
 * Latin word is matched to its best Arabic word (or a run of up to three
 * adjacent Arabic words, for «أسترا زينيكا»), weighted by the Latin word's skeleton length. Returns
 * null when nothing is scorable (acronyms, translated-only names). The chosen
 * Arabic words (in window order) are returned as the rendering.
 */
export function transliterationScore(
  window: string,
  latinIdentity: string,
  opts: { namesOnly?: boolean } = {},
): { score: number; rendering: string } | null {
  const identity = (latinIdentity ?? "").trim();
  // An all-caps acronym (FDA, WHO, NHS) is translated, never transliterated.
  if (/^[A-Z0-9.&\s-]{2,8}$/.test(identity)) return null;
  const arWords = (window ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[^؀-ۿ]/g, ""))
    .filter(Boolean);
  if (!arWords.length) return null;
  const candidates: { text: string; idx: number[] }[] = [];
  arWords.forEach((w, i) => {
    let text = "";
    const idx: number[] = [];
    for (let k = i; k < Math.min(arWords.length, i + 3); k++) {
      text += stripArticle(arWords[k]);
      idx.push(k);
      candidates.push({ text, idx: [...idx] });
    }
  });
  let totalWeight = 0;
  let total = 0;
  const used = new Set<number>();
  for (const lw of identity.split(/[\s\-/]+/)) {
    const lower = lw.toLowerCase().replace(/[^a-z]/g, "");
    if (!lower || TRANSLATED_LATIN_WORDS.has(lower)) continue;
    // An acronym word (SGLT2, CD19, HeFH, GLP-1) is spelled, not transliterated.
    if (isAcronymGloss(lw)) continue;
    // P2R-7a: in a self-identified gloss pair only proper-name words count —
    // a capitalised word or an INN-style drug name; a lowercase common noun
    // («مثبطات (inhibitors)») is a translation.
    if (opts.namesOnly && !/^[A-Z]/.test(lw) && !DRUG_NAME_SUFFIX_RE.test(lower)) continue;
    const skel = latinSkeleton(lower);
    if (skel.length < 2) continue;
    let best = 0;
    let bestIdx: number[] = [];
    for (const c of candidates) {
      const s = skeletonSimilarity(c.text, lower);
      if (s > best || (s === best && c.idx.length < bestIdx.length)) {
        best = s;
        bestIdx = c.idx;
      }
    }
    for (const i of bestIdx) used.add(i);
    totalWeight += skel.length;
    total += best * skel.length;
  }
  if (totalWeight === 0) return null;
  const rendering = arWords.filter((_, i) => used.has(i)).join(" ");
  return { score: total / totalWeight, rendering };
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
  // P2-A4: the Arabic rendering immediately before the first-mention gloss and
  // its skeleton score vs the Latin identity (null when not glossed / not
  // scorable). `transliterationSuspect` is a REVIEW signal only — it never
  // changes `status`.
  arabicRendering?: string | null;
  transliterationScore?: number | null;
  transliterationSuspect?: boolean;
};

// P2R-7a: INN-style drug-name endings — a single lowercase parenthetical with
// one of these is a drug name («إنليكيسايد (enlicitide)»), not a translated
// common noun («التهاب الكبد (hepatitis)»), so it is scored too.
const DRUG_NAME_SUFFIX_RE =
  /(?:mab|tide|nib|pril|sartan|olol|azole|cillin|mycin|floxacin|vir|statin|gliflozin|glutide|gliptin|parin|pron|cept|lukast|dronate|setron|triptan)$/;

/**
 * P2R-7a: EVERY Arabic-rendering + «(Latin)» gloss pair in a text, scored
 * against its OWN parenthetical (the pair is self-identifying — no entity list
 * needed). A parenthetical is a name when it carries a capitalised word that is
 * not a normally-translated word, or is a single lowercase INN-style drug name;
 * translations of common nouns, acronyms and descriptor-only glosses are not
 * scored (transliterationScore returns null). Returns the suspect pairs.
 */
/** P2R2-E: a pure acronym / abbreviation (≥2 capitals, more capitals than
 *  lowercase, ≤6 letters+digits: HeFH, GLP-1, LDL, SGLT2). A gloss whose Latin
 *  side is one is an abbreviation expansion, never a transliteration. */
export function isAcronymGloss(latin: string): boolean {
  const core = (latin ?? "").replace(/[^A-Za-z0-9]/g, "");
  const up = (core.match(/[A-Z]/g) ?? []).length;
  const low = (core.match(/[a-z]/g) ?? []).length;
  return core.length >= 2 && core.length <= 6 && up >= 2 && up > low;
}

export function suspectGlossPairs(text: string): { latin: string; rendering: string; score: number }[] {
  const t = text ?? "";
  const out: { latin: string; rendering: string; score: number }[] = [];
  const re = /\(([^()\n]{2,80})\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const latin = m[1].trim();
    if (!/[A-Za-z]/.test(latin) || /[\u0600-\u06FF]/.test(latin)) continue;
    if (isAcronymGloss(latin)) continue; // P2R2-E
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(t[i])) i--;
    if (i < 0 || !/[\u0600-\u06FF]/.test(t[i])) continue;
    const words = latin.split(/[\s,]+/).filter(Boolean);
    const named = words.some(
      (w) =>
        /^[A-Z][a-z]/.test(w) && !TRANSLATED_LATIN_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")),
    );
    const drug = words.length === 1 && /^[a-z]+$/.test(words[0]) && DRUG_NAME_SUFFIX_RE.test(words[0]);
    if (!named && !drug) continue;
    const sc = transliterationScore(arabicRenderingWindow(t, i + 1), latin, { namesOnly: true });
    if (sc && sc.score < TRANSLITERATION_SUSPECT_THRESHOLD) out.push({ latin, rendering: sc.rendering, score: sc.score });
  }
  return out;
}

/** P2-A4/A5: the Arabic rendering (and its score) of the first glossed
 *  occurrence of `entity` in `visible`, or null when it is not glossed. */
export function glossedRendering(
  visible: string,
  entity: string,
): { rendering: string; score: number } | null {
  const identity = stripFormalSuffixes(entity);
  const occ = findIdentityOccurrences(visible ?? "", identity);
  const first = occ.find((o) => o.isGloss);
  if (!first) return null;
  let i = first.index - 1;
  while (i >= 0 && /\s/.test(visible[i])) i--;
  const win = arabicRenderingWindow(visible, i);
  const s = transliterationScore(win, identity);
  return s ? { rendering: s.rendering, score: s.score } : null;
}

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
  const g = firstMentionGloss ? glossedRendering(input.visible ?? "", input.entity) : null;
  return {
    status: clean ? "ok" : "flagged",
    present: true,
    firstMentionGloss,
    englishFirst,
    englishInTitle,
    englishRepeated,
    arabicRendering: g ? g.rendering : null,
    transliterationScore: g ? g.score : null,
    transliterationSuspect: g ? g.score < TRANSLITERATION_SUSPECT_THRESHOLD : false,
  };
}

/** P2R2-F: a paired "X dba Y" entity (fetchSourceText stores "X, doing
 *  business as Y" as ONE entity) → its two names, either of which satisfies
 *  presence; null for an ordinary entity. */
export function dbaAliases(entity: string): [string, string] | null {
  const m = (entity ?? "").match(/^(.+?) dba (.+)$/);
  return m ? [m[1].trim(), m[2].trim()] : null;
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
  // P2-A1: dates are grounded as DATES. A number that is a component of a draft
  // date which FULLY matches a source date (month-name ↔ numeric, padding,
  // d/m order) is validated by that match and not re-checked as a bare number
  // (so «7 أكتوبر 2026» against a source "07/10/2026" — or the reverse — is not
  // a false unsupported_number). Every other number keeps the strict check.
  const dateCheck = unsupportedDates(generated, source.sourceText, srcNumbers);
  const groundedDateSpans = dateCheck.supported.map((t) => [t.start, t.end] as const);
  const inGroundedDate = (start: number, end: number) =>
    groundedDateSpans.some(([a, b]) => start >= a && end <= b);
  const unsupportedNumberSpans: [number, number][] = [];
  for (const entry of scanNumberEntries(generated, "en")) {
    if (inGroundedDate(entry.start, entry.end)) continue;
    if (entry.value === null || !srcNumbers.has(entry.value)) {
      errors.push(`unsupported_number:${entry.raw}`);
      unsupportedNumberSpans.push([entry.start, entry.end]);
      logNumberDiagnostic({
        token: entry.raw,
        tokenValue: entry.value,
        sourceValues: [...srcNumbers],
        sourceLang: source.sourceLang ?? null,
        locale: sourceLocale,
      });
    }
  }
  // An unsupported DATE whose own numbers all exist in the source (wrong
  // day/month combination, e.g. a changed "as of" date) is a blocking
  // unsupported_date. When one of its numbers is already reported as
  // unsupported_number the breach is already blocking — no double report.
  for (const tok of dateCheck.unsupported) {
    const alreadyReported = unsupportedNumberSpans.some(([a, b]) => a >= tok.start && b <= tok.end);
    if (!alreadyReported) errors.push(`unsupported_date:${tok.raw}`);
  }

  // 2) No invented quotations — a quoted span must appear in the source.
  for (const q of extractQuotes(article.body, source.sourceText)) {
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
  const identifierNeeded = safetyIdentifierNeeded(source.sourceText);
  for (const ent of source.mustPreserve ?? []) {
    const vis = classifyEntityVisibility(ent, profile, source.sourceText);
    if (vis === "verification_only") continue;
    if (vis === "conditional" && !identifierNeeded) continue;

    // P2R2-F: a "X dba Y" pair is preserved by EITHER name (same severity when
    // neither appears). Each name is judged by the ordinary presence rules.
    const aliases = dbaAliases(ent);
    if (aliases) {
      const visible = `${article.excerpt}\n${article.body}`;
      const present = aliases.some((a) =>
        /[A-Za-z]/.test(a)
          ? foreignEssentialNameStatus({ title: article.title, visible, entity: a }).present
          : arabicEntityPresent(a, generated)
      );
      if (!present) {
        if (profile === "safety_alert") errors.push(`missing_essential_entity:${ent}`);
        else warnings.push(`missing_essential_entity:${ent}`);
      }
      continue;
    }

    // The essential identity (formal/regulatory suffixes removed) is what must
    // survive — never a shortened or altered form. A FOREIGN essential name is
    // held to the Arabic-first naming contract (exact original once, inside a
    // first-mention gloss, Arabic-only title, no English repetition); a native
    // Arabic essential name keeps the plain presence check.
    const identity = stripFormalSuffixes(ent);
    const idNorm = normalizeForCompare(identity);
    if (!idNorm) continue;
    const foreign = /[a-z]/.test(idNorm);

    // Known English COUNTRY terms are exempt from the foreign-name gloss
    // contract: the canonical Arabic name preserves the same entity fully
    // (Arabic-first is the house style, not a fact change). The entity is
    // still REQUIRED — absent in BOTH languages keeps the unchanged
    // blocking/warning severity below.
    const countryEqs = arabicCountryEquivalents(idNorm);
    if (countryEqs.length > 0) {
      // P2-B8: Arabic-aware (folded token) match, so «سعودي»/«السعودية» both
      // preserve "Saudi" — still REQUIRED in one language or the other.
      const present =
        arabicEntityPresent(identity, generated) ||
        COUNTRY_ARABIC_EQUIVALENTS[idNorm].some((eq) => arabicEntityPresent(eq, generated));
      if (!present) {
        if (profile === "safety_alert") errors.push(`missing_essential_entity:${ent}`);
        else warnings.push(`missing_essential_entity:${ent}`);
      }
      continue;
    }

    // P2-B8: a known REGULATOR (FDA/WHO/EMA/SFDA/CDC) is preserved by any
    // member of its fixed equivalence group («إدارة الغذاء والدواء» for FDA) —
    // the same narrow treatment as countries; still REQUIRED, same severity.
    const regGroup = regulatorGroup(identity);
    if (regGroup) {
      if (!regulatorPresent(regGroup, generated)) {
        if (profile === "safety_alert") errors.push(`missing_essential_entity:${ent}`);
        else warnings.push(`missing_essential_entity:${ent}`);
      }
      continue;
    }

    if (!foreign) {
      if (!arabicEntityPresent(identity, generated)) {
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
    // P2-A4: the Arabic rendering before the gloss does not plausibly spell the
    // Latin identity (review-only; the exact Latin identity is still verified).
    if (rep.transliterationSuspect) warnings.push(`name_transliteration_suspect:${ent}`);
  }
  // P2R-7a: every other gloss pair in the visible story, self-identified.
  for (const g of suspectGlossPairs(`${article.excerpt}\n${article.body}`)) {
    if (!warnings.some((w) => w.startsWith("name_transliteration_suspect:") && normalizeForCompare(w).includes(normalizeForCompare(g.latin)))) {
      warnings.push(`name_transliteration_suspect:${g.latin}`);
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

// --- Readability heuristics (Editorial Simplification V1) -------------------
//
// Small deterministic ADVISORY warnings, never errors and never a score:
// unusually long sentences, dense paragraphs, unexplained Latin
// abbreviations, and formulaic AI filler phrases. They surface in
// validateArticle.warnings (persisted on Develop Story jobs) so editors see
// WHY a draft reads heavy — factual validation is untouched.

export const AI_TELL_PHRASES = [
  "من المهم الإشارة",
  "تجدر الإشارة",
  "في هذا السياق",
  "من جهة أخرى",
  "ليس مجرد",
] as const;

/** Headline cues stronger than evidence usually supports (advisory). */
export const HEADLINE_OVERSTATEMENT_CUES = [
  "تحل محل", "تحلّ محل", "يحل محل", "يحلّ محل",
  "يقضي على", "تقضي على", "نهاية عصر", "علاج نهائي", "يغني عن", "تغني عن", "ثورة",
] as const;

const READABILITY_LONG_SENTENCE_WORDS = 45;
const READABILITY_DENSE_PARAGRAPH_WORDS = 95;
const ABBR_RE = /\b[A-Z][A-Z0-9]{1,6}\b/g;
const ABBR_EXPLAIN_RE = /(وهو|وهي|أي |يعني|اختصار|إنزيم|بروتين|جين|مؤشر)/;

export function readabilityWarnings(article: {
  title: string;
  excerpt: string;
  body: string;
}): string[] {
  const out: string[] = [];
  const body = article.body ?? "";

  // 1) Long multi-clause sentences.
  const sentences = body.split(/[.!؟?؛:]\s/);
  const longCount = sentences.filter((s) => countWords(s) > READABILITY_LONG_SENTENCE_WORDS).length;
  if (longCount >= 2) out.push(`readability_long_sentences:${longCount}`);

  // 2) Dense paragraphs (visual text blocks).
  const paragraphs = body.split(/\n\s*\n/);
  const dense = paragraphs.filter((p) => countWords(p) > READABILITY_DENSE_PARAGRAPH_WORDS).length;
  if (dense >= 1) out.push(`readability_dense_paragraphs:${dense}`);

  // 3) Unexplained Latin abbreviations: first occurrence neither inside an
  //    Arabic-first gloss nor followed by a nearby plain-language explainer.
  const visible = `${article.excerpt ?? ""}\n${body}`;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(ABBR_RE.source, "g");
  while ((m = re.exec(visible)) !== null) {
    const abbr = m[0];
    if (seen.has(abbr) || abbr.length < 2) continue;
    seen.add(abbr);
    const before = visible.slice(Math.max(0, m.index - 2), m.index);
    const after = visible.slice(m.index + abbr.length, m.index + abbr.length + 120);
    const inGloss = before.includes("(");
    if (!inGloss && !ABBR_EXPLAIN_RE.test(after)) {
      out.push(`readability_unexplained_abbreviation:${abbr}`);
      if (out.filter((w) => w.startsWith("readability_unexplained")).length >= 3) break;
    }
  }

  // 4) Formulaic AI filler phrases (flag when repeated or stacked).
  const tells = AI_TELL_PHRASES.filter((p) => visible.includes(p));
  if (tells.length >= 2) out.push(`readability_ai_phrases:${tells.length}`);

  // 5) Headline stronger than typical evidence (advisory nudge; the editor
  //    gate carries the same check so the Editorial Director can retitle).
  if (HEADLINE_OVERSTATEMENT_CUES.some((c) => (article.title ?? "").includes(c))) {
    out.push("readability_headline_overstatement");
  }
  return out;
}

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

    // Editorial Simplification V1: advisory readability nudges (never errors).
    warnings.push(
      ...readabilityWarnings({ title: head.cleanTitle, excerpt: article.excerpt ?? "", body }),
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
//
// e2.0 unified editorial standard (see docs/editorial/STYLE_RUBRIC.md): lead
// with the news, simple natural MSA, no filler/boilerplate, extract (don't
// paraphrase) the source, length follows significance (NO numeric word targets
// for the article), full factual/medical fidelity with explicit lab/animal/human
// distinctions, no generalization, every sentence earns its place. The
// fidelity, no-invention, banned-phrase, indicator-vs-outcome, regulatory and
// Arabic-first naming rules are unchanged in strength — the deterministic
// guards that check them are unchanged in this phase.
//
// e2.1 (prompt text only): an explicit must-keep list that simplification may
// never cut (safety warnings, higher-risk and not-at-risk groups, official
// actions, material limitations, key comparisons, product use in recalls), and
// "intelligent compression" (long lists → count/top items, primary + at most
// 2–3 secondary outcomes, explain drug classes instead of naming them,
// attributed forecasts). Goal: maximum useful information for minimum reading
// effort — NOT a word target. Leads open with the event, never the monitoring
// or announcing body. Validators/guards unchanged.
// e2.1.1: list compression uses a count only when the source states it
// (unsupported_number guard); «» reserved for real quotations (quote guard).
// e2.2 (P2 §Names policy — the only prompt change in Phase 2): transliterate
// only well-established/unambiguous names, otherwise keep the Latin name with
// an Arabic descriptor (never invent a spelling); keep "X doing business as Y"
// direction; keep recall severity class and the "as of DATE" on injury counts;
// lot/batch = دفعة/تشغيلة, never عبوة; never write «لم يذكر المصدر…» — omit;
// a title uses a generic Arabic descriptor when a name can't be rendered safely.

const STANDARD_NEWS_INSTRUCTIONS =
  "خبر صحي: ابدأ بما حدث ولماذا يهمّ القارئ، ثم أضف ما يلزم لفهمه فقط: ما الذي تغيّر ومن المتأثّر. لا تُضِف سياقاً إلا إذا كان القارئ لا يفهم الخبر بدونه، ولا تُقحم فقرة «لماذا يهمّ؟» منفصلة إذا كانت الأهمية واضحة من المقدّمة.";

const PROFILE_INSTRUCTIONS: Record<WritingProfile, string> = {
  // Retired profile (back-compat only): writes exactly like standard_news.
  quick_news: STANDARD_NEWS_INSTRUCTIONS,
  standard_news: STANDARD_NEWS_INSTRUCTIONS,
  regulation_or_service:
    "قرار وزاري / لائحة / خدمة رقمية / أهلية أو وصول: ابدأ بما تغيّر وما يعنيه للقارئ. واذكر متى توفّرت وكانت مهمّة للقارئ: موعد البدء، والفئة المشمولة، وما يحتاج القارئ لفعله، والرسوم أو المهلة أو شروط الأهلية، والجهة الرسمية التي جاءت منها التفاصيل. اشرح بعربية واضحة بدل النصّ القانوني، وتجنّب تماماً عبارات المديح أو الدعاية المؤسسية.",
  safety_alert:
    "تحذير سلامة (دواء/جهاز/غذاء/منتج/صحة عامة): ابدأ بالتحذير نفسه وما الذي يتعلّق به، واذكر دائماً هوية المنتج المتأثّر، ووضّح في سطر واحد استخدام المنتج كما يذكره المصدر حتى يعرف القارئ هل يعنيه. واذكر متى توفّرت في المصدر وكانت مهمّة للقارئ: الفئات الأكثر عرضة للخطر، ومن لا يشمله الخطر أو مستوى الخطر على عامة الناس، والدفعة أو الفئة أو المكان المتأثّر، وما الذي لا يزال غير مؤكّد، وهل سُجّلت إصابات أو آثار جانبية. ولا تُسقط أبداً الإجراء الذي طلبته الجهة الرسمية صراحةً ولا أهمّ خطر مؤكّد بلغة مفهومة، وإذا ذكر المصدر أن دفعات أو منتجات أخرى غير متأثّرة فأبقِ هذا التوضيح. لا تخترع نصائح طبية تتجاوز المصدر الرسمي.",
  research_study:
    "دراسة علمية: ابدأ بالنتيجة الأساسية ومعناها بلغة القارئ. واذكر عند توفّرها وأهميتها: ما درسه الباحثون، ونوع الدراسة، وحجم العيّنة أو فئتها، وأهمّ حدودها، وهل تغيّر الممارسة أم أنها أوّلية. صرّح دائماً بما إذا كانت النتيجة من تجارب مخبرية أو على حيوانات أو على بشر. لا تصف الارتباط على أنه سببية، ولا تبالغ في الدراسات المخبرية أو على الحيوان أو الرصدية أو المبكّرة.",
};

/**
 * Build the Arabic writing instructions for a profile. This is the writer
 * prompt (prompt version e2.2-salma-writer). It is intentionally distinct from
 * the discovery/selection prompt in index.ts. `body` must be plain Arabic
 * paragraphs separated by blank lines (the frontend renders paragraphs only —
 * no Markdown/HTML).
 */
export function buildWritingInstructions(profile: WritingProfile): string {
  const bannedList = BANNED_PROMO_PHRASES.map((p) => `«${p}»`).join("، ");
  return `أنت محرّر صحي في منصة "سلمى". حوّل المادة المصدرية المُتحقَّق منها إلى خبر صحي عربي واضح وموجز وموثوق يصل إلى جوهر الخبر من الجملة الأولى. (إصدار التعليمات: ${WRITER_PROMPT_VERSION})

نوع الكتابة المطلوب:
${PROFILE_INSTRUCTIONS[profile]}

القاعدة الأولى: كل جملة يجب أن تستحقّ مكانها. إذا لم تُضِف الجملة معلومة يحتاجها القارئ ليفهم الخبر أو يتصرّف بناءً عليه، فاحذفها.

أسلوب سلمى:
- عربية فصحى حديثة بسيطة وطبيعية وأنيقة، هادئة وموثوقة، مناسبة للكويت والخليج دون لهجة، ومفهومة لغير المتخصّص. اكتب كصحفي لا كناسخٍ لبيان رسمي، وابتعد عن اللغة المراسمية أو التنظيمية أو الدعائية.
- استخلص المعلومة الأساسية ولا تُعِد صياغة المصدر جملةً جملة: حدّد ما يحتاج القارئ أن يعرفه، ثم اكتبه بلغتك.
- تجنّب: نسخ عنوان المصدر، وذكر اسم المصدر في العنوان، والإثارة، والوعود المبالغ فيها، والمقدّمات غير الضرورية، وتكرار الشرح نفسه بصيغ مختلفة، والتفاصيل التقنية الزائدة عن حاجة القارئ، والخاتمات المصطنعة أو المكرّرة، والاقتباسات المختلقة، والنصائح أو التأويلات غير المدعومة.
- عبارات ممنوعة صراحةً: ${bannedList}.

ابدأ بالخبر:
- الجملة الأولى تحمل الخبر أو الخلاصة الأهم مباشرة: ماذا حدث أو ماذا وجد الباحثون، ومعه لماذا يهمّ حين يأتي ذلك طبيعياً — لا خلفيات ولا تمهيد قبل الخبر، ولا افتتاح بالجهة التي ترصد الحدث أو تتابعه أو تعلنه («تتابع الوزارة…»، «يراقب المركز…»، «أعلنت»، «كشفت»، «وفقاً للبيان») إلا إذا كانت هوية الجهة نفسها هي الخبر؛ افتح بالحدث ثم انسبه إلى الجهة.
- لا قالب ثابت للفقرات: رتّب ما بعد المقدّمة بحسب أهميته للقارئ. واجعل الأهمية عملية لا إنشائية: «أهمية الدواء أنه يضيف لأول مرة خياراً فموياً إلى فئة كانت تعتمد على الحقن» بدل «ما يجعل هذا الاعتماد مهماً ليس مجرد إضافة دواء جديد».

لغة القارئ أولاً (تبسيط دون تسطيح — بسيط لا يعني سطحياً):
- اكتب لقارئ ذكي غير متخصّص: لا يحتاج معرفة طبية أو إحصائية ليفهم المقال كاملاً.
- جملة واحدة لفكرة رئيسية واحدة. تجنّب الجمل متعدّدة التراكيب الطويلة، وقسّم الجملة التي تتجاوز نحو أربعين كلمة. الفقرة من جملتين إلى أربع جمل، ولا تجعلها كتلة نصية كثيفة.
- اشرح أولاً وسمِّ ثانياً: قدّم المعنى البسيط قبل المصطلح، وضع المصطلح الرسمي بعده أو بين قوسين عند الحاجة فقط. مثال: بدل «تجربتان عشوائيتان مزدوجتا التعمية ومضبوطتان بعلاج وهمي» اكتب «تجربتان سريريتان قارنتا الدواء بعلاج وهمي بطريقة تقلّل احتمالات التحيّز».
- المصطلحات ثلاثة أنواع: ضروري (أبقه واشرحه ببساطة، مثل PCSK9 مع تعريف قصير)، وقابل للاستبدال (استخدم بديله العربي البسيط)، وغير ضروري (احذفه إذا كان دقّةً بلا فائدة للقارئ). وإن كان المصطلح العلمي الثانوي (بروتين أو جين أو مسار حيوي) لا يلزم القارئ ليفهم الخبر، فاشرح وظيفته دون أن تسمّيه — وهذا لا ينطبق على أسماء الأدوية والمنتجات والشركات والجهات الأساسية. أبقِ المصطلحات الأجنبية عند أضيق حدّ.
- الأرقام: أبقِ ما يغيّر الفهم فعلاً واشرح معناه — «خفض الكوليسترول الضار بمتوسط 56% مقارنة بالعلاج الوهمي خلال 24 أسبوعاً» أوضح من «خفض بنسبة 56%». لا تكدّس إحصاءات ثانوية.
- فرّق بين المؤشر والنتيجة بلغة القارئ: «خفض الكوليسترول لا يعني تلقائياً أن الدراسة أظهرت انخفاض الجلطات أو السكتات على المدى الطويل» أوضح من «لا يثبت نتيجةً سريريةً نهائية».
- اللغة التنظيمية: لكل دولة أدلتها — لا تدمج موافقات جهات مختلفة في حكم واحد إذا اختلفت قوة الدليل المتاح لكل منها، وميّز بين إعلان الموافقة ووثيقة الجهة نفسها وتقرير إعلامي عنها.
- مصدرك قد يكون مكتوباً بلغة تقنية أو تنظيمية — انقل الحقيقة نفسها بلغة صحفية بسيطة، لا تنسخ أسلوب المصدر.
- قوة ادّعاء العنوان لا تتجاوز أقوى ادّعاء مدعوم في النص: تجنّب صيغ الإحلال والحسم مثل «تحل محل» و«يقضي على» و«نهاية عصر» ما لم تدعمها الأدلة فعلاً؛ فضّل «يضيف خياراً فموياً» أو «أول علاج فموي من فئة…».
- تجنّب عبارات الحشو الآلية إلا لضرورة حقيقية: «من المهم الإشارة إلى»، «تجدر الإشارة»، «في هذا السياق»، «من جهة أخرى»، وتكرار «ليس فقط… بل…». وتجنّب البنى المتناظرة المتكررة بين الفقرات.

الأمانة العلمية والطبية (لا تنازل عنها):
- ميّز دائماً وبصراحة بين نتائج التجارب المخبرية والتجارب على الحيوانات والدراسات على البشر. نتيجة على الخلايا أو الفئران لا تُكتب كأنها ثبتت لدى الإنسان؛ وإذا كانت الأدلة مخبرية أو حيوانية فقط فاذكر ذلك، وأن فعاليتها لدى البشر لم تُختبر أو لم تثبت بعد.
- لا تعمّم نتيجة محدّدة إلى ادّعاء طبي أوسع: ما وُجد لدى فئة بعينها أو بجرعة أو مرحلة مرض أو مؤشر محدّد يبقى محصوراً فيه، ولا يتحوّل إلى حكم عام على المرض أو العلاج أو الغذاء.
- اختر أفعالاً تطابق قوة الدليل («تشير»، «قد يساعد»، «ارتبط بـ»)، ولا تحوّل الاحتمال إلى يقين.
- أبقِ كل قيد أو شكّ يغيّر ما يجب أن يستنتجه القارئ أو يفعله، بلغة بسيطة ودون كتل تحذيرية أكاديمية، ولا تجعل كل قيد بنفس الأهمية.
- لا تُضِف سياقاً أو خلفية أو تفسيراً غير وارد في المصدر، ولا ادّعاءً لا تدعمه المادة.

الهدف: أكبر قدر من المعلومة المفيدة بأقلّ جهد قراءة. هذا ليس هدفاً لعدد الكلمات: لا تحذف أبداً حقيقة يحتاجها القارئ ليفهم الخبر بدقّة أو يفسّره تفسيراً آمناً.

ما لا يُحذف عند التبسيط أو الاختصار (لكل خبر، وبصرامة أكبر في تحذيرات السلامة وأخبار تفشّي الأمراض) — متى ورد في المصدر:
- تحذيرات السلامة.
- الفئات الأكثر عرضة للخطر.
- من لا يشمله الخطر، أو مستوى الخطر على عامة الناس، حين يذكره المصدر.
- الإجراءات التنظيمية والرسمية.
- القيود وعدم اليقين التي تغيّر ما يستنتجه القارئ أو يفعله.
- المقارنات المهمّة (بالعلاج الوهمي أو بالعلاج المعتاد أو بفترة سابقة).
- في سحب المنتجات وتنبيهاتها: سطر واحد يوضّح استخدام المنتج حتى يعرف القارئ هل يعنيه.
الاختصار يكون في: الشروح التقنية غير اللازمة، والصياغات المكرّرة، والحشو، والتفاصيل قليلة القيمة — لا في القائمة أعلاه.

الضغط الذكي:
- القائمة التي تزيد على ثلاثة عناصر اختصرها بصيغة غير رقمية («في عدة مناطق»، «في عدد من المستشفيات أبرزها…») أو بالإبقاء على أهمّ عناصرها، إلا إذا كان كل عنصر فيها يحتاجه القارئ بحدّ ذاته ليتصرّف أو ليعرف هل يعنيه الخبر (مثل المنتجات المتأثّرة في تحذير سلامة). استخدم عدداً دقيقاً فقط إذا ذكر المصدر هذا العدد نفسه نصاً، ولا تعدّ عناصر القائمة بنفسك: لا تذكر عدداً غير وارد نصاً في المصدر. ودون إسقاط اسم هو جزء من هوية الخبر نفسه.
- الدراسات: أبقِ النتيجة الأساسية ومعها نتيجتان أو ثلاث نتائج ثانوية على الأكثر — تلك التي تغيّر فهم القارئ أو قراره — واترك بقية النتائج الثانوية.
- فئات الأدوية وآليات عملها: اشرحها بلغة القارئ («دواء يخفض…») بدل تسميتها حين لا يضيف الاسم العلمي للقارئ شيئاً. هذا لا يغيّر قاعدة الأسماء الأجنبية أدناه: اسم الدواء أو المنتج الأساسي يُكتب بالعربية ثم بأصله الدقيق بين قوسين مرّة واحدة.
- التوقّعات والتقديرات تبقى منسوبة إلى أصحابها («يتوقع محللون»، «تقدّر الجهة») ولا تُكتب كأنها حقيقة واقعة.

الطول بحسب أهمية الخبر:
- لا يوجد عدد كلمات مستهدف. الخبر الروتيني تكفيه فقرات قليلة قصيرة؛ والقصة الكبيرة أو المعقّدة تأخذ ما تحتاجه مادتها فعلاً — ولا أطول من ذلك.
- انتهِ حين تنتهي المعلومة. اختم بأسلوب «ما ننتظره الآن» (ما الذي سيحدث لاحقاً أو ما البيانات الناقصة) فقط إذا ذكر المصدر أمراً محدّداً منتظراً فعلاً؛ وإلا فلا خاتمة مصطنعة ولا تلخيص لما سبق.

أمثلة أسلوبية (للنبرة والبنية فقط — ليست حقائق مُتحقَّقاً منها ولا مصدراً لأي معلومة، فلا تنقل منها أي ادّعاء):
- المقدّمة التي تحمل الخبر وتشرح بدل أن تسمّي: «تشير مراجعة علمية جديدة إلى أن تراكم البروتينات المرتبطة بمرض ألزهايمر قد لا يكون بسبب زيادة إنتاجها فقط، بل أيضاً بسبب ضعف قدرة الدماغ على التخلص منها.» ثم «وتركز المراجعة على بروتين يساعد الدماغ على التخلص من هذه المواد…» دون ذكر اسمه العلمي.
- التمييز الصريح بين مستوى الدليل: «وأظهرت تجارب على الفئران أن الحفاظ على وظيفة هذا البروتين قد يساعد في تقليل تراكم المواد الضارة، لكن لم تُثبت فعالية ذلك لدى البشر بعد.» و«وأظهرت التجارب المختبرية أن الجزيئات نجحت في تقليل بعض الإشارات المرتبطة بالاستجابة المناعية، لكن فعاليتها في علاج الأمراض لدى البشر لم تُختبر بعد.»
- لاحظ في المثالين: الخلاصة في الجملة الأولى، وأفعال متحفّظة، وفقرات قليلة قصيرة لخبر روتيني، ولا خاتمة جاهزة.

مبدأ التركيز التحريري (مهم):
- ليست كل معلومة وردت في المصدر لازمةً للنشر. احتفظ بالحقائق التقنية للتحقّق فقط، ولا تُقحمها في النص المرئي إلا إذا كان القارئ يحتاجها فعلاً ليتعرّف على المنتج أو يتّخذ الإجراء الصحيح.
- احذف من النص المرئي — ما لم تكن ضرورية حقاً — أرقام الدفعات/التشغيلات، وأرقام NDC أو التسجيل الداخلية، وتواريخ التوزيع أو انتهاء الصلاحية، والتركيز الدوائي الدقيق وتفاصيل التغليف، والتسميات التنظيمية الملحقة بالاسم الإنجليزي وحدها (USP وNDC وLot وInc وLLC وLtd وكلمات الشكل الصيدلاني مثل for Injection).

الأسماء الأجنبية (التعريب أولاً):
- لكل اسم أجنبي أساسي (الأدوية والشركات والمنتجات والجهات): اكتب الاسم بالعربية أولاً، ثم ضَع الاسم الأصلي الدقيق كما ورد في المصدر بين قوسين مرّة واحدة عند أوّل ذكر، مثل «سيكلوفوسفاميد (Cyclophosphamide)»، وبعدها استخدم العربية وحدها.
- علامتا التنصيص «» في المخرجات مخصّصتان حصراً للكلام المنقول حرفياً من المصدر. لا تضع بينهما أسماء أو أدوية أو مجلات أو برامج أو مصطلحات: الاسم المعرّب يُكتب مجرّداً بلا «»، والأصل الأجنبي بين قوسين () مرّة واحدة عند أوّل ذكر. (علامات «» في هذه التعليمات تحدّد الأمثلة فقط ولا تُنسخ إلى النص.)
- لا تحذف الاسم الأصلي ولا تختصره ولا تبدّل أي جزء من هويته، بما في ذلك الواصفات الكيميائية مثل Hydrochloride، حتى لا تضيع الهوية الدقيقة للمنتج أو الجهة. المسموح بإسقاطه من الاسم فقط: USP وNDC وLot وInc وLLC وLtd وكلمات الشكل الصيدلاني مثل for Injection؛ وكل ما عدا ذلك في الاسم يبقى كما ورد.
- انقل إلى العربية فقط الأسماء الراسخة أو التي لا لبس في نطقها. إذا لم تكن متأكداً من النطق الصحيح فلا تخترع تهجئة عربية أبداً: أبقِ الاسم اللاتيني الأصلي كما هو مسبوقاً بوصف عربي، مثل: شركة Spectra Medical.
- صيغة «X doing business as Y» تبقى باتجاهها: X هي الجهة القانونية وY هو الاسم التجاري («شركة X التي تعمل باسم Y»)، ولا تعكسها.

أمانة تفاصيل السحب والإصابات:
- إذا ذكر المصدر تصنيف خطورة السحب (مثل Class I أو «الفئة الأولى» أو «الأكثر خطورة») فأبقِه في المقال بصياغة عربية واضحة.
- أي عدد إصابات أو بلاغات أو وفيات مقرون في المصدر بتاريخ («حتى تاريخ…» / as of) يبقى مقروناً بالتاريخ نفسه كما ورد.
- lot وbatch تعني «دفعة» أو «تشغيلة»، ولا تُترجم أبداً إلى «عبوة».
- لا تكتب في نص المقال «لم يذكر المصدر…» أو أي صيغة مشابهة: إذا لم يذكر المصدر معلومة فاحذف الحديث عنها ببساطة.

العنوان:
- عنوان قصير يحمل الخبر نفسه، وينقل التطوّر الفعلي بلغة عربية سلسة وجذّابة دون مبالغة.
- لا تنسخ العنوان الأصلي ولا تُنهِ العنوان باسم المصدر أو الموقع.
- العنوان عربي بالكامل: حافظ على هوية المنتج والدواء والجهة والدولة بالعربية المفهومة، واترك الاسم الأجنبي لأوّل ذكر في النص.
- إذا تعذّر نقل الاسم إلى العربية بأمان فاستخدم في العنوان وصفاً عربياً عاماً (مثل «شركة أمريكية للأجهزة الطبية» أو «دواء لعلاج السكري»)، ويبقى الاسم اللاتيني في النص.

المقتطف (excerpt):
- جملة واحدة قصيرة واضحة تنقل الخلاصة العملية بلغة بسيطة لا أكاديمية، دون حروف إنجليزية.
- لا تكرّر العنوان ولا الجملة الأولى من النص حرفياً.

النص:
- افتح بالخبر نفسه: ماذا حدث، أين، من المتأثّر، وما الجديد — لا بلغة إعلانية ولا بتكرار العنوان.
- فقرات قصيرة يحدّد عددها ما تحتاجه المادة، واشرح المصطلحات الطبية بالعربية المبسّطة.
- ترجم القياسات بشكل طبيعي عند الحاجة، ولا تكتب التواريخ بالصيغة الأمريكية الخام إلا إذا كان التاريخ نفسه مهمّاً.
- يجب أن تبقى الأرقام والتواريخ وأحجام الدراسات وأسماء الأدوية والمنظمات والدول والإجراءات الرسمية — حيثما ذُكرت — أمينة تماماً للمادة المصدرية.

الملخّص «باختصار» (اختياري):
- إن أضفته، فاجعله جملة واحدة موجزة للقارئ المستعجل، مختلفةً عن المقتطف ولا تكرّره. لا تُضِفه إذا لم يقدّم شيئاً جديداً.

استخدم فقط الحقائق والاستشهادات المُتحقَّق منها والمُرفقة. لا تختلق رقماً أو تاريخاً أو اقتباساً أو ادّعاءً.

أعد كائن JSON واحداً فقط، دون أي نص قبله أو بعده ودون أسيجة برمجية (\`\`\`)، بالحقول التالية فقط لا غير (والحقل summary اختياري): {"title":"…","excerpt":"…","summary":"…","body":"فقرات مفصولة بسطر فارغ"}`;
}
