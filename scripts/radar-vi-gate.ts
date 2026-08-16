// VERY_IMPORTANT eligibility-gate validation (LOCAL, READ-ONLY, NON-DESTRUCTIVE).
//
// Re-classifies ONLY the prior run's VERY_IMPORTANT candidates plus a sample of
// prior IMPORTANT stories, using the updated gated prompt (imported from
// radar-eval.ts — single source of truth). This measures the effect of the
// strict VI eligibility gate WITHOUT re-running the whole 292-article corpus.
// It never writes to the database.
//
// Run: OPENROUTER_MODEL="openai/gpt-4o-mini" node --experimental-strip-types scripts/radar-vi-gate.ts
//
// NOTE: importing radar-eval.ts also loads .env.local into process.env and does
// NOT execute its main() (guarded by an entry-point check).

import { createClient } from "@supabase/supabase-js";
import { createClassifier, chunk, sleep, type RadarRow, type Rank } from "./radar-eval.ts";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

// Distinctive title substrings identifying the prior (v3) run's candidates.
// 23 prior VERY_IMPORTANT + 12 prior IMPORTANT (editorial-opportunity sample).
const PRIOR_VI: string[] = [
  "expands local production of medicines",
  "الخاص بصحة المنافذ في عدن",
  "انتحلا صفة أطباء جلدية",
  "Drug rehab center to be built in Lalmonirhat",
  "بازسازی مفاصل فرسوده",
  "Sốt xuất huyết vào mùa cao điểm",
  "trẻ thừa cân, béo phì",
  "zerar acidentes com caminhões",
  "ιό του Δυτικού Νείλου στην Αττική",
  "Perluas Layanan Kesehatan Gratis",
  "Νευρική ανορεξία",
  "Pregnant Woman's 2 Warning Signs",
  "甲狀腺結節不一定要開刀",
  "3 عمليات تركيب منظمات قلب",
  "IPH has eliminated delays",
  "قافلة طبية مجانية بالقنطرة غرب",
  "AI Could Ease Doctor Workload",
  "Taiwan doctor links urban pollution",
  "cel mai mare risc de cancer la sân",
  "espiral de la muerte",
  "simptomi koji se mogu pojaviti 24 sata",
  "شتاب‌دهنده خطی در سیستان",
  "y, dược cổ truyền",
];
const PRIOR_IMPORTANT: string[] = [
  "nurseries' role in family stability",
  "برای کبد چرب چه بخوریم",
  "വൃത്തിയില്ലാത്ത ബെഡ്ഷീറ്റുകൾ",
  "Copacii bătrâni ar putea proteja",
  "How She Lost 20 Kg",
  "first ketamine therapy practice",
  "Médicos de Urgencias en Ceuta",
  "محافظ السويس يتفقد جامعة الجلالة",
  "تحدي اللياقة بأكاديمية دبي",
  "Tomaten eten kan levervet verminderen",
  "first-night effect",
  "Fit India Sundays on Cycle",
];

type Prior = "very_important" | "important";
type Matcher = { sub: string; prior: Prior };

