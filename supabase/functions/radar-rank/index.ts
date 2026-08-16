import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { similarity, numericConflict } from "../ingest-news/dedupe.ts";

// Fast News Radar — RANKING function (evaluation-only, isolated from collection).
//
// radar-rank reads ONLY radar_shadow_articles rows that still need ranking
// (ranked_at IS NULL — covers never-ranked rows AND prior UNRANKED_ERROR rows,
// which keep ranked_at NULL so they are retried on later cycles). For each it:
//   (1) runs DETERMINISTIC cross-source duplicate detection against Salma
//       content (normalized URL / dedupe_key, then Arabic-aware title
//       similarity) — NO LLM, reusing the tested ingest-news dedupe helpers;
//   (2) classifies editorial value + priority + expected category via a single
//       batched OpenRouter call (openai/gpt-4o-mini, no web search) using the
//       approved gated two-stage prompt;
//   (3) applies the deterministic geographic sanity guard.
// It then writes the ranking fields back onto radar_shadow_articles and records
// one diagnostics row in radar_rank_runs.
//
// It NEVER touches content, ingestion_runs, news_sources, the Writer, the
// Editorial Director, or Fidelity, and never publishes. It is completely
// independent of radar-shadow (collection) and must never block it.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Ranking model is pinned here (NOT read from the shared OPENROUTER_MODEL
// secret, which the Writer uses) so radar-rank always runs on the approved,
// calibrated openai/gpt-4o-mini.
const RANK_MODEL = "openai/gpt-4o-mini";

// How far back to look in Salma content for a title-similarity duplicate.
const DEDUPE_WINDOW_MS = 21 * 24 * 60 * 60 * 1000; // 21 days
const DUPLICATE_TITLE_THRESHOLD = 0.72; // >= → already_in_salma
const POSSIBLE_DUPLICATE_FLOOR = 0.6; // 0.60..0.72 → possible_duplicate

// Ranking-completeness driver: primary batch size then smaller retry batches
// over ONLY the still-missing items. Max TWO extra passes (the [6,3] sizes);
// anything still unresolved becomes UNRANKED_ERROR (never silently Low).
const PRIMARY_BATCH = 12;
const RETRY_BATCHES = [6, 3];
// How many rows to rank per invocation (bounds cost/time; leftover rows stay
// ranked_at IS NULL and are picked up next cycle).
const MAX_PER_RUN = 240;

const VALID_CATEGORIES = [
  "kuwait", "gulf", "world", "health-economy", "lifestyle", "investigations", "dawi-news",
];

// --- editorial value taxonomy ------------------------------------------------
type EditorialValue =
  | "newsworthy_new_development"
  | "editorial_opportunity"
  | "evergreen_generic"
  | "not_relevant";
const VALID_EV: EditorialValue[] = [
  "newsworthy_new_development", "editorial_opportunity", "evergreen_generic", "not_relevant",
];
type PriorityLevel = "very_important" | "important" | "low";

// Score → level (75/50 thresholds); EVERGREEN/NOT_RELEVANT are forced Low
// regardless of score.
function levelFromScore(score: number): PriorityLevel {
  if (score >= 75) return "very_important";
  if (score >= 50) return "important";
  return "low";
}
function levelFor(value: EditorialValue, score: number): PriorityLevel {
  if (value === "not_relevant" || value === "evergreen_generic") return "low";
  return levelFromScore(score);
}

// --- deterministic geographic sanity guard (metadata-only) -------------------
const GCC_COUNTRIES = new Set([
  "Kuwait", "Saudi Arabia", "United Arab Emirates", "UAE", "Qatar", "Bahrain", "Oman",
]);
const NON_GCC_COUNTRIES = new Set([
  "Pakistan", "Egypt", "Türkiye", "Turkey", "Iran", "Indonesia", "India", "United States",
  "United Kingdom", "France", "Germany", "China", "Russia", "Nigeria", "Bangladesh",
  "Brazil", "Canada", "Australia", "Spain", "Italy", "Japan", "Israel", "Lebanon",
  "Syria", "Jordan", "Iraq", "Yemen", "Morocco", "Algeria", "Tunisia", "Sudan",
]);
const KUWAIT_RE = /kuwait|الكويت|كويتي/i;
const GCC_RE =
  /kuwait|saudi|riyadh|jeddah|\bksa\b|emirat|\buae\b|dubai|abu dhabi|abudhabi|qatar|doha|bahrain|manama|\boman\b|muscat|gulf|\bgcc\b|khaleej|الكويت|السعودي|الإمارات|الامارات|قطر|البحرين|عُمان|عمان|الخليج|خليجي/i;

