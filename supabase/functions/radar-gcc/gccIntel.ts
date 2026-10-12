// GCC Radar V1 — deterministic intelligence layer (pure module, no I/O).
//
// Everything here is keyword/rule based BY DESIGN (cost control: zero LLM
// calls per collected item). The LLM-assisted part of the GCC lens is the
// EXISTING radar-rank pass (score / editorial_value / title_ar), which picks
// these rows up automatically because rank has no provider filter.
//
// Vocabulary note: topic keys follow the GCC Radar V1 brief verbatim and are
// stored in radar_gcc_intel.topics; changing a key is a data migration.

// --- Countries --------------------------------------------------------------

export type GccCountryCode = "KW" | "SA" | "AE" | "QA" | "BH" | "OM";

// English labels MUST match Event Registry's labels: radar-rank geoGuard and
// the inbox flag map key off these exact strings.
export const GCC_COUNTRY_LABELS: Record<GccCountryCode, string> = {
  KW: "Kuwait",
  SA: "Saudi Arabia",
  AE: "United Arab Emirates",
  QA: "Qatar",
  BH: "Bahrain",
  OM: "Oman",
};

export const GCC_COUNTRY_AR: Record<GccCountryCode, string> = {
  KW: "الكويت",
  SA: "السعودية",
  AE: "الإمارات",
  QA: "قطر",
  BH: "البحرين",
  OM: "عُمان",
};

// --- Normalization ----------------------------------------------------------

/** Strip Arabic diacritics/tatweel and normalize letter variants for matching. */
export function normalizeArabic(text: string): string {
  return (text ?? "")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

function haystack(text: string): { ar: string; en: string } {
  const raw = ` ${(text ?? "").trim()} `;
  return { ar: ` ${normalizeArabic(raw)} `, en: ` ${raw.toLowerCase()} ` };
}

/**
 * Word-boundary-aware containment. Arabic needles tolerate attached proclitics
 * (و/ف/ب/ل/ال…) but never match INSIDE a longer word tail — this is what keeps
 * «عمان» from matching «عثمان», and short tokens like "ai" from matching "said".
 */
export function containsTerm(text: string, needle: string): boolean {
  const arabic = /[؀-ۿ]/.test(needle);
  const hay = haystack(text);
  const n = arabic ? normalizeArabic(needle) : needle.toLowerCase();
  if (arabic) {
    // Per word: allow stacked proclitics (و/ف + ب/ل/ك/لل + ال) before the stem,
    // but never match inside a longer word tail (keeps عمان out of عثمان).
    const words = n.split(/\s+/).filter(Boolean).map((w) => {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return `(?:و|ف)?(?:ب|ل|ك|لل)?(?:ال)?${esc}`;
    });
    const re = new RegExp(
      `(^|[^\\u0600-\\u06FF])${words.join("[^\\u0600-\\u06FF]+")}($|[^\\u0600-\\u06FF])`,
    );
    return re.test(hay.ar);
  }
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(hay.en);
}

function anyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((t) => containsTerm(text, t));
}

// --- Language detection -----------------------------------------------------

/** ISO-639-3 to match existing radar rows ('ara'/'eng'); rank + UI expect these. */
export function detectLanguage(title: string): "ara" | "eng" {
  const letters = (title ?? "").replace(/[^\p{L}]/gu, "");
  if (!letters) return "eng";
  const arabic = (letters.match(/[؀-ۿ]/g) ?? []).length;
  return arabic / letters.length >= 0.4 ? "ara" : "eng";
}

// --- Healthcare gate (general-interest sources only) ------------------------

