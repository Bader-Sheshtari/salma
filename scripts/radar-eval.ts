// Fast News Radar — SHADOW MODE evaluation (LOCAL, READ-ONLY, NON-DESTRUCTIVE).
//
// Reads the currently-collected radar_shadow_articles + Salma content, runs:
//   (1) deterministic duplicate detection (reusing ingest-news dedupe helpers)
//   (2) batched OpenRouter ranking + expected-category classification
// entirely IN MEMORY and prints a report. It never writes to the database and
// never calls the Salma pipeline.
//
// Run: node --experimental-strip-types scripts/radar-eval.ts
//
// NOTE: this is a one-off pre-deploy experiment, not the production ranker.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { similarity, numericConflict } from "../supabase/functions/ingest-news/dedupe.ts";
import { levelFromScore, type RadarPriorityLevel } from "../src/lib/radar.ts";

// --- env (parse .env.local; do not print secrets) ---------------------------
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY!;
const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-oss-20b:free";

const VALID_CATEGORIES = [
  "kuwait", "gulf", "world", "health-economy", "lifestyle", "investigations", "dawi-news",
];

// --- deterministic geographic sanity guard ----------------------------------
// Tiny post-classification check for the GEOGRAPHIC categories ONLY. If the
// model assigns `kuwait` / `gulf` but the available title/country metadata
// clearly contradicts it, fall back to `world`. Thematic categories
// (health-economy/lifestyle/investigations/dawi-news) and `world` are left
// untouched. This is NOT geolocation — just a cheap contradiction check on the
// metadata we already have. Language is never used as geography.
const GCC_COUNTRIES = new Set([
  "Kuwait", "Saudi Arabia", "United Arab Emirates", "UAE", "Qatar", "Bahrain", "Oman",
]);
// Countries that must never be re-badged as Kuwait/Gulf.
const NON_GCC_COUNTRIES = new Set([
  "Pakistan", "Egypt", "Türkiye", "Turkey", "Iran", "Indonesia", "India", "United States",
  "United Kingdom", "France", "Germany", "China", "Russia", "Nigeria", "Bangladesh",
  "Brazil", "Canada", "Australia", "Spain", "Italy", "Japan", "Israel", "Lebanon",
  "Syria", "Jordan", "Iraq", "Yemen", "Morocco", "Algeria", "Tunisia", "Sudan",
]);
const KUWAIT_RE = /kuwait|الكويت|كويتي/i;
const GCC_RE =
  /kuwait|saudi|riyadh|jeddah|\bksa\b|emirat|\buae\b|dubai|abu dhabi|abudhabi|qatar|doha|bahrain|manama|\boman\b|muscat|gulf|\bgcc\b|khaleej|الكويت|السعودي|الإمارات|الامارات|قطر|البحرين|عُمان|عمان|الخليج|خليجي/i;

// Returns { category, changed } — category possibly corrected to "world".
function geoGuard(
  category: string | null,
  title: string | null,
  country: string | null,
): { category: string | null; changed: boolean } {
  if (category !== "kuwait" && category !== "gulf") return { category, changed: false };
  const t = title ?? "";
  const c = country ?? "";
  if (category === "kuwait") {
    const ok = c === "Kuwait" || KUWAIT_RE.test(t);
    // Explicitly non-GCC country with no Kuwait mention in the title → wrong.
    if (ok && !(NON_GCC_COUNTRIES.has(c) && !KUWAIT_RE.test(t))) return { category, changed: false };
    return { category: "world", changed: true };
  }
  // gulf
  const okG = GCC_COUNTRIES.has(c) || GCC_RE.test(t);
  if (okG && !(NON_GCC_COUNTRIES.has(c) && !GCC_RE.test(t))) return { category, changed: false };
  return { category: "world", changed: true };
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

type ContentRow = {
  id: string; title: string | null; original_title: string | null;
  dedupe_key: string | null; original_url: string | null;
  published_at: string | null; created_at: string | null;
};
export type RadarRow = {
  id: string; title: string | null; url: string | null;
  source_title: string | null; source_domain: string | null;
  language: string | null; country: string | null;
  published_at: string | null; first_seen_at: string;
};

// ---- Editorial-value + priority classification (shared machinery) ----------
// Two-stage model: (1) is it inside Salma's broad health universe? (2) what is
// its editorial nature? Priority then reflects BOTH significance and real
// relevance to Salma — world importance alone does not create Radar priority.
export type EditorialValue =
  | "newsworthy_new_development"
  | "editorial_opportunity"
  | "evergreen_generic"
  | "not_relevant";
export const VALID_EV: EditorialValue[] = [
  "newsworthy_new_development", "editorial_opportunity", "evergreen_generic", "not_relevant",
];
export type Rank = { value: EditorialValue; score: number; category: string | null; level: RadarPriorityLevel };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// EVERGREEN_GENERIC and NOT_RELEVANT are forced to Low regardless of the model's
// score; the significance score only decides very/important WITHIN the
// newsworthy / opportunity buckets (75/50 thresholds).
export function levelFor(value: EditorialValue, score: number): RadarPriorityLevel {
  if (value === "not_relevant" || value === "evergreen_generic") return "low";
  return levelFromScore(score);
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export const SYSTEM_PROMPT =
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

export type GeoFix = { title: string | null; country: string | null; from: string };

// A stateful classifier bound to one model. Accumulates usage/calls/geoFixes so
// callers can report them. classify() returns a map keyed by article id for
// ONLY the items that came back with a valid, in-range result (transient
// network/provider/parse failures are retried a few times).
export function createClassifier(model: string) {
  const usage = { prompt: 0, completion: 0, total: 0, cost: 0 };
  const geoFixes: GeoFix[] = [];
  let calls = 0;

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
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
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
      const g = geoGuard(rawCategory, a.title, a.country);
      if (g.changed) geoFixes.push({ title: a.title, country: a.country, from: rawCategory! });
      out.set(a.id, { value, score, category: g.category, level: levelFor(value, score) });
    }
    return out;
  }

  return { classify, usage, geoFixes, get calls() { return calls; } };
}

