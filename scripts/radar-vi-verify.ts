// Independent VERY_IMPORTANT verifier (LOCAL, READ-ONLY by default).
//
// Second-stage PRECISION gate. The primary radar-rank classifier's 0-100 score
// is batch-context-dependent, so a routine story can look "very important"
// merely because it is the strongest item in its batch. This verifier asks a
// SEPARATE, narrow yes/no question about ONE article at a time (no batch, no
// relative comparison) so the VERY_IMPORTANT decision is absolute.
//
// It ONLY evaluates the current production VERY_IMPORTANT candidates. It NEVER
// promotes; it can only confirm or demote VI → IMPORTANT. By default it writes
// nothing and just prints the report (pass --apply to persist the demotions,
// but only after the human has reviewed this report).
//
// Run (read-only):  node --experimental-strip-types scripts/radar-vi-verify.ts
// Run (apply):      node --experimental-strip-types scripts/radar-vi-verify.ts --apply

import { createClient } from "@supabase/supabase-js";
import { sleep, type RadarRow } from "./radar-eval.ts"; // importing loads .env.local; does not run main()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY!;
const MODEL = "openai/gpt-4o-mini"; // pinned, same family as primary classifier
const APPLY = process.argv.includes("--apply");

// Genuine major/systemic reasons (the ONLY grounds for a TRUE verdict).
const POSITIVE_CODES = new Set([
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

// The verifier reasons from metadata in ANY language (no keyword lists). It must
// answer the single narrow question and return a strict JSON object.
const VERIFY_PROMPT =
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

type Verdict = { eligible: boolean; code: string; reason: string };

const usage = { prompt: 0, completion: 0, total: 0, cost: 0 };
let calls = 0;

async function verifyOne(a: RadarRow): Promise<Verdict | null> {
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
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: VERIFY_PROMPT },
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
      const code = String(obj.reason_code ?? (eligible ? "UNSPECIFIED" : "NOT_TOP_TIER"));
      const reason = String(obj.reason ?? "");
      return { eligible, code, reason };
    } catch {
      // malformed → retry
    }
  }
  return null; // could not get a valid verdict after retries
}

async function main() {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  // ONLY the current production VERY_IMPORTANT candidates.
  const { data } = await sb
    .from("radar_shadow_articles")
    .select("id,title,url,source_title,source_domain,language,country,published_at,first_seen_at,priority_score")
    .eq("priority_level", "very_important")
    .order("priority_score", { ascending: false })
    .order("first_seen_at", { ascending: false });
  const candidates = (data ?? []) as (RadarRow & { priority_score: number | null })[];

  const results: { a: RadarRow & { priority_score: number | null }; v: Verdict | null }[] = [];
  for (const a of candidates) {
    const v = await verifyOne(a);
    results.push({ a, v });
    await sleep(200);
  }

  // A TRUE verdict must also carry an allowed positive reason code; otherwise it
  // is treated as not-eligible (defensive — the verdict is a precision gate).
  const isTrue = (v: Verdict | null) => !!v && v.eligible && POSITIVE_CODES.has(v.code);
  const kept = results.filter((r) => isTrue(r.v));
  const demoted = results.filter((r) => !isTrue(r.v));
  // Verdicts that could not be obtained at all → conservatively demote, flagged.
  const unresolved = results.filter((r) => r.v === null);
  // TRUE decisions worth eyeballing: metadata thin / country missing / reason weak.
  const suspicious = kept.filter((r) =>
    !r.a.country || (r.v!.reason ?? "").length < 8,
  );

  const hdr = (a: RadarRow & { priority_score: number | null }) =>
    `[${a.priority_score ?? "?"}] (${a.language}|${a.country ?? "—"}) ${a.source_title ?? a.source_domain} — ${a.title}`;

  console.log("\n===== INDEPENDENT VI VERIFIER (one-article-per-request · read-only) =====");
  console.log(`mode: ${APPLY ? "APPLY (will persist demotions)" : "READ-ONLY (no writes)"} | model: ${MODEL}`);

  console.log(`\n(1) CURRENT VI CANDIDATES: ${candidates.length}`);
  for (const r of results) console.log(`   ${hdr(r.a)}`);

  console.log(`\n(2) VERIFIER TRUE (kept VERY_IMPORTANT): ${kept.length}`);
  console.log(`(3) VERIFIER FALSE (demote → IMPORTANT): ${demoted.length}`);

  console.log(`\n(4) FINAL TRUE HEADLINES + reason code (${kept.length}) ---`);
  for (const r of kept) console.log(`   [${r.v!.code}] ${hdr(r.a)}\n        ↳ ${r.v!.reason}`);

  console.log(`\n(5) DEMOTED HEADLINES + concise reason (${demoted.length}) ---`);
  for (const r of demoted) {
    const code = r.v ? r.v.code : "NO_VERDICT";
    const reason = r.v ? r.v.reason : "verifier returned no valid verdict after retries";
    console.log(`   [${code}] ${hdr(r.a)}\n        ↳ ${reason}`);
  }

  console.log(`\n(6) SUSPICIOUS TRUE DECISIONS (${suspicious.length}) — thin metadata / weak reason ---`);
  for (const r of suspicious) console.log(`   [${r.v!.code}] ${hdr(r.a)}\n        ↳ ${r.v!.reason}`);
  if (unresolved.length) {
    console.log(`   NOTE: ${unresolved.length} candidate(s) got NO verifier verdict (conservatively demoted):`);
    for (const r of unresolved) console.log(`     ${hdr(r.a)}`);
  }

  console.log(`\n(7) VERIFIER API CALLS: ${calls} (candidates=${candidates.length}, incl. retries)`);
  console.log(`(8) TOKENS: prompt=${usage.prompt} completion=${usage.completion} total=${usage.total}`);
  console.log(`(9) ACTUAL COST (USD): ${usage.cost.toFixed(6)}`);

  const cleanVI = kept.length; // items surviving the independent gate
  console.log(`\n(10) RECOMMENDATION:`);
  console.log(`   after independent verification: VI ${candidates.length} → ${cleanVI} (demoted ${demoted.length})`);
  if (unresolved.length === 0 && suspicious.length === 0) {
    console.log(`   → READY_FOR_PRODUCTION (final VI layer is selective; wire verifier into radar-rank next).`);
  } else {
    console.log(`   → NOT_READY (review suspicious/unresolved items above before wiring).`);
  }

  if (APPLY) {
    let applied = 0;
    for (const r of demoted) {
      if (r.v === null) continue; // don't rewrite rows we couldn't verify
      const { error } = await sb
        .from("radar_shadow_articles")
        .update({ priority_level: "important" })
        .eq("id", r.a.id)
        .eq("priority_level", "very_important"); // idempotent guard
      if (!error) applied++;
    }
    console.log(`\n[APPLY] demoted ${applied} row(s) VERY_IMPORTANT → IMPORTANT (priority_level only).`);
  } else {
    console.log(`\n(read-only: no rows changed. Re-run with --apply after you approve.)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