const HEALTH_TERMS_AR = [
  "صحه", "صحي", "صحيه", "مستشفي", "مستشفيات", "دواء", "ادويه", "علاج", "طبي", "طبيه",
  "الطب", "عياده", "عيادات", "لقاح", "لقاحات", "تطعيم", "وباء", "مرض", "امراض", "سرطان",
  "سكري", "قلب", "جراحه", "صيدله", "صيدليات", "تمريض", "اطباء", "طبيب", "مختبر", "اشعه",
  "رعايه صحيه", "تامين صحي", "القطاع الصحي", "وزاره الصحه", "هيئه الصحه", "الغذاء والدواء",
  "مكافحه العدوي", "صحه عامه", "خدمات علاجيه", "منشات صحيه", "مراكز صحيه",
] as const;

const HEALTH_TERMS_EN = [
  "health", "healthcare", "hospital", "hospitals", "clinic", "clinics", "medical",
  "medicine", "drug", "drugs", "pharma", "pharmaceutical", "pharmacy", "vaccine",
  "vaccination", "patient", "patients", "doctors", "physician", "nursing", "surgery",
  "oncology", "diabetes", "cardiology", "telehealth", "medtech", "biotech",
  "clinical", "therapeutics", "diagnostics", "epidemic", "public health", "sfda",
  "insurance", "payer",
] as const;

// Crime/enforcement noise that keyword-matches health terms ("drug cases",
// «ضبط مخدرات») but is police news, not healthcare (brief §26: healthcare-first).
const CRIME_NOISE_TERMS = [
  "arrested", "arrest", "police", "smuggling", "trafficking", "marijuana",
  "methamphetamine", "crime", "murder", "theft", "court sentences",
  "مخدرات", "ضبط", "جريمه", "قتل", "سرقه", "تهريب", "النيابه", "حكم بالسجن",
] as const;

/** True when the title is plausibly about healthcare (gate for general sources). */
export function isHealthRelevant(title: string): boolean {
  if (anyTerm(title, CRIME_NOISE_TERMS)) return false;
  return anyTerm(title, HEALTH_TERMS_AR) || anyTerm(title, HEALTH_TERMS_EN);
}

// --- Topic taxonomy (brief §9 — keys are stored data) -----------------------

export type GccTopic =
  | "regulation" | "insurance" | "digital_health" | "pharma" | "medtech"
  | "hospitals" | "investment" | "partnerships" | "public_health" | "workforce"
  | "infrastructure" | "healthcare_finance";

type TopicDef = { ar: string; weight: number; terms: readonly string[] };

