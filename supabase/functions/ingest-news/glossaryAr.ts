// P4R-3 — Salma Arabic glossary (pure, no imports).
//
// SINGLE SOURCE OF TRUTH for the approved Arabic spelling of recurring agencies,
// diseases/pathogens and places. Both the writer prompt (salmaWriter.ts) and the
// editor prompt (salmaEditor.ts) inject the condensed block built here, and
// docs/editorial/GLOSSARY_AR.md is a GENERATED MIRROR of this constant
// (renderGlossaryMarkdown). A unit test fails when the doc drifts from the code;
// edit the entries HERE, then regenerate the doc (command in the doc header).
//
// The glossary fixes SPELLING only. It never licenses adding a Latin form the
// source does not contain (invented_foreign_gloss blocks that), and it never
// adds a fact: a name is used only when the verified source names that entity.

export type GlossaryCategory = "agency" | "disease" | "place";

export type GlossaryEntry = {
  // The Latin form(s) as they usually appear in sources (acronym first).
  latin: string;
  // The ONE approved Arabic spelling.
  arabic: string;
  category: GlossaryCategory;
  // Optional usage rule (Arabic), e.g. a first-mention qualifier.
  note?: string;
};

export const ARABIC_GLOSSARY: readonly GlossaryEntry[] = [
  // --- Agencies / public-health bodies ---------------------------------------
  { latin: "FDA (U.S. Food and Drug Administration)", arabic: "إدارة الغذاء والدواء الأميركية", category: "agency" },
  {
    latin: "SFDA (Saudi Food and Drug Authority)",
    arabic: "الهيئة العامة للغذاء والدواء",
    category: "agency",
    note: "أضف «السعودية» عند أول ذكر: «الهيئة العامة للغذاء والدواء السعودية»",
  },
  { latin: "WHO (World Health Organization)", arabic: "منظمة الصحة العالمية", category: "agency" },
  { latin: "WHO EMRO", arabic: "المكتب الإقليمي لمنظمة الصحة العالمية لشرق المتوسط", category: "agency" },
  { latin: "EMA (European Medicines Agency)", arabic: "وكالة الأدوية الأوروبية", category: "agency" },
  {
    latin: "CDC (Centers for Disease Control and Prevention)",
    arabic: "المراكز الأميركية لمكافحة الأمراض والوقاية منها",
    category: "agency",
  },
  {
    latin: "ECDC (European Centre for Disease Prevention and Control)",
    arabic: "المركز الأوروبي للوقاية من الأمراض ومكافحتها",
    category: "agency",
  },
  {
    latin: "Africa CDC",
    arabic: "المراكز الأفريقية لمكافحة الأمراض والوقاية منها",
    category: "agency",
  },
  { latin: "NIH (National Institutes of Health)", arabic: "المعاهد الوطنية للصحة الأميركية", category: "agency" },
  {
    latin: "MHRA (Medicines and Healthcare products Regulatory Agency)",
    arabic: "الوكالة البريطانية لتنظيم الأدوية ومنتجات الرعاية الصحية",
    category: "agency",
  },
  { latin: "IARC (International Agency for Research on Cancer)", arabic: "الوكالة الدولية لأبحاث السرطان", category: "agency" },
  { latin: "UNICEF", arabic: "منظمة الأمم المتحدة للطفولة (يونيسف)", category: "agency" },
  { latin: "Gavi", arabic: "التحالف العالمي للقاحات والتحصين", category: "agency" },
  {
    latin: "Kuwait Ministry of Health",
    arabic: "وزارة الصحة الكويتية",
    category: "agency",
    note: "جهة خليجية: اذكر دولتها عند أول ذكر",
  },
  {
    latin: "Saudi Ministry of Health",
    arabic: "وزارة الصحة السعودية",
    category: "agency",
    note: "جهة خليجية: اذكر دولتها عند أول ذكر",
  },

  // --- Diseases / pathogens ---------------------------------------------------
  { latin: "Ebola (Bundibugyo virus disease)", arabic: "إيبولا بونديبوجيو", category: "disease" },
  { latin: "Ebola virus disease", arabic: "مرض فيروس إيبولا", category: "disease" },
  { latin: "Shamonda virus", arabic: "فيروس شاموندا", category: "disease" },
  { latin: "Cyclospora", arabic: "طفيلي السيكلوسبورا", category: "disease" },
  { latin: "Salmonella", arabic: "السالمونيلا", category: "disease" },
  { latin: "Listeria", arabic: "الليستيريا", category: "disease" },
  { latin: "Measles", arabic: "الحصبة", category: "disease" },
  {
    latin: "MERS-CoV (Middle East respiratory syndrome coronavirus)",
    arabic: "فيروس كورونا المسبّب لمتلازمة الشرق الأوسط التنفسية",
    category: "disease",
  },
  { latin: "Mpox", arabic: "جدري القردة", category: "disease" },
  { latin: "Cholera", arabic: "الكوليرا", category: "disease" },
  { latin: "Dengue", arabic: "حمّى الضنك", category: "disease" },
  { latin: "Chikungunya", arabic: "حمّى شيكونغونيا", category: "disease" },
  { latin: "Marburg virus disease", arabic: "مرض فيروس ماربورغ", category: "disease" },
  { latin: "Hepatitis A", arabic: "التهاب الكبد الوبائي أ", category: "disease" },
  { latin: "Gaucher disease", arabic: "مرض غوشيه", category: "disease" },
  { latin: "Malaria", arabic: "الملاريا", category: "disease" },
  { latin: "Tuberculosis (TB)", arabic: "السل", category: "disease" },
  { latin: "Avian influenza", arabic: "إنفلونزا الطيور", category: "disease" },

  // --- Places -----------------------------------------------------------------
  { latin: "Democratic Republic of the Congo (DRC)", arabic: "جمهورية الكونغو الديمقراطية", category: "place" },
  { latin: "North Kivu", arabic: "كيفو الشمالية", category: "place" },
  { latin: "South Kivu", arabic: "كيفو الجنوبية", category: "place" },
  { latin: "Ituri", arabic: "إيتوري", category: "place" },
  { latin: "Haut-Uélé", arabic: "أويلي العليا", category: "place" },
  { latin: "Uganda", arabic: "أوغندا", category: "place" },
  { latin: "Kampala", arabic: "كمبالا", category: "place" },
  { latin: "Nigeria", arabic: "نيجيريا", category: "place" },
  { latin: "Bangladesh", arabic: "بنغلاديش", category: "place" },
  { latin: "Riyadh", arabic: "الرياض", category: "place" },
];