async function main() {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data } = await sb
    .from("radar_shadow_articles")
    .select("id,title,url,source_title,source_domain,language,country,published_at,first_seen_at")
    .order("first_seen_at", { ascending: false });
  const radar = (data ?? []) as RadarRow[];

  const matchers: Matcher[] = [
    ...PRIOR_VI.map((sub) => ({ sub, prior: "very_important" as Prior })),
    ...PRIOR_IMPORTANT.map((sub) => ({ sub, prior: "important" as Prior })),
  ];

  // Resolve each matcher to exactly one radar row (first title that contains it).
  const candidates: { a: RadarRow; prior: Prior; sub: string }[] = [];
  const unmatched: Matcher[] = [];
  for (const m of matchers) {
    const a = radar.find((r) => (r.title ?? "").includes(m.sub));
    if (a) candidates.push({ a, prior: m.prior, sub: m.sub });
    else unmatched.push(m);
  }
  const priorOf = new Map(candidates.map((c) => [c.a.id, c.prior]));
  const items = candidates.map((c) => c.a);

  // Re-classify the candidate set with the gated prompt.
  const clf = createClassifier(MODEL);
  const rankOf = new Map<string, Rank>();
  const apply = (map: Map<string, Rank>) => { for (const [id, r] of map) rankOf.set(id, r); };
  for (const b of chunk(items, 12)) { apply(await clf.classify(b)); await sleep(300); }
  let missing = items.filter((a) => !rankOf.has(a.id));
  for (const size of [6, 3]) {
    if (missing.length === 0) break;
    for (const b of chunk(missing, size)) { apply(await clf.classify(b)); await sleep(300); }
    missing = items.filter((a) => !rankOf.has(a.id));
  }

  const priorVI = candidates.filter((c) => c.prior === "very_important");
  const priorIMP = candidates.filter((c) => c.prior === "important");
  const newVI = candidates.filter((c) => rankOf.get(c.a.id)?.level === "very_important");
  const demotedVI = priorVI.filter((c) => rankOf.get(c.a.id)?.level !== "very_important");
  const promotedIMP = priorIMP.filter((c) => rankOf.get(c.a.id)?.level === "very_important");

  const fmt = (a: RadarRow, r?: Rank) =>
    r
      ? `[${r.score} ${r.level}/${r.value} · ${r.category ?? "?"}] (${a.language}|${a.country}) ${a.source_title} — ${a.title}`
      : `[UNRANKED_ERROR] (${a.language}|${a.country}) ${a.source_title} — ${a.title}`;

  console.log("\n===== VERY_IMPORTANT GATE VALIDATION (focused · in-memory · no writes) =====");
  console.log("model:", MODEL, "| additional_llm_calls:", clf.calls);
  console.log(
    `candidates matched: ${candidates.length}/${matchers.length}`,
    `(VI ${priorVI.length}/${PRIOR_VI.length}, IMPORTANT ${priorIMP.length}/${PRIOR_IMPORTANT.length})`,
  );
  if (unmatched.length) {
    console.log(`  UNMATCHED matchers (${unmatched.length}) — not found in current corpus:`);
    for (const m of unmatched) console.log(`   [${m.prior}] "${m.sub}"`);
  }
  if (missing.length) {
    console.log(`  UNRANKED_ERROR after retries (${missing.length}) — visible, not silently demoted:`);
    for (const a of missing) console.log(`   ${fmt(a)}`);
  }

  console.log(`\n(1) PREVIOUS VERY_IMPORTANT count: ${priorVI.length}`);
  console.log(`(2) NEW VERY_IMPORTANT count: ${newVI.length}`);

  console.log(`\n(3) ALL FINAL VERY_IMPORTANT HEADLINES (${newVI.length}) ---`);
  for (const c of newVI) console.log(fmt(c.a, rankOf.get(c.a.id)));

  console.log(`\n(4) PREVIOUS VI DEMOTED (${demotedVI.length}) — new label + why ---`);
  for (const c of demotedVI) console.log(fmt(c.a, rankOf.get(c.a.id)));

  console.log(`\n(5) IMPORTANT PROMOTED TO VI (${promotedIMP.length}) ---`);
  for (const c of promotedIMP) console.log(fmt(c.a, rankOf.get(c.a.id)));
  console.log("  (prior IMPORTANT sample, for reference — final labels:)");
  for (const c of priorIMP) console.log(`   ${fmt(c.a, rankOf.get(c.a.id))}`);

  // Remaining suspicious VI: still-VI items whose metadata reads as routine
  // local service / explainer / single-procedure rather than a major event.
  const SUSPICIOUS_RE =
    /caravan|قافلة|عمليات تركيب|منظمات قلب|rehab center|warning signs|simptomi|symptoms|workload|nurseries|expands local production|صحة المنافذ|اجتماع|انتحل/i;
  const suspiciousVI = newVI.filter((c) => SUSPICIOUS_RE.test(c.a.title ?? ""));
  console.log(`\n(6) REMAINING SUSPICIOUS VI (${suspiciousVI.length}) — routine/explainer still flagged VI ---`);
  for (const c of suspiciousVI) console.log(fmt(c.a, rankOf.get(c.a.id)));

  console.log(`\n(7) ADDITIONAL LLM CALLS / TOKENS / COST:`);
  console.log(`  model=${MODEL} | calls=${clf.calls}`);
  console.log(`  tokens: prompt=${clf.usage.prompt} completion=${clf.usage.completion} total=${clf.usage.total}`);
  console.log(`  additional_cost_usd=${clf.usage.cost.toFixed(6)}`);
  console.log(`  geo_guard_corrections(in candidate set)=${clf.geoFixes.length}`);

  console.log(`\n(8) RECOMMENDATION: see summary after eyeballing (3) and (6).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