function geoGuard(
  category: string | null,
  title: string | null,
  country: string | null,
): string | null {
  if (category !== "kuwait" && category !== "gulf") return category;
  const t = title ?? "";
  const c = country ?? "";
  if (category === "kuwait") {
    const ok = c === "Kuwait" || KUWAIT_RE.test(t);
    if (ok && !(NON_GCC_COUNTRIES.has(c) && !KUWAIT_RE.test(t))) return category;
    return "world";
  }
  const okG = GCC_COUNTRIES.has(c) || GCC_RE.test(t);
  if (okG && !(NON_GCC_COUNTRIES.has(c) && !GCC_RE.test(t))) return category;
  return "world";
}

// Mirrors ingest-news dedupeKeyFromUrl (host+path, www/trailing-slash stripped,
// lowercased) — the exact form stored in content.dedupe_key.
function dedupeKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

// The approved gated two-stage editorial prompt (single source of truth mirrors
// scripts/radar-eval.ts SYSTEM_PROMPT — includes the strict VERY_IMPORTANT
// eligibility gate + explicit score caps).
const SYSTEM_PROMPT =
  "أنت مساعد فرز تحريري لمنصة أخبار صحية (سلمى) تخدم الكويت والخليج بالعربية. " +
  "اعتمد فقط على البيانات الوصفية المتاحة (العنوان، المصدر، الدولة، اللغة، وقت النشر). " +
  "لا تختلق حقائق ولا تبحث في الويب.\n" +
  "لكل مقال نفّذ ثلاث خطوات:\n" +
  "الخطوة 1 — الصلة الصحية: هل الموضوع ضمن كون سلمى الصحي الواسع؟ يشمل: الطب والمرض والعلاج والتشخيص والأدوية " +
  "والأجهزة والتجارب السريرية والأبحاث الطبية والمستشفيات والأطباء والمرضى؛ الصحة العامة وأنظمة الرعاية والسياسة " +
  "الصحية والتنظيم والأوبئة والوقاية والتأمين والوصول للرعاية والقوى العاملة الصحية واقتصاديات الصحة والدواء " +
  "والتقنية الحيوية والذكاء الاصطناعي الطبي والصحة الرقمية؛ وأيضًا (ضمن النطاق): التغذية والمكمّلات والرياضة والنوم " +
  "والصحة النفسية والتوتر والتأمل والسمنة وإدارة الوزن والشيخوخة الصحية وصحة المرأة والرجل والوقاية ونمط الحياة " +
  "المؤثّر في الصحة والرفاهية وجودة الحياة؛ والزوايا الأوسع: قضية اجتماعية ذات بُعد صحي حقيقي، تحقيقات، استطلاعات، " +
  "إحصاءات كبرى، اتجاهات ديموغرافية، قضايا بيئية عند وجود أثر صحي حقيقي، قصص إنسانية ذات زاوية صحية حقيقية. " +
  "إن غابت الصحة أو كانت هامشية، أو كان الخبر حادثة/واقعة فردية بلا دلالة صحية أوسع → NOT_RELEVANT.\n" +
  "الخطوة 2 — الطبيعة التحريرية (value):\n" +
  "NEWSWORTHY_NEW_DEVELOPMENT: تطوّر جديد فعلي (موافقة/سحب/تحذير سلامة دواء أو جهاز، تفشٍّ أو طارئ صحة عامة، " +
  "نتيجة سريرية/علمية مهمة، سياسة/تنظيم صحي مهم، تغيير كبير في نظام صحي، استحواذ/استثمار دوائي أو مستشفيات كبير، " +
  "تطوّر كبير في التقنية/الذكاء الاصطناعي الطبي، تطوّر صحي كبير في الكويت/الخليج، بيانات/تقرير رسمي جديد بأثر صحي كبير). " +
  "EDITORIAL_OPPORTUNITY: ليس عاجلًا بالضرورة لكنه فكرة تحريرية جديدة ومفيدة (تقرير/تحقيق/استطلاع/مسح منشور حديثًا، " +
  "بيانات/إحصاءات جديدة، تحليل اتجاه، ظاهرة جديدة، بحث جديد في النوم/الرياضة/التغذية/الصحة النفسية/الشيخوخة). " +
  "لا تجعله منخفضًا تلقائيًا؛ قد يكون «مهمًا» دون عجلة. " +
  "EVERGREEN_GENERIC: معلومة صحية مفيدة دون أي حدث/دليل/تقرير/نتيجة/بيانات جديدة (نصائح عامة، قوائم، مقالات شرح " +
  "روتينية) → دائمًا منخفض.\n" +
  "الخطوة 3 — الدرجة والأولوية 0-100 تعكس معًا الأهمية والقيمة التحريرية لسلمى.\n" +
  "VERY_IMPORTANT (75-100) انتقائي جدًا وطبقة صغيرة عالية الثقة: فقط للتطورات التي يريد المحرّر رؤيتها فورًا أعلى " +
  "الرادار — تفشٍّ/طارئ صحة عامة كبير، موافقة/سحب/تحذير دواء أو جهاز كبير، نتيجة تجربة سريرية أو علمية كبرى بأثر صحي، " +
  "تنظيم/سياسة صحية مهمة، تغيير كبير في نظام صحي، استحواذ/استثمار كبير، تطوّر تقني/ذكاء اصطناعي طبي كبير، تطوّر صحي " +
  "كبير في الكويت/الخليج، بيانات/تقرير رسمي بأثر صحي كبير، تحقيق قوي بعواقب كبيرة، اتجاه صحي يمسّ شريحة واسعة.\n" +
  "بوابة VERY_IMPORTANT الإلزامية: درجة ≥75 وحدها لا تكفي إطلاقًا لجعل الخبر VERY_IMPORTANT. لكي يكون VERY_IMPORTANT " +
  "يجب أن يوجد أيضًا سبب كبير/نظامي واضح من هذه القائمة: تفشٍّ/طارئ صحة عامة كبير؛ موافقة/سحب/تحذير سلامة كبير لدواء " +
  "أو جهاز؛ نتيجة تجربة سريرية/علمية كبرى بأثر صحي حقيقي؛ تنظيم/سياسة صحية مهمة؛ تغيير كبير في نظام صحي؛ " +
  "استحواذ/استثمار كبير في الدواء/التقنية الحيوية/المستشفيات؛ تطوّر كبير في الذكاء الاصطناعي/التقنية الطبية؛ تطوّر " +
  "صحي كبير في الكويت/الخليج؛ تقرير/بيانات رسمية كبرى بعواقب واسعة؛ تحقيق كبير بآثار صحة عامة/نظام صحي مهمة؛ اتجاه " +
  "صحي على مستوى السكان.\n" +
  "سقوف صريحة على الدرجة (لا تتجاوزها إطلاقًا ما لم توجد دلالة وطنية/نظامية حقيقية): خدمة رعاية محلية روتينية → مهم " +
  "كحد أقصى (أقل من 75)؛ دخول مستشفى/إصابة معزولة → منخفض ما لم توجد زاوية نظامية/صحة عامة؛ صحة مشاهير/رياضيين → " +
  "منخفض ما لم تكن ذات صلة صحة عامة كبرى؛ شرح/نصائح عامة → منخفض؛ فرصة تحريرية نمط حياة عادية → مهم كحد أقصى؛ قافلة " +
  "طبية/إجراء عدة عمليات/خدمة محلية جديدة → مهم كحد أقصى ما لم تكن ذات دلالة وطنية/نظامية؛ جريمة معزولة تخص أطباء/" +
  "مستشفيات → منخفض؛ واقعة تسمم غذائي معزولة → منخفض ما لم تكن تفشيًا/بحجم نظامي.\n" +
  "لا تجعل الخبر VERY_IMPORTANT لمجرد: دخول شخص المستشفى، وفاة في حادث عادي، حادثة قرب/داخل مستشفى، مرض مشاهير/رياضيين، " +
  "تسمّم غذائي في واقعة معزولة، أو لأن العنوان يبدو دراميًا. المعيار: الحجم والعواقب والجدّة والمرجعية والدلالة " +
  "التحريرية. عند التردد بين VERY_IMPORTANT و«مهم» اختر «مهم» دائمًا.\n" +
  "حوادث الطرق، الجرائم الفردية، الإصابات المعزولة، دخول المستشفى المعزول، أخبار/شائعات المشاهير، تقيّؤ/إصابات " +
  "الرياضيين البسيطة، الشكاوى الغذائية المعزولة، و«دخل X المستشفى» بلا دلالة صحة عامة → NOT_RELEVANT أو منخفض ما لم " +
  "توجد زاوية صحة عامة أوسع. أمثلة: مشهور لا يستطيع النوم → منخفض؛ دراسة عن أثر واسع للنوم → قد تكون مهمة. " +
  "11 شخصًا دخلوا المستشفى بسبب كعكة ملوّثة واحدة → منخفض عادةً؛ تفشٍّ غذائي وطني يصيب المئات/الآلاف → قد يكون " +
  "VERY_IMPORTANT. الفرق: دلالة نظامية/صحة عامة مقابل واقعة معزولة.\n" +
  "75-100 = مهم جدًا، 50-74 = مهم، أقل من 50 = منخفض. NOT_RELEVANT و EVERGREEN_GENERIC أقل من 50 دائمًا.\n" +
  "القسم المتوقّع — أعطِ الأولوية للطبيعة الموضوعية أولًا: dawi-news (عن منصة داوي فقط)، investigations (تحقيق " +
  "استقصائي معمّق)، health-economy (أعمال/اقتصاد الدواء والتقنية الحيوية والمستشفيات والاستحواذات والتنظيم كصناعة)، " +
  "lifestyle (تغذية، لياقة، نوم، صحة نفسية، حياة صحية). وإلا فالجغرافيا حسب موقع الموضوع الأساسي فعليًا:\n" +
  "kuwait = فقط عندما يكون الخبر أساسًا عن الكويت/الرعاية أو الصحة العامة الكويتية. لا تُخصّص kuwait بسبب اللغة " +
  "العربية أو موقع المصدر أو ذكر عابر.\n" +
  "gulf = فقط عندما يكون الخبر أساسًا عن السعودية أو الإمارات أو قطر أو البحرين أو عُمان أو الكويت في سياق خليجي " +
  "أوسع، أو تطوّر صحي على مستوى دول الخليج.\n" +
  "world = بقية الأخبار الصحية الجغرافية خارج الخليج (باكستان، مصر، تركيا، إيران، إندونيسيا، أوروبا…). لا تحوّلها إلى " +
  "kuwait/gulf. عند عدم اليقين في الجغرافيا اختر world ولا تخترع صلة خليجية. لا تستخدم اللغة كجغرافيا.\n" +
  'أعد فقط مصفوفة JSON صالحة، عنصر لكل مقال بنفس الأرقام المُعطاة: ' +
  '[{"i":<رقم>,"value":"<NEWSWORTHY_NEW_DEVELOPMENT|EDITORIAL_OPPORTUNITY|EVERGREEN_GENERIC|NOT_RELEVANT>",' +
  '"score":<0-100>,"category":"<slug>"}] دون أي نص آخر.';