export const GCC_TOPICS: Record<GccTopic, TopicDef> = {
  regulation: {
    ar: "تنظيم ورقابة", weight: 15,
    terms: [
      "تنظيم", "لائحه", "لوائح", "تعميم", "قرار وزاري", "اشتراطات", "ترخيص", "تراخيص",
      "رقابه", "مخالفات", "ضوابط", "تشريع", "قانون", "الغذاء والدواء", "تسجيل دواء",
      "regulation", "regulatory", "circular", "directive", "licensing", "license",
      "compliance", "sfda", "ministerial decision", "law", "legislation",
    ],
  },
  insurance: {
    ar: "التأمين الصحي", weight: 15,
    terms: [
      "تامين صحي", "التامين الصحي", "وثيقه تامين", "مطالبات", "تغطيه تامينيه", "بوليصه",
      "الضمان الصحي", "مظلة التامين",
      "health insurance", "insurer", "insurers", "payer", "claims", "coverage",
      "reimbursement", "premiums",
    ],
  },
  digital_health: {
    ar: "الصحة الرقمية", weight: 15,
    terms: [
      "صحه رقميه", "الصحه الرقميه", "تطبيق صحي", "منصه صحيه", "الذكاء الاصطناعي",
      "تشخيص عن بعد", "طب الاتصال", "الطب عن بعد", "ملف صحي الكتروني", "روبوت",
      "digital health", "telemedicine", "telehealth", "health app", "ai", "artificial intelligence",
      "electronic health record", "ehr", "health tech", "healthtech", "wearable",
    ],
  },
  pharma: {
    ar: "الأدوية", weight: 15,
    terms: [
      "دواء", "ادويه", "مستحضر", "مستحضرات صيدلانيه", "صيدلانيه", "لقاح", "لقاحات",
      "عقار", "عقاقير", "جرعه", "تسجيل دواء", "سحب دواء", "مصنع ادويه",
      "drug", "drugs", "pharmaceutical", "pharma", "vaccine", "biosimilar",
      "generic", "medication", "medicines", "api manufacturing",
    ],
  },
  medtech: {
    ar: "الأجهزة الطبية", weight: 15,
    terms: [
      "جهاز طبي", "اجهزه طبيه", "مستلزمات طبيه", "معدات طبيه", "تقنيه طبيه", "زراعه اجهزه",
      "medical device", "medical devices", "medtech", "diagnostics", "imaging",
      "implant", "surgical robot", "lab equipment",
    ],
  },
  hospitals: {
    ar: "المستشفيات والرعاية", weight: 12,
    terms: [
      "مستشفي", "مستشفيات", "مركز طبي", "مراكز صحيه", "مجمع طبي", "عياده", "عيادات",
      "اسره", "سعه سريريه", "طوارئ", "رعايه اوليه", "رعايه صحيه",
      "hospital", "hospitals", "medical center", "medical centre", "clinic", "clinics",
      "beds", "emergency department", "primary care", "care provider",
    ],
  },
  investment: {
    ar: "استثمار واستحواذ", weight: 12,
    terms: [
      "استثمار", "استثمارات", "استحواذ", "اندماج", "صفقه", "تمويل", "جوله تمويليه",
      "طرح", "اكتتاب", "حصه", "صندوق", "رووس اموال",
      "investment", "acquisition", "merger", "m&a", "funding", "funding round",
      "ipo", "stake", "venture", "private equity", "deal",
    ],
  },
  partnerships: {
    ar: "شراكات واتفاقيات", weight: 8,
    terms: [
      "شراكه", "شراكات", "اتفاقيه", "اتفاقيات", "مذكره تفاهم", "تعاون مشترك", "تحالف",
      "partnership", "agreement", "mou", "memorandum", "collaboration", "alliance",
      "joint venture",
    ],
  },
  public_health: {
    ar: "الصحة العامة", weight: 12,
    terms: [
      "صحه عامه", "الصحه العامه", "وباء", "تفشي", "حمله توعيه", "حمله تطعيم", "مكافحه العدوي",
      "امراض مزمنه", "صحه المجتمع", "وقايه", "فحص مبكر", "مسح صحي", "اعتلال",
      "public health", "outbreak", "epidemic", "screening", "prevention",
      "awareness campaign", "immunization", "disease control", "chronic diseases",
    ],
  },
  workforce: {
    ar: "الكوادر الصحية", weight: 8,
    terms: [
      "كوادر صحيه", "كوادر طبيه", "توطين", "تكويت", "سعوده", "اطباء", "تمريض", "ممرضين",
      "ابتعاث", "تدريب طبي", "زماله", "رخصه مزاوله", "هيئه التخصصات",
      "workforce", "staffing", "nurses", "physicians", "residency", "fellowship",
      "medical training", "emiratisation", "saudization", "licensure",
    ],
  },
  infrastructure: {
    ar: "بنية تحتية صحية", weight: 8,
    terms: [
      "انشاء مستشفي", "بناء مستشفي", "توسعه", "مشروع صحي", "مدينه طبيه", "بنيه تحتيه",
      "افتتاح", "تطوير مرافق", "مناقصه", "ترسيه",
      "construction", "expansion", "medical city", "infrastructure", "tender",
      "contract award", "inauguration", "new facility",
    ],
  },
  healthcare_finance: {
    ar: "تمويل القطاع الصحي", weight: 8,
    terms: [
      "ميزانيه الصحه", "الانفاق الصحي", "تكاليف العلاج", "فاتوره علاجيه", "تمويل صحي",
      "ارباح", "نتائج ماليه", "ايرادات",
      "health budget", "health spending", "healthcare costs", "financial results",
      "revenues", "profits", "earnings",
    ],
  },
};