const CATEGORY_LABEL_AR: Record<GlossaryCategory, string> = {
  agency: "الجهات",
  disease: "الأمراض ومسبّباتها",
  place: "الأماكن",
};

/** The GCC-regulator first-mention rule, shared verbatim by both prompts. */
export const GCC_REGULATOR_COUNTRY_RULE =
  "الجهة التنظيمية أو الصحية الخليجية تُذكر دولتها عند أول ذكر («الهيئة العامة للغذاء والدواء السعودية»، «وزارة الصحة الكويتية»)، ثم يكفي اسمها بعد ذلك.";

/**
 * The condensed glossary block injected into the writer and editor prompts.
 * Spelling only: a Latin form goes in parentheses ONLY when the verified source
 * itself contains it (otherwise the Arabic name stands alone).
 */
export function buildGlossaryPromptBlock(): string {
  const lines: string[] = [];
  for (const cat of ["agency", "disease", "place"] as const) {
    const items = ARABIC_GLOSSARY.filter((e) => e.category === cat)
      .map((e) => `${e.latin} ← ${e.arabic}${e.note ? ` (${e.note})` : ""}`)
      .join("؛ ");
    lines.push(`- ${CATEGORY_LABEL_AR[cat]}: ${items}.`);
  }
  return [
    "مسرد التهجئة المعتمد (تهجئة عربية واحدة لكل اسم متكرّر — استخدمها حرفياً متى ورد الاسم في المصدر):",
    ...lines,
    `- ${GCC_REGULATOR_COUNTRY_RULE}`,
    "- المسرد للتهجئة فقط: لا يضيف حقيقة، ولا يبيح وضع صيغة لاتينية بين قوسين إلا إذا وردت تلك الصيغة نفسها في المصدر.",
  ].join("\n");
}

/** docs/editorial/GLOSSARY_AR.md — the generated mirror of ARABIC_GLOSSARY. */
export function renderGlossaryMarkdown(): string {
  const out: string[] = [
    "<!-- GENERATED MIRROR — do not edit by hand. Source of truth:",
    "     supabase/functions/ingest-news/glossaryAr.ts (ARABIC_GLOSSARY).",
    "     Regenerate from the repo root:",
    "     node --input-type=module -e \"import('./supabase/functions/ingest-news/glossaryAr.ts').then(m=>process.stdout.write(m.renderGlossaryMarkdown()))\" > docs/editorial/GLOSSARY_AR.md",
    "     A unit test (P4R-3) fails when this file drifts from the code. -->",
    "",
    "# Salma Arabic glossary (مسرد التهجئة المعتمد)",
    "",
    "One approved Arabic spelling per recurring agency, disease/pathogen and place.",
    "Injected (condensed) into the writer and editor prompts. Spelling only: it never",
    "adds a fact and never licenses a Latin gloss the source does not contain.",
    "",
    `Rule: ${GCC_REGULATOR_COUNTRY_RULE}`,
    "",
  ];
  for (const cat of ["agency", "disease", "place"] as const) {
    out.push(`## ${CATEGORY_LABEL_AR[cat]} (${cat})`, "", "| Latin | Arabic (approved) | Note |", "|---|---|---|");
    for (const e of ARABIC_GLOSSARY.filter((x) => x.category === cat)) {
      out.push(`| ${e.latin} | ${e.arabic} | ${e.note ?? ""} |`);
    }
    out.push("");
  }
  return out.join("\n");
}