// --- independent VERY_IMPORTANT verifier (second-stage precision gate) --------
// The primary classifier's 0-100 score is batch-context-dependent, so a routine
// story can look "very important" merely as the strongest item in its batch.
// Every PROVISIONAL very_important is re-checked ONE ARTICLE AT A TIME with this
// narrow, absolute (non-relative) question. The verifier can only CONFIRM or
// DEMOTE (→ important) — it never promotes. Multilingual reasoning from
// metadata; NO keyword lists.
const VI_POSITIVE_CODES = new Set([
  "MAJOR_OUTBREAK_PUBLIC_HEALTH_EMERGENCY",
  "MAJOR_DRUG_DEVICE_APPROVAL_RECALL_SAFETY",
  "MAJOR_CLINICAL_SCIENTIFIC_RESULT",
  "MAJOR_HEALTH_POLICY_REGULATION",
  "MAJOR_HEALTH_SYSTEM_CHANGE",
  "MAJOR_HEALTHCARE_MA_INVESTMENT",
  "MAJOR_MEDICAL_AI_TECH_DEVELOPMENT",
  "MAJOR_KUWAIT_GCC_HEALTH_DEVELOPMENT",
  "MAJOR_OFFICIAL_REPORT_DATA",
  "MAJOR_INVESTIGATION",
  "MAJOR_POPULATION_HEALTH_TREND",
]);