export function detectTopics(title: string): GccTopic[] {
  const hits: GccTopic[] = [];
  for (const key of Object.keys(GCC_TOPICS) as GccTopic[]) {
    if (anyTerm(title, GCC_TOPICS[key].terms)) hits.push(key);
  }
  return hits.slice(0, 3);
}

// --- Consequence signals (brief §10) ---------------------------------------

export type SignalStrength = "strong" | "medium" | "weak";

export type GccSignal =
  | "regulatory_approval" | "recall_or_suspension" | "mandatory_directive"
  | "license_action" | "tender_award" | "acquisition"
  | "funding_round" | "facility_launch" | "expansion" | "partnership_agreement"
  | "penalty" | "policy_report"
  | "official_statement";

type SignalDef = { ar: string; strength: SignalStrength; terms: readonly string[] };

export const GCC_SIGNALS: Record<GccSignal, SignalDef> = {
  regulatory_approval: {
    ar: "اعتماد أو موافقة رسمية", strength: "strong",
    terms: [
      "اعتماد", "موافقه", "اجازه", "تسجيل دواء", "اعتمدت", "توافق علي", "تجيز",
      "approval", "approves", "approved", "authorizes", "authorised", "registration granted",
      "clearance",
    ],
  },
  recall_or_suspension: {
    ar: "سحب أو إيقاف", strength: "strong",
    terms: [
      "سحب", "تسحب", "ايقاف", "توقف", "تعليق", "حظر", "تحذير من",
      "recall", "recalls", "suspension", "suspends", "withdrawal", "bans", "ban on",
      "safety warning",
    ],
  },
  mandatory_directive: {
    ar: "تعميم أو قرار مُلزم", strength: "strong",
    terms: [
      "تعميم", "الزامي", "الزام", "يلزم", "قرار وزاري", "توجيه عاجل", "تكليف",
      "mandatory", "mandate", "directive", "circular", "ministerial decision",
      "requires all", "obliges",
    ],
  },
  license_action: {
    ar: "إجراء ترخيص", strength: "strong",
    terms: [
      "ترخيص", "رخصه", "تراخيص", "سحب ترخيص", "الغاء ترخيص", "منح ترخيص",
      "license granted", "license revoked", "licensing", "licensed to operate",
    ],
  },
  tender_award: {
    ar: "مناقصة أو ترسية", strength: "strong",
    terms: [
      "مناقصه", "ترسيه", "ارساء", "عقد توريد", "امر شراء",
      "tender", "contract awarded", "awarded contract", "procurement",
    ],
  },
  acquisition: {
    ar: "استحواذ أو اندماج", strength: "strong",
    terms: [
      "استحواذ", "تستحوذ", "اندماج", "تندمج", "شراء حصه",
      "acquisition", "acquires", "acquired", "merger", "merges", "takeover",
    ],
  },
  funding_round: {
    ar: "جولة تمويل", strength: "medium",
    terms: [
      "جوله تمويليه", "جوله تمويل", "تمويل بقيمه", "جمعت",
      "funding round", "raises", "raised", "series a", "series b", "seed round",
    ],
  },
  facility_launch: {
    ar: "افتتاح أو إطلاق", strength: "medium",
    terms: [
      "افتتاح", "تفتتح", "اطلاق", "تطلق", "تدشين", "يدشن", "بدء تشغيل",
      "launches", "launch of", "opens", "opening of", "inaugurates", "unveils",
    ],
  },
  expansion: {
    ar: "توسعة", strength: "medium",
    terms: [
      "توسعه", "توسع", "زياده السعه", "اضافه اسره", "مرحله جديده",
      "expansion", "expands", "scaling up", "adds beds", "new phase",
    ],
  },
  partnership_agreement: {
    ar: "شراكة أو اتفاقية", strength: "medium",
    terms: [
      "شراكه", "اتفاقيه", "مذكره تفاهم", "توقع", "وقعت", "تحالف",
      "partnership", "signs agreement", "agreement with", "mou", "teams up",
    ],
  },
  penalty: {
    ar: "مخالفة أو غرامة", strength: "medium",
    terms: [
      "مخالفه", "مخالفات", "غرامه", "غرامات", "ضبط", "اغلاق",
      "fine", "fines", "penalty", "violation", "violations", "shut down",
    ],
  },
  policy_report: {
    ar: "تقرير أو مؤشرات", strength: "medium",
    terms: [
      "تقرير", "احصائيات", "مؤشرات", "دراسه مسحيه", "نتائج مسح", "بيانات",
      "report", "statistics", "survey results", "data shows", "study finds", "index",
    ],
  },
  official_statement: {
    ar: "تصريح رسمي", strength: "weak",
    terms: [
      "صرح", "تصريح", "اكد", "اكدت", "اوضح", "اوضحت", "كشف", "كشفت", "اعلن", "اعلنت",
      "announces", "announced", "confirms", "confirmed", "reveals", "statement",
    ],
  },
};