async function main() {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: radarData } = await sb
    .from("radar_shadow_articles")
    .select("id,title,url,source_title,source_domain,language,country,published_at,first_seen_at")
    .order("first_seen_at", { ascending: false });
  const radar = (radarData ?? []) as RadarRow[];

  const { data: contentData } = await sb
    .from("content")
    .select("id,title,original_title,dedupe_key,original_url,published_at,created_at")
    .is("deleted_at", null);
  const content = (contentData ?? []) as ContentRow[];

  // ---- Deterministic dedupe (no LLM) ---------------------------------------
  const byKey = new Map<string, ContentRow>();
  for (const c of content) {
    if (c.dedupe_key) byKey.set(c.dedupe_key, c);
    const k2 = dedupeKeyFromUrl(c.original_url);
    if (k2 && !byKey.has(k2)) byKey.set(k2, c);
  }
  const contentById = new Map(content.map((c) => [c.id, c]));

  const WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - WINDOW_MS;
  const recentContent = content.filter((c) => {
    const t = Date.parse(c.published_at ?? c.created_at ?? "");
    return Number.isNaN(t) ? true : t >= cutoff;
  });

  type Dupe = { status: "new" | "already_in_salma" | "possible_duplicate"; matched: string | null; score: number };
  const dupeOf = new Map<string, Dupe>();
  for (const a of radar) {
    // Level 1: exact normalized URL / dedupe_key.
    const k = dedupeKeyFromUrl(a.url);
    if (k && byKey.has(k)) {
      dupeOf.set(a.id, { status: "already_in_salma", matched: byKey.get(k)!.id, score: 1 });
      continue;
    }
    // Level 3: strong recent title similarity (Arabic-aware, reused helpers).
    let best = 0;
    let bestId: string | null = null;
    const at = a.title ?? "";
    for (const c of recentContent) {
      const combined = `${c.title ?? ""} ${c.original_title ?? ""}`;
      if (numericConflict(at, combined)) continue; // disjoint figures → different story
      const s = Math.max(
        similarity(at, c.title ?? ""),
        c.original_title ? similarity(at, c.original_title) : 0,
      );
      if (s > best) { best = s; bestId = c.id; }
    }
    if (best >= 0.72) dupeOf.set(a.id, { status: "already_in_salma", matched: bestId, score: best });
    else if (best >= 0.6) dupeOf.set(a.id, { status: "possible_duplicate", matched: bestId, score: best });
    else dupeOf.set(a.id, { status: "new", matched: null, score: best });
  }

  // ---- Editorial-value + priority classification (shared classifier) -------
  const clf = createClassifier(MODEL);
  const rankOf = new Map<string, Rank>();
  const unrankedError = new Set<string>();
  const apply = (m: Map<string, Rank>) => { for (const [id, r] of m) rankOf.set(id, r); };

  // Complete-ranking reliability: primary pass (batch 12), then up to TWO extra
  // passes over ONLY the still-missing articles in smaller batches. Anything
  // still unresolved is marked UNRANKED_ERROR — never silently demoted to Low.
  for (const b of chunk(radar, 12)) { apply(await clf.classify(b)); await sleep(300); }
  let missing = radar.filter((a) => !rankOf.has(a.id));
  console.error(`primary pass: ${rankOf.size}/${radar.length} ranked, ${missing.length} missing`);
  for (const size of [6, 3]) {
    if (missing.length === 0) break;
    for (const b of chunk(missing, size)) { apply(await clf.classify(b)); await sleep(300); }
    missing = radar.filter((a) => !rankOf.has(a.id));
    console.error(`retry pass (batch ${size}): ${missing.length} still missing`);
  }
  for (const a of missing) unrankedError.add(a.id);
  const usage = clf.usage;
  const calls = clf.calls;
  const geoFixes = clf.geoFixes;

  // ---- Report --------------------------------------------------------------
  const ev = { newsworthy: 0, opportunity: 0, evergreen: 0, not_relevant: 0 };
  const lvl = { very: 0, important: 0, low: 0 };
  const dup = { isNew: 0, already: 0, possible: 0 };
  for (const a of radar) {
    const r = rankOf.get(a.id);
    if (r) {
      if (r.value === "newsworthy_new_development") ev.newsworthy++;
      else if (r.value === "editorial_opportunity") ev.opportunity++;
      else if (r.value === "evergreen_generic") ev.evergreen++;
      else ev.not_relevant++;
      if (r.level === "very_important") lvl.very++;
      else if (r.level === "important") lvl.important++;
      else lvl.low++;
    }
    const d = dupeOf.get(a.id)!;
    if (d.status === "new") dup.isNew++;
    else if (d.status === "already_in_salma") dup.already++;
    else dup.possible++;
  }

  type Row = { a: RadarRow; r?: Rank; d: Dupe };
  const withRank: Row[] = radar.map((a) => ({ a, r: rankOf.get(a.id), d: dupeOf.get(a.id)! }));
  const line = (a: RadarRow, r: Rank) =>
    `[${r.score} ${r.level}/${r.value} · ${r.category ?? "?"}] (${a.language}|${a.country}) ${a.source_title} — ${a.title}`;

  // Default Radar view: (Very Important + Important) AND NEW.
  const topDefaultNew = withRank
    .filter((x) => x.r && x.r.level !== "low" && x.d.status === "new")
    .sort((x, y) => y.r!.score - x.r!.score)
    .slice(0, 20);

  // Strong non-urgent opportunities that were correctly RETAINED (not dumped to Low).
  const strongOpportunities = withRank
    .filter((x) => x.r && x.r.value === "editorial_opportunity" && x.r.level !== "low")
    .sort((x, y) => y.r!.score - x.r!.score)
    .slice(0, 12);

  // Useful-but-evergreen health content correctly placed Low.
  const evergreenLow = withRank
    .filter((x) => x.r && x.r.value === "evergreen_generic")
    .sort((x, y) => y.r!.score - x.r!.score)
    .slice(0, 12);

  // Globally notable but non-health stories correctly demoted (highest-scored
  // NOT_RELEVANT first = the ones most likely to have been "big news").
  const notRelevantDemoted = withRank
    .filter((x) => x.r && x.r.value === "not_relevant")
    .sort((x, y) => y.r!.score - x.r!.score)
    .slice(0, 12);

  const veryList = withRank
    .filter((x) => x.r && x.r.level === "very_important")
    .sort((x, y) => y.r!.score - x.r!.score);

  // Suspicious surface: forced-low buckets that were scored high, or newsworthy
  // items with an out-of-place category — worth eyeballing.
  const suspicious = withRank.filter((x) =>
    x.r && (
      (x.r.value === "not_relevant" && x.r.score >= 50) ||
      (x.r.value === "evergreen_generic" && x.r.score >= 60)
    ));

  const already = withRank.filter((x) => x.d.status === "already_in_salma");
  const possible = withRank.filter((x) => x.d.status === "possible_duplicate");

  // Final geographic category distribution (after the deterministic guard).
  const geoDist = { kuwait: 0, gulf: 0, world: 0 };
  const kuwaitFinal = withRank.filter((x) => x.r?.category === "kuwait");
  const gulfFinal = withRank.filter((x) => x.r?.category === "gulf");
  for (const x of withRank) {
    if (x.r?.category === "kuwait") geoDist.kuwait++;
    else if (x.r?.category === "gulf") geoDist.gulf++;
    else if (x.r?.category === "world") geoDist.world++;
  }

  const ranked = rankOf.size;
  const pct = (n: number) => (ranked ? ((100 * n) / ranked).toFixed(1) : "0.0");

  console.log("\n===== RADAR EVAL v3 (final calibration · two-stage · in-memory · no writes) =====");

  // (1) total evaluated
  console.log(`(1) TOTAL EVALUATED: ${radar.length} radar articles (ranked ${ranked}, unranked_error ${unrankedError.size})`);
  // (2)-(5) editorial value counts
  console.log(`(2) NEWSWORTHY_NEW_DEVELOPMENT: ${ev.newsworthy}`);
  console.log(`(3) EDITORIAL_OPPORTUNITY:      ${ev.opportunity}`);
  console.log(`(4) EVERGREEN_GENERIC:          ${ev.evergreen}`);
  console.log(`(5) NOT_RELEVANT:               ${ev.not_relevant}`);
  // (6)-(8) priority counts + percentages (of ranked)
  console.log(`(6) VERY_IMPORTANT: ${lvl.very} (${pct(lvl.very)}%)`);
  console.log(`(7) IMPORTANT:      ${lvl.important} (${pct(lvl.important)}%)`);
  console.log(`(8) LOW:            ${lvl.low} (${pct(lvl.low)}%)`);
  // (9) unranked error
  console.log(`(9) UNRANKED_ERROR: ${unrankedError.size}`);
  console.log(`    GEO_DISTRIBUTION(final): ${JSON.stringify(geoDist)} | geo_guard_corrections: ${geoFixes.length}`);

  console.log(`\n(10) TOP 20 DEFAULT-VIEW STORIES (Very Important + Important, NEW) ---`);
  for (const x of topDefaultNew) console.log(line(x.a, x.r!));

  console.log(`\n(11) ALL VERY IMPORTANT HEADLINES (${veryList.length}) — eyeball each ---`);
  for (const x of veryList) console.log(line(x.a, x.r!));

  console.log(`\n(12) ORDINARY INCIDENTS / CELEBRITY CORRECTLY DEMOTED (${notRelevantDemoted.length}) — highest-scored NOT_RELEVANT ---`);
  for (const x of notRelevantDemoted) console.log(line(x.a, x.r!));

  console.log(`\n(13) STRONG NON-URGENT OPPORTUNITIES RETAINED as Important (${strongOpportunities.length}) ---`);
  for (const x of strongOpportunities) console.log(line(x.a, x.r!));

  console.log(`\n(14) EVERGREEN/GENERIC KEPT LOW (${evergreenLow.length}) ---`);
  for (const x of evergreenLow) console.log(line(x.a, x.r!));

  console.log(`\n(15) GEOGRAPHIC-CATEGORY REVIEW ---`);
  console.log(`  deterministic guard corrections (kuwait/gulf → world): ${geoFixes.length}`);
  for (const f of geoFixes) console.log(`   [${f.from}→world] (country=${f.country}) ${f.title}`);
  console.log(`  final KUWAIT assignments (${kuwaitFinal.length}) — verify each is truly Kuwait:`);
  for (const x of kuwaitFinal) console.log(`   (${x.a.language}|${x.a.country}) ${x.a.title}`);
  console.log(`  final GULF assignments (${gulfFinal.length}) — verify each is truly GCC:`);
  for (const x of gulfFinal) console.log(`   (${x.a.language}|${x.a.country}) ${x.a.title}`);

  console.log(`\n(16) DUPLICATE COUNTS: ${JSON.stringify(dup)}`);
  console.log(`  ALREADY_IN_SALMA (${already.length}):`);
  for (const x of already) {
    const c = x.d.matched ? contentById.get(x.d.matched) : null;
    console.log(`   sim=${x.d.score.toFixed(2)} RADAR: ${x.a.title}\n      SALMA: ${c?.title ?? x.d.matched}`);
  }
  console.log(`  POSSIBLE_DUPLICATE (${possible.length}) — review band 0.60-0.72:`);
  for (const x of possible) {
    const c = x.d.matched ? contentById.get(x.d.matched) : null;
    console.log(`   sim=${x.d.score.toFixed(2)} RADAR: ${x.a.title}\n      SALMA: ${c?.title ?? x.d.matched}`);
  }

  console.log(`\n(17) MODEL / CALLS / TOKENS / COST:`);
  console.log(`  model=${MODEL} | llm_calls=${calls}`);
  console.log(`  tokens: prompt=${usage.prompt} completion=${usage.completion} total=${usage.total}`);
  console.log(`  actual_cost_usd=${usage.cost.toFixed(6)}`);

  console.log(`\n(18) REMAINING SUSPICIOUS DECISIONS (${suspicious.length}) — forced-low scored high / odd calls ---`);
  for (const x of suspicious) console.log(line(x.a, x.r!));

  if (unrankedError.size > 0) {
    console.log(`\n    UNRANKED_ERROR DETAIL (${unrankedError.size}) — visible, NOT silently Low:`);
    for (const a of radar.filter((r) => unrankedError.has(r.id))) {
      console.log(`   (${a.language}|${a.country}) ${a.source_title} — ${a.title}`);
    }
  }
}

// Only run the full-corpus eval when invoked directly (not when imported by the
// focused VI-gate validation script).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