const VI_VERIFY_PROMPT =
  "أنت مدقّق تحريري صارم لطبقة «مهم جدًا» (VERY_IMPORTANT) في منصة أخبار صحية (سلمى). " +
  "تقيّم مقالًا واحدًا فقط بشكل مستقل تمامًا، دون مقارنته بأي أخبار أخرى، اعتمادًا على البيانات الوصفية المتاحة " +
  "(العنوان، المصدر، الدولة، اللغة، وقت النشر) وبأي لغة كانت. لا تختلق حقائق ولا تبحث في الويب.\n" +
  "السؤال الوحيد: هل يستحق هذا الخبر فعلًا طبقة «مهم جدًا» في سلمى؟\n" +
  "المعيار الحاسم: هل هو تطوّر كبير/نظامي ذو دلالة تحريرية واسعة، أم مجرد خبر صحي مفيد لكنه ليس من الطبقة العليا؟\n" +
  "أجب بنعم (very_important_eligible=true) فقط إذا كان تطورًا كبيرًا/نظاميًا حقيقيًا من هذه الأنواع، مع رمز السبب المطابق:\n" +
  "- MAJOR_OUTBREAK_PUBLIC_HEALTH_EMERGENCY: تفشٍّ كبير أو طارئ صحة عامة واسع.\n" +
  "- MAJOR_DRUG_DEVICE_APPROVAL_RECALL_SAFETY: موافقة/سحب/تحذير سلامة كبير لدواء أو جهاز.\n" +
  "- MAJOR_CLINICAL_SCIENTIFIC_RESULT: نتيجة سريرية/علمية كبرى بأثر صحي حقيقي.\n" +
  "- MAJOR_HEALTH_POLICY_REGULATION: سياسة/تنظيم صحي مهم على مستوى دولة/إقليم.\n" +
  "- MAJOR_HEALTH_SYSTEM_CHANGE: تغيير كبير في نظام صحي.\n" +
  "- MAJOR_HEALTHCARE_MA_INVESTMENT: استحواذ/استثمار كبير في الدواء/التقنية الحيوية/المستشفيات.\n" +
  "- MAJOR_MEDICAL_AI_TECH_DEVELOPMENT: تطوّر كبير في الذكاء الاصطناعي/التقنية الطبية.\n" +
  "- MAJOR_KUWAIT_GCC_HEALTH_DEVELOPMENT: تطوّر صحي كبير في الكويت أو دول الخليج.\n" +
  "- MAJOR_OFFICIAL_REPORT_DATA: تقرير/بيانات رسمية كبرى بعواقب واسعة.\n" +
  "- MAJOR_INVESTIGATION: تحقيق استقصائي كبير بآثار مهمة.\n" +
  "- MAJOR_POPULATION_HEALTH_TREND: اتجاه صحي على مستوى السكان.\n" +
  "أجب بلا (very_important_eligible=false) لما يلي وأمثاله: قافلة طبية محلية؛ إجراء عدة عمليات؛ عيادة/خدمة محلية " +
  "واحدة جديدة؛ برنامج محلي عادي؛ دخول مستشفى/إصابة معزولة؛ حادث/جريمة عادية؛ صحة مشاهير/رياضيين؛ شرح/نصائح عامة؛ " +
  "قائمة علامات تحذيرية؛ محتوى نمط حياة عادي؛ واقعة غذائية معزولة دون تفشٍّ/دلالة نظامية. " +
  "لهذه استخدم رمز سبب سلبي مناسبًا مثل: ROUTINE_LOCAL_SERVICE, SEVERAL_PROCEDURES, NEW_LOCAL_CLINIC_SERVICE, " +
  "ORDINARY_LOCAL_PROGRAM, ISOLATED_HOSPITALIZATION_INJURY, ORDINARY_ACCIDENT_CRIME, CELEBRITY_ATHLETE_HEALTH, " +
  "GENERIC_EXPLAINER_ADVICE, WARNING_SIGN_LISTICLE, ORDINARY_LIFESTYLE, ISOLATED_FOOD_INCIDENT, NOT_TOP_TIER.\n" +
  "عند عدم اليقين، أجب false (رمز UNCERTAIN). كن انتقائيًا جدًا: الطبقة العليا يجب أن تكون واضحة تحريريًا وليست مجرد " +
  "أقوى عنصر في دفعته.\n" +
  'أعد فقط كائن JSON واحدًا صالحًا دون أي نص آخر بالشكل: ' +
  '{"very_important_eligible": <true|false>, "reason_code": "<CODE>", "reason": "<جملة قصيرة>"}';