const STRENGTH_ORDER: Record<SignalStrength, number> = { strong: 3, medium: 2, weak: 1 };

export function detectSignals(title: string): GccSignal[] {
  const hits: GccSignal[] = [];
  for (const key of Object.keys(GCC_SIGNALS) as GccSignal[]) {
    if (anyTerm(title, GCC_SIGNALS[key].terms)) hits.push(key);
  }
  hits.sort((a, b) => STRENGTH_ORDER[GCC_SIGNALS[b].strength] - STRENGTH_ORDER[GCC_SIGNALS[a].strength]);
  return hits.slice(0, 3);
}

export function strongestStrength(signals: readonly GccSignal[]): SignalStrength | null {
  if (!signals.length) return null;
  return GCC_SIGNALS[signals[0]].strength;
}

// --- Organization detection (brief §12 — recognition, not entity resolution) --

export type GccOrg = { key: string; ar: string; names: readonly string[]; country?: GccCountryCode };

export const GCC_ORGS: readonly GccOrg[] = [
  // Regulators / government
  { key: "moh_kw", ar: "وزارة الصحة الكويتية", names: ["وزاره الصحه", "ministry of health"], country: "KW" },
  { key: "dawa_kw", ar: "إدارة الدواء الكويتية", names: ["اداره الدواء", "التفتيش الصيدلي"], country: "KW" },
  { key: "moh_sa", ar: "وزارة الصحة السعودية", names: ["وزاره الصحه", "ministry of health"], country: "SA" },
  { key: "sfda", ar: "هيئة الغذاء والدواء السعودية", names: ["الغذاء والدواء", "sfda", "food and drug authority"], country: "SA" },
  { key: "chi_sa", ar: "مجلس الضمان الصحي", names: ["الضمان الصحي", "مجلس الضمان", "council of health insurance", "chi"], country: "SA" },
  { key: "seha_sa", ar: "صحة الافتراضية", names: ["مستشفي صحه الافتراضي", "seha virtual"], country: "SA" },
  { key: "nupco", ar: "نوبكو", names: ["نوبكو", "nupco"], country: "SA" },
  { key: "ghc_sa", ar: "مجلس الصحة الخليجي", names: ["مجلس الصحه الخليجي", "gulf health council"] },
  { key: "mohap", ar: "وزارة الصحة ووقاية المجتمع", names: ["وزاره الصحه ووقايه المجتمع", "mohap"], country: "AE" },
  { key: "dha", ar: "هيئة الصحة بدبي", names: ["هيئه الصحه بدبي", "dubai health authority", "dha"], country: "AE" },
  { key: "doh_ad", ar: "دائرة الصحة أبوظبي", names: ["دائره الصحه", "department of health abu dhabi", "doh"], country: "AE" },
  { key: "ehs_ae", ar: "مؤسسة الإمارات للخدمات الصحية", names: ["مؤسسه الامارات للخدمات الصحيه", "emirates health services"], country: "AE" },
  // Providers / groups
  { key: "dasman", ar: "معهد دسمان للسكري", names: ["دسمان", "dasman"], country: "KW" },
  { key: "kfshrc", ar: "مستشفى الملك فيصل التخصصي", names: ["الملك فيصل التخصصي", "king faisal specialist"], country: "SA" },
  { key: "hmg", ar: "مجموعة د. سليمان الحبيب", names: ["سليمان الحبيب", "al habib", "hmg"], country: "SA" },
  { key: "mouwasat", ar: "المواساة", names: ["المواساه", "mouwasat"], country: "SA" },
  { key: "dallah", ar: "دلة الصحية", names: ["دله الصحيه", "dallah health"], country: "SA" },
  { key: "fakeeh", ar: "فقيه للرعاية الصحية", names: ["فقيه", "fakeeh"], country: "SA" },
  { key: "purehealth", ar: "بيور هيلث", names: ["بيور هيلث", "purehealth", "pure health"], country: "AE" },
  { key: "m42", ar: "M42", names: ["m42"], country: "AE" },
  { key: "burjeel", ar: "برجيل القابضة", names: ["برجيل", "burjeel"], country: "AE" },
  { key: "nmc", ar: "NMC للرعاية الصحية", names: ["nmc"], country: "AE" },
  { key: "aster", ar: "أستر دي إم", names: ["استر", "aster"], country: "AE" },
  { key: "mediclinic", ar: "ميديكلينيك", names: ["ميديكلينيك", "mediclinic"], country: "AE" },
  { key: "sheikh_shakhbout", ar: "مدينة الشيخ شخبوط الطبية", names: ["الشيخ شخبوط", "sheikh shakhbout"], country: "AE" },
  // Payers
  { key: "bupa_arabia", ar: "بوبا العربية", names: ["بوبا", "bupa arabia"], country: "SA" },
  { key: "tawuniya", ar: "التعاونية", names: ["التعاونيه", "tawuniya"], country: "SA" },
  { key: "medgulf", ar: "ميدغلف", names: ["ميدغلف", "medgulf"], country: "SA" },
  { key: "daman", ar: "ضمان", names: ["الضمان الوطنيه", "daman"], country: "AE" },
  // Digital / investment
  { key: "lean_sa", ar: "لين لخدمات الأعمال", names: ["شركه لين", "lean business services"], country: "SA" },
  { key: "g42", ar: "G42", names: ["g42"], country: "AE" },
  { key: "mubadala", ar: "مبادلة", names: ["مبادله", "mubadala"], country: "AE" },
  { key: "pif", ar: "صندوق الاستثمارات العامة", names: ["صندوق الاستثمارات العامه", "public investment fund", "pif"], country: "SA" },
  { key: "kia_kw", ar: "الهيئة العامة للاستثمار الكويتية", names: ["الهيئه العامه للاستثمار", "kuwait investment authority"], country: "KW" },
] as const;

export function detectOrgs(title: string): string[] {
  const hits: string[] = [];
  for (const org of GCC_ORGS) {
    if (org.names.some((n) => containsTerm(title, n))) hits.push(org.key);
  }
  return [...new Set(hits)].slice(0, 4);
}

export function orgLabelAr(key: string): string | null {
  return GCC_ORGS.find((o) => o.key === key)?.ar ?? null;
}

// --- Scoring + strategic flag (brief §11, §18) -------------------------------

export type SourceClassV1 =
  | "government" | "regulator" | "provider" | "insurance" | "digital_health"
  | "pharma_medtech" | "investment" | "wire" | "media";

export type GccClassification = {
  topics: GccTopic[];
  signals: GccSignal[];
  orgs: string[];
  strategic: boolean;
  strategicReasons: string[];
  score: number;
  whyAr: string;
};

const AUTHORITY_BASE: Record<number, number> = { 1: 40, 2: 30, 3: 18, 4: 10 };

/**
 * Deterministic 0–100 importance-for-GCC score. This NEVER touches
 * priority_score/ESL — it only orders and badges the GCC view (brief §11:
 * do not blindly boost everything GCC; do not replace existing ranking).
 */
export function gccScore(args: {
  authorityTier: number;
  topics: readonly GccTopic[];
  signals: readonly GccSignal[];
  orgs: readonly string[];
}): number {
  let score = AUTHORITY_BASE[args.authorityTier] ?? 10;
  const strength = strongestStrength(args.signals);
  if (strength === "strong") score += 30;
  else if (strength === "medium") score += 18;
  else if (strength === "weak") score += 6;
  const topicWeight = Math.max(0, ...args.topics.map((t) => GCC_TOPICS[t].weight));
  score += topicWeight;
  if (args.orgs.length > 0) score += 5;
  return Math.min(100, score);
}