type RadarRow = {
  id: string;
  title: string | null;
  url: string | null;
  source_title: string | null;
  source_domain: string | null;
  language: string | null;
  country: string | null;
  published_at: string | null;
  first_seen_at: string;
};

type ContentRow = {
  id: string;
  title: string | null;
  original_title: string | null;
  dedupe_key: string | null;
  original_url: string | null;
  published_at: string | null;
  created_at: string | null;
};

type Rank = { value: EditorialValue; score: number; category: string | null; level: PriorityLevel };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

Deno.serve(async (req) => {
  const startedAt = new Date();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
  const model = RANK_MODEL;

  if (!supabaseUrl || !serviceKey || !openrouterKey) {
    return new Response(
      JSON.stringify({ error: "Missing Supabase service env or OPENROUTER_API_KEY" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const trigger = req.method === "POST" ? "manual" : "manual";
  const supabase = createClient(supabaseUrl, serviceKey);

  // Usage accumulators (reported in radar_rank_runs).
  const usage = { prompt: 0, completion: 0, total: 0, cost: 0 };
  let calls = 0;

  // Single batched OpenRouter classify with a short transient-retry loop.
  async function classify(items: RadarRow[]): Promise<Map<string, Rank>> {
    const lines = items.map((a, j) =>
      `${j}. [${a.language ?? "?"}|${a.country ?? "?"}] ${a.source_title ?? a.source_domain ?? "?"} — ${a.title ?? ""}`,
    ).join("\n");
    let parsed: { i: number; value: string; score: number; category: string }[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      calls++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      let json: {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
        error?: { message?: string };
      };
      try {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${openrouterKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: `صنّف هذه المقالات:\n${lines}` },
            ],
          }),
          signal: ctrl.signal,
        });
        json = await res.json();
      } catch {
        continue; // network / abort → retry
      } finally {
        clearTimeout(timer);
      }
      if (json.usage) {
        usage.prompt += json.usage.prompt_tokens ?? 0;
        usage.completion += json.usage.completion_tokens ?? 0;
        usage.total += json.usage.total_tokens ?? 0;
        usage.cost += json.usage.cost ?? 0;
      }
      const raw = json.choices?.[0]?.message?.content ?? "";
      if (json.error || !raw) continue;
      try {
        const s = raw.indexOf("["); const e = raw.lastIndexOf("]");
        parsed = JSON.parse(raw.slice(s, e + 1));
        break;
      } catch {
        parsed = []; // malformed → retry
      }
    }
    const out = new Map<string, Rank>();
    for (const p of parsed) {
      const a = items[p.i];
      if (!a) continue;
      const value = String(p.value ?? "").toLowerCase() as EditorialValue;
      if (!VALID_EV.includes(value)) continue;
      const score = Math.max(0, Math.min(100, Math.round(Number(p.score))));
      if (Number.isNaN(score)) continue;
      const rawCategory = VALID_CATEGORIES.includes(p.category) ? p.category : null;
      const category = geoGuard(rawCategory, a.title, a.country);
      out.set(a.id, { value, score, category, level: levelFor(value, score) });
    }
    return out;
  }

  // Independent second-stage VI check for ONE article. Returns:
  //   true  → confirmed VERY_IMPORTANT (eligible with an allowed positive code)
  //   false → not eligible → caller demotes to important
  //   null  → no valid verdict after retries → caller keeps it UNRANKED (retry)
  async function verifyVeryImportant(a: RadarRow): Promise<boolean | null> {
    const meta =
      `العنوان: ${a.title ?? ""}\n` +
      `المصدر: ${a.source_title ?? a.source_domain ?? "?"}\n` +
      `الدولة: ${a.country ?? "?"}\n` +
      `اللغة: ${a.language ?? "?"}\n` +
      `وقت النشر: ${a.published_at ?? "?"}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      calls++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      let json: {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
        error?: { message?: string };
      };
      try {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${openrouterKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: "system", content: VI_VERIFY_PROMPT },
              { role: "user", content: `قيّم هذا المقال:\n${meta}` },
            ],
          }),
          signal: ctrl.signal,
        });
        json = await res.json();
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (json.usage) {
        usage.prompt += json.usage.prompt_tokens ?? 0;
        usage.completion += json.usage.completion_tokens ?? 0;
        usage.total += json.usage.total_tokens ?? 0;
        usage.cost += json.usage.cost ?? 0;
      }
      const raw = json.choices?.[0]?.message?.content ?? "";
      if (json.error || !raw) continue;
      try {
        const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
        const obj = JSON.parse(raw.slice(s, e + 1));
        const eligible = obj.very_important_eligible === true;
        const code = String(obj.reason_code ?? "");
        // TRUE requires BOTH an affirmative flag AND an allowed major/systemic code.
        return eligible && VI_POSITIVE_CODES.has(code);
      } catch {
        // malformed → retry
      }
    }
    return null;
  }

  let attemptedCount = 0;
  let rankedCount = 0;
  let retryCount = 0;
  let unrankedErrorCount = 0;
  let viDemotedCount = 0; // provisional very_important → important by the VI verifier
  const dupCounts = { new: 0, already: 0, possible: 0 };
  let status = "success";
  let errorMsg: string | null = null;

  try {
    // 1) Pull ONLY rows needing ranking (never-ranked or prior error), newest
    //    first (matches the radar_shadow_articles_needs_rank_idx partial index).
    const { data: radarData, error: radarErr } = await supabase
      .from("radar_shadow_articles")
      .select("id,title,url,source_title,source_domain,language,country,published_at,first_seen_at")
      .is("ranked_at", null)
      .order("first_seen_at", { ascending: false })
      .limit(MAX_PER_RUN);
    if (radarErr) throw radarErr;
    const radar = (radarData ?? []) as RadarRow[];
    attemptedCount = radar.length;

    if (radar.length === 0) {
      await supabase.from("radar_rank_runs").insert({
        trigger, status: "success", started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(), attempted_count: 0, ranked_count: 0,
        model, duration_ms: Date.now() - startedAt.getTime(),
      });
      return new Response(JSON.stringify({ ok: true, mode: "rank", attempted: 0, ranked: 0 }, null, 2),
        { headers: { "Content-Type": "application/json" } });
    }

    // 2) Deterministic duplicate detection vs Salma content (NO LLM).
    const { data: contentData, error: contentErr } = await supabase
      .from("content")
      .select("id,title,original_title,dedupe_key,original_url,published_at,created_at")
      .is("deleted_at", null);
    if (contentErr) throw contentErr;
    const content = (contentData ?? []) as ContentRow[];

    const byKey = new Map<string, ContentRow>();
    for (const c of content) {
      if (c.dedupe_key) byKey.set(c.dedupe_key, c);
      const k2 = dedupeKeyFromUrl(c.original_url);
      if (k2 && !byKey.has(k2)) byKey.set(k2, c);
    }
    const cutoff = Date.now() - DEDUPE_WINDOW_MS;
    const recentContent = content.filter((c) => {
      const t = Date.parse(c.published_at ?? c.created_at ?? "");
      return Number.isNaN(t) ? true : t >= cutoff;
    });

    type Dupe = { status: "new" | "already_in_salma" | "possible_duplicate"; matched: string | null };
    const dupeOf = new Map<string, Dupe>();
    for (const a of radar) {
      const k = dedupeKeyFromUrl(a.url);
      if (k && byKey.has(k)) {
        dupeOf.set(a.id, { status: "already_in_salma", matched: byKey.get(k)!.id });
        continue;
      }
      let best = 0;
      let bestId: string | null = null;
      const at = a.title ?? "";
      for (const c of recentContent) {
        const combined = `${c.title ?? ""} ${c.original_title ?? ""}`;
        if (numericConflict(at, combined)) continue;
        const s = Math.max(
          similarity(at, c.title ?? ""),
          c.original_title ? similarity(at, c.original_title) : 0,
        );
        if (s > best) { best = s; bestId = c.id; }
      }
      if (best >= DUPLICATE_TITLE_THRESHOLD) dupeOf.set(a.id, { status: "already_in_salma", matched: bestId });
      else if (best >= POSSIBLE_DUPLICATE_FLOOR) dupeOf.set(a.id, { status: "possible_duplicate", matched: bestId });
      else dupeOf.set(a.id, { status: "new", matched: null });
    }

    // 3) Complete-ranking driver: primary batch, then smaller retry batches over
    //    ONLY the still-missing rows (max two extra passes). Unresolved rows are
    //    left as UNRANKED_ERROR — never silently demoted.
    const rankOf = new Map<string, Rank>();
    const apply = (m: Map<string, Rank>) => { for (const [id, r] of m) rankOf.set(id, r); };
    for (const b of chunk(radar, PRIMARY_BATCH)) { apply(await classify(b)); await sleep(300); }
    let missing = radar.filter((a) => !rankOf.has(a.id));
    for (const size of RETRY_BATCHES) {
      if (missing.length === 0) break;
      retryCount += missing.length;
      for (const b of chunk(missing, size)) { apply(await classify(b)); await sleep(300); }
      missing = radar.filter((a) => !rankOf.has(a.id));
    }

    // 3b) Independent VI verification. ONLY provisional very_important rows are
    //     re-checked, ONE ARTICLE PER REQUEST (absolute, non-relative). true →
    //     stays very_important; false → demote to important; null (no verdict
    //     after retries) → leave the row UNRANKED so it is retried next cycle.
    const byId = new Map(radar.map((a) => [a.id, a]));
    const viVerdict = new Map<string, boolean | null>();
    for (const [id, r] of rankOf) {
      if (r.level !== "very_important") continue;
      const verdict = await verifyVeryImportant(byId.get(id)!);
      viVerdict.set(id, verdict);
      await sleep(200);
    }

    // 4) Persist per-article results. Success writes all fields + ranked_at and
    //    clears rank_error. Failure sets rank_error + increments rank_attempts
    //    and LEAVES ranked_at NULL so the row is retried next cycle.
    const nowIso = new Date().toISOString();
    for (const a of radar) {
      let r = rankOf.get(a.id);
      const d = dupeOf.get(a.id)!;
      if (d.status === "new") dupCounts.new++;
      else if (d.status === "already_in_salma") dupCounts.already++;
      else dupCounts.possible++;

      // Apply the independent VI verdict to the provisional level. A null verdict
      // (verifier could not decide) drops the row to the UNRANKED/retry path
      // rather than silently confirming or demoting it.
      if (r && r.level === "very_important") {
        const verdict = viVerdict.get(a.id);
        if (verdict === null) {
          r = undefined; // route to UNRANKED (retryable) below
        } else if (verdict === false) {
          viDemotedCount++;
          r = { ...r, level: "important" };
        }
      }

      if (r) {
        const { error: upErr } = await supabase
          .from("radar_shadow_articles")
          .update({
            priority_score: r.score,
            priority_level: r.level,
            editorial_value: r.value,
            expected_category_slug: r.category,
            duplicate_status: d.status,
            matched_content_id: d.matched,
            ranked_at: nowIso,
            rank_error: null,
            rank_attempts: 1,
          })
          .eq("id", a.id);
        if (upErr) throw upErr;
        rankedCount++;
      } else {
        // Deterministic dupe status is still stored on an UNRANKED_ERROR row so
        // the editor sees dedupe awareness; ranking fields stay null/retryable.
        unrankedErrorCount++;
        // Increment attempts without clobbering the prior value.
        const { data: cur } = await supabase
          .from("radar_shadow_articles")
          .select("rank_attempts")
          .eq("id", a.id)
          .single();
        const attempts = ((cur?.rank_attempts as number | null) ?? 0) + 1;
        const { error: upErr } = await supabase
          .from("radar_shadow_articles")
          .update({
            duplicate_status: d.status,
            matched_content_id: d.matched,
            rank_error: "ranking_incomplete_after_retries",
            rank_attempts: attempts,
          })
          .eq("id", a.id);
        if (upErr) throw upErr;
      }
    }
  } catch (e) {
    status = "failure";
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  // 5) One diagnostics row per run.
  await supabase.from("radar_rank_runs").insert({
    trigger,
    status,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    attempted_count: attemptedCount,
    ranked_count: rankedCount,
    retry_count: retryCount,
    unranked_error_count: unrankedErrorCount,
    duplicate_new_count: dupCounts.new,
    duplicate_already_count: dupCounts.already,
    duplicate_possible_count: dupCounts.possible,
    model,
    openrouter_calls: calls,
    prompt_tokens: usage.prompt,
    completion_tokens: usage.completion,
    total_tokens: usage.total,
    cost: usage.cost,
    duration_ms: Date.now() - startedAt.getTime(),
    error: errorMsg,
  });

  return new Response(JSON.stringify({
    ok: status === "success",
    mode: "rank",
    status,
    attempted: attemptedCount,
    ranked: rankedCount,
    unranked_error: unrankedErrorCount,
    retry_count: retryCount,
    vi_demoted: viDemotedCount,
    duplicates: dupCounts,
    model,
    calls,
    cost: usage.cost,
    error: errorMsg,
  }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
});