/** Explainable «تطور مهم» rule — reasons are stored alongside the flag. */
export function strategicFlag(args: {
  authorityTier: number;
  topics: readonly GccTopic[];
  signals: readonly GccSignal[];
}): { strategic: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const strength = strongestStrength(args.signals);
  if (args.authorityTier <= 2 && strength === "strong") {
    reasons.push("official_strong_action");
  }
  if (args.topics.includes("regulation") && strength === "strong") {
    reasons.push("regulatory_strong_signal");
  }
  if (
    (args.topics.includes("insurance") || args.topics.includes("digital_health")) &&
    (strength === "strong" || strength === "medium") && args.authorityTier <= 2
  ) {
    reasons.push("market_structure_shift");
  }
  if (args.signals.includes("acquisition") && args.topics.some((t) => t !== "investment")) {
    reasons.push("sector_consolidation");
  }
  return { strategic: reasons.length > 0, reasons };
}

// --- «لماذا يهم؟» deterministic one-liner (brief §17) ------------------------

export function buildWhyAr(args: {
  countryCode: GccCountryCode;
  authorityTier: number;
  topics: readonly GccTopic[];
  signals: readonly GccSignal[];
  orgs: readonly string[];
}): string {
  const country = GCC_COUNTRY_AR[args.countryCode];
  const topic = args.topics[0] ? GCC_TOPICS[args.topics[0]].ar : "القطاع الصحي";
  const signal = args.signals[0] ? GCC_SIGNALS[args.signals[0]].ar : null;
  const org = args.orgs[0] ? orgLabelAr(args.orgs[0]) : null;
  const actor = org ?? (args.authorityTier === 1 ? "جهة رسمية" : args.authorityTier === 2 ? "جهة مؤسسية" : null);
  const strength = strongestStrength(args.signals);

  if (signal && strength === "strong") {
    return actor
      ? `${signal} من ${actor} — أثر مباشر محتمل على ${topic} في ${country}.`
      : `${signal} — أثر مباشر محتمل على ${topic} في ${country}.`;
  }
  if (signal && strength === "medium") {
    return actor
      ? `${signal} عبر ${actor} — تطور يستحق المتابعة في ${topic} (${country}).`
      : `${signal} — تطور يستحق المتابعة في ${topic} (${country}).`;
  }
  if (signal) {
    return `${signal} حول ${topic} في ${country}.`;
  }
  return `خبر ضمن ${topic} في ${country}.`;
}

// --- Item classification entry point ----------------------------------------

export function classifyGccItem(args: {
  title: string;
  countryCode: GccCountryCode;
  authorityTier: number;
}): GccClassification {
  const topics = detectTopics(args.title);
  const signals = detectSignals(args.title);
  const orgs = detectOrgs(args.title);
  const { strategic, reasons } = strategicFlag({ authorityTier: args.authorityTier, topics, signals });
  const score = gccScore({ authorityTier: args.authorityTier, topics, signals, orgs });
  const whyAr = buildWhyAr({
    countryCode: args.countryCode,
    authorityTier: args.authorityTier,
    topics, signals, orgs,
  });
  return { topics, signals, orgs, strategic, strategicReasons: reasons, score, whyAr };
}

// --- Feed parsing (tolerant RSS/Atom, no DOM dependency) ---------------------

export type FeedItem = { title: string; url: string; publishedAt: string | null };

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagContent(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : null;
}

function parseDateSafe(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(decodeEntities(raw));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Parse RSS 2.0 `<item>` and Atom `<entry>` blocks with a tolerant regex scan. */
export function parseFeedItems(xml: string, cap = 50): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = (xml ?? "").match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    const title = decodeEntities(tagContent(block, "title") ?? "");
    // RSS: <link>url</link>; Atom: <link href="url"/> (prefer rel="alternate").
    let url = decodeEntities(tagContent(block, "link") ?? "");
    if (!url) {
      const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ??
        block.match(/<link[^>]*href=["']([^"']+)["']/i);
      url = alt ? decodeEntities(alt[1]) : "";
    }
    const publishedAt = parseDateSafe(
      tagContent(block, "pubDate") ?? tagContent(block, "dc:date") ??
      tagContent(block, "published") ?? tagContent(block, "updated"),
    );
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, url, publishedAt });
    if (out.length >= cap) break;
  }
  return out;
}

// --- Listing-page extraction (anchors only; deliberately not a scraper) ------

/**
 * Extract candidate article links from a server-rendered listing/newsroom
 * page: same-registered-domain anchors whose href matches the source's
 * include pattern, titled by their visible anchor text. No CSS selectors, no
 * per-site parsing — if a site stops server-rendering its list, the source
 * just goes stale and the coverage report flags it (brief §20).
 */
export function extractListingLinks(args: {
  html: string;
  baseUrl: string;
  includePattern: string;
  cap?: number;
}): FeedItem[] {
  const cap = args.cap ?? 40;
  let include: RegExp;
  try {
    include = new RegExp(args.includePattern, "i");
  } catch {
    return [];
  }
  let base: URL;
  try {
    base = new URL(args.baseUrl);
  } catch {
    return [];
  }
  const baseHost = base.hostname.replace(/^www\./, "");

  const out: FeedItem[] = [];
  const seen = new Set<string>();
  const anchors = (args.html ?? "").match(/<a\s[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi) ?? [];
  for (const a of anchors) {
    const hrefM = a.match(/href=["']([^"']+)["']/i);
    if (!hrefM) continue;
    const rawHref = decodeEntities(hrefM[1]);
    if (/^(javascript:|mailto:|tel:|#)/i.test(rawHref)) continue;
    let abs: URL;
    try {
      abs = new URL(rawHref, base.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(abs.protocol)) continue;
    const host = abs.hostname.replace(/^www\./, "");
    if (host !== baseHost && !host.endsWith(`.${baseHost}`)) continue;
    if (!include.test(abs.pathname + abs.search)) continue;
    const title = decodeEntities(a.replace(/^<a\s[^>]*>/i, "").replace(/<\/a>$/i, ""));
    // Headline-quality bar: drop nav links, section names, unrendered template
    // fragments ("${title}") and SharePoint "currently selected" markers.
    if (title.length < 20) continue;
    if (title.split(/\s+/).filter(Boolean).length < 4) continue;
    if (title.includes("${") || /محدد حاليا|currently selected/i.test(normalizeArabic(title))) continue;
    const key = abs.href.replace(/[#].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url: key, publishedAt: null });
    if (out.length >= cap) break;
  }
  return out;
}

// --- Stable provider ids ------------------------------------------------------

/** Deterministic non-numeric provider_uri (namespaced away from ER's numeric ids). */
export async function gccProviderUri(url: string): Promise<string> {
  const data = new TextEncoder().encode(url.replace(/[#].*$/, ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `gcc:${hex.slice(0, 32)}`;
}
