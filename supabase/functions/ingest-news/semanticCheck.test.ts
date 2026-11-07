// P4R2 — semantic fidelity checker tests (s3.0: one judgment per pair). The
// model call is ALWAYS a stub judge; pairing, skipping, decisions and the
// parser are deterministic code under test. No network. Fixtures quote the Phase-4
// corpora verbatim (F04 merge, F11a writer sequence, F11b editor excerpt, D17
// ratio, O20 added-sentence scope) plus the acceptance-run FP archetypes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  alignSentences,
  applySemanticDecision,
  bestSourceSupport,
  buildSemanticMessages,
  buildSemanticPairs,
  DIMENSION_CODE,
  isProseSentence,
  isRiskActionSentence,
  isRiskClassSentence,
  JUDGMENT_NEGATIVE_RULES,
  JUDGMENT_QUESTION,
  type JudgmentDimension,
  maybeRunSemanticCheck,
  parseSemanticOutput,
  type SemanticCall,
  SEMANTIC_CHECK_VERSION,
  SEMANTIC_MAX_TOKENS,
  SEMANTIC_MODEL_DEFAULT,
  SEMANTIC_RESPONSE_FORMAT,
  scoredSourceSupport,
  semanticCheckEnabled,
  semanticModel,
  splitSentences,
  SUPPORT_FLOOR,
} from "./semanticCheck.ts";
import { type EditorArticle, type EditorCall, runEditorPass, buildFactPacket } from "./salmaEditor.ts";
import type { WritingProfile } from "./salmaWriter.ts";

// --- Stub judge: flags the pair whose candidate contains a marker --------------

type Rule = { match: string; dimension: Exclude<JudgmentDimension, "none">; kind?: string };
type SentPair = { id: string; candidate: string; reference: string[]; source_context?: string[] };
function stubJudge(rules: Rule[]): { call: SemanticCall; calls: () => number; pairs: () => SentPair[] } {
  let n = 0;
  let last: SentPair[] = [];
  const call: SemanticCall = async (messages) => {
    n++;
    last = JSON.parse(messages[1].content).pairs;
    return {
      ok: true,
      content: JSON.stringify({
        results: last.map((p) => {
          const r = rules.find((x) => p.candidate.includes(x.match));
          return { id: p.id, materially_different: !!r, dimension: r ? r.dimension : "none", reason: r ? "اختلاف" : "مكافئ" };
        }),
      }),
    };
  };
  return { call, calls: () => n, pairs: () => last };
}

/** An ACCEPTED editor pass for `edited` (real runEditorPass, stub transport). */
async function acceptedPass(profile: WritingProfile, writer: EditorArticle, edited: EditorArticle, sourceText: string) {
  const call: EditorCall = async () => ({
    ok: true,
    content: JSON.stringify({ ...edited, summary: edited.summary || writer.summary || "ملخّص قصير.", edit_applied: true, editorial_verdict: "ready", issues_found: [], changes_made: ["تعديل"] }),
  });
  return runEditorPass({
    profile,
    model: "openai/gpt-5.4-mini",
    original: { article: writer, readMinutes: 2 },
    packet: buildFactPacket({ profile, sourceText, mustPreserve: [] }),
    call,
    revalidate: (a) => ({ ok: true, readMinutes: 1, cleanTitle: a.title }),
  });
}

async function check(profile: WritingProfile, writer: EditorArticle, edited: EditorArticle, sourceText: string, rules: Rule[]) {
  const w = { ...writer, summary: writer.summary || "ملخّص قصير." };
  const pass = await acceptedPass(profile, w, edited, sourceText);
  assert.equal(pass.audit.edited_draft_accepted, true, pass.audit.editor_rejection_reason ?? "");
  const stub = stubJudge(rules);
  const result = await maybeRunSemanticCheck({ enabled: true, model: SEMANTIC_MODEL_DEFAULT, writer: w, edited: pass.article, sourceText, call: stub.call });
  const applied = applySemanticDecision(pass, { article: w, readMinutes: 2 }, result, profile);
  return { pass, result: result!, applied, stub };
}

// --- Fixtures (verbatim corpus text) -------------------------------------------

// F04 (nature.com s41390-026-05584-2): the editor merged two writer sentences
// into one that turns tracheal aspirates (fluid) into «الهواء الخارج من الرغامى».
const F04_SOURCE =
  "We collected tracheal aspirates from preterm infants, born ≤32 weeks gestational age, receiving mechanical ventilation in the first week of life. Protein levels were measured in the supernatants. BPD severity categories were defined by the Jensen classification.\n" +
  "Tracheal aspirate levels of select pro-inflammatory and matricellular proteins show distinct patterns associated with BPD severity categories.\n" +
  "THBS1 and periostin, tissue repair, immune, and angiogenesis regulators, display differential expression and potential roles as biomarkers and therapeutic targets in the pathogenesis of BPD severity categories.";
const F04_W1 = "هذه النتائج لا تعني أن هذه البروتينات تسبّب اختلاف الشدة، لكنها قد تساعد مستقبلاً في تقييم الخطر المبكر وفهم الآليات المرتبطة بالمرض.";
const F04_W2 = "الدراسة بشرية ومبكرة، وتدعم فكرة أن قياس إشارات الالتهاب وإصلاح الأنسجة في مجرى الهواء قد يوفّر مؤشرات حيوية محتملة، لكن فائدتها في تغيير التشخيص أو العلاج لم تُثبت بعد.";
const F04_E = "وتشير النتائج إلى مؤشرات حيوية محتملة في الهواء الخارج من الرغامى، لكنها لا تثبت سبب اختلاف الشدة ولا تغيّر القرار العلاجي حالياً.";
const F04_P2 = "جمع الباحثون إفرازات من الرغامى لدى أطفال وُضعوا على جهاز تنفس اصطناعي في الأسبوع الأول بعد الولادة، ثم قاسوا مستويات البروتينات في السائل. وجرى تصنيف شدة المرض وفق تصنيف ينسن.";
const F04_P4 = "وبعد الأخذ في الحسبان الجنس ووزن الولادة، بدا أن انخفاض THBS1 يميز الدرجة الثانية والثالثة، بينما ارتبط ارتفاع البيريوستين بالدرجة الأولى.";
const F04_WRITER: EditorArticle = {
  title: "بصمات بروتينية في مجرى الهواء ترتبط بشدة مرض رئوي عند الخدّج",
  excerpt: "دراسة على خدّج وجدت أن أنماطاً مختلفة من البروتينات ارتبطت بشدة المرض.",
  summary: "",
  body: `${F04_P2}\n\n${F04_P4} ${F04_W1}\n\n${F04_W2}`,
};
const F04_EDITED: EditorArticle = {
  ...F04_WRITER,
  body: `${F04_P2}\n\n${F04_P4.replace("THBS1", "ثرومبوسبوندين 1")} ${F04_E}`,
};

// F11 (sfda.gov.sa/ar/news/19679).
const F11_SOURCE =
  "وافقت الهيئة العامة للغذاء والدواء على طلب شركة سانوفي بتعيين \"إنفیلبراي\"، المحتوي على المادة الفعالة \"فينغلوستات\"، ضمن مسار الأدوية الواعدة، لعلاج المرضى من عمر سنتين فأكثر المصابين بمرض \"غوشيه\" من النوع الثالث.\n" +
  "وأوضحت الهيئة أن قرار تعيين الدواء لا يعني تسجيله، وإنما يُعد موافقة للشركة على تقديمه ضمن هذا المسار وفق شروط وآليات محددة، على أن يُعلن قرار التسجيل وتفاصيل الدواء بعد استكمال التقييم الفني وفق اللوائح المعتمدة.";
const F11_W_EXCERPT = "الهيئة وافقت على إدخال «إنفيلبراي» ضمن مسار الأدوية الواعدة لعلاج المصابين بمرض غوشيه من النوع الثالث بدءًا من عمر سنتين.";
const F11_E_EXCERPT = "وافقت الهيئة العامة للغذاء والدواء على تعيين إنفيلبراي ضمن مسار الأدوية الواعدة لعلاج المصابين بمرض غوشيه من النوع الثالث، وهو مرض وراثي نادر يصيب المرضى من عمر سنتين فأكثر.";
const F11_W_SEQUENCE = "وذكرت الهيئة أن هذا التعيين لا يعني تسجيل الدواء، بل يأتي بعد استكمال التقييم الفني وفق اللوائح المعتمدة.";
const F11_WRITER: EditorArticle = {
  title: "الغذاء والدواء توافق على تعيين إنفيلبراي دواءً واعدًا لمرض غوشيه",
  excerpt: F11_W_EXCERPT,
  summary: "",
  body: `وافقت الهيئة العامة للغذاء والدواء على تعيين دواء إنفيلبراي ضمن مسار الأدوية الواعدة لعلاج المصابين بمرض غوشيه من النوع الثالث.\n\n${F11_W_SEQUENCE}`,
};

// D17 (WHO, malaria vaccine): «1 in 8 child deaths averted» → «1 in 8 children».
const D17_SOURCE =
  "Over a period of four years, an estimated 1 in 8 child deaths were averted among those eligible to receive the malaria vaccine in Ghana, Kenya and Malawi. According to the authors, positive impact is likely to be as high or higher in other African countries.";
const D17_W_RATIO = "وخلال أربع سنوات، قُدّر أن اللقاح حال دون وفاة طفل واحد من كل ثمانية بين الأطفال المؤهلين لتلقيه في هذه البلدان.";
const D17_WRITER: EditorArticle = {
  title: "دليل جديد: لقاح الملاريا أنقذ أرواح أطفال في أفريقيا",
  excerpt: "التوسع في اللقاح قد ينقذ مزيداً من الأطفال.",
  summary: "",
  body: `التقييم اعتمد على بيانات برنامج تنفيذ لقاح الملاريا، ودرس نتائج إدخال اللقاح في غانا وكينيا وملاوي بين 2019 و2023. ${D17_W_RATIO}`,
};

// O20 (WHO DON, MERS-CoV KSA): the editor ADDED general food-hygiene advice
// narrowed to people with chronic conditions.
const O20_SOURCE =
  "MERS-CoV appears to cause more severe disease in people with underlying chronic medical conditions such as diabetes, renal failure, chronic lung disease and in immunocompromised persons. Therefore, people with these underlying medical conditions should avoid close contact with dromedary camels or their products, particularly when visiting farms, markets, barns or other areas where the virus may be circulating.\n" +
  "Appropriate food hygiene should be observed when handling or consuming camel products. People should avoid drinking raw camel milk or camel urine or consuming meat that has not been properly cooked.";
const O20_ADDED = "كما توصي من لديهم أمراض مزمنة بتجنب مخالطة الإبل أو منتجاتها، والالتزام بالنظافة العامة، وتجنب شرب الحليب النيء أو بول الإبل أو تناول اللحم غير المطهو جيداً.";
const O20_P1 = "أبلغت السعودية عن ثماني إصابات بفيروس متلازمة الشرق الأوسط التنفسية، بينها وفاة واحدة، بين 1 يناير و5 أكتوبر 2026، في ستة مواقع داخل المملكة.";
const O20_WRITER: EditorArticle = {
  title: "السعودية تسجّل ثماني إصابات بفيروس كورونا المسبّب لمتلازمة الشرق الأوسط",
  excerpt: "الإصابات تركّزت لدى كبار السن.",
  summary: "",
  body: O20_P1,
};
const O20_EDITED: EditorArticle = { ...O20_WRITER, body: `${O20_P1}\n\n${O20_ADDED}` };

// F01 (CDC salmonella outbreak, fact box) — the acceptance-run blocking FP.
const F01_SOURCE =
  "Salmonella Outbreak Linked to Raw Oysters\n\nInvestigation notice\n\nFast Facts\n\nCases : 80\n\nHospitalizations : 34\n\nDeaths : 0";
const F01_W = "أُغلق التحقيق في تفشّي السالمونيلا المرتبط بمحار نيّئ بعد تسجيل 80 حالة و34 حالة دخول للمستشفى دون وفيات.";

// =========================================================================
// Flag — default OFF
// =========================================================================

test("P4R2 SEMANTIC_CHECK_ENABLED is default-off: unset/empty/false/0/garbage → off; only true/1 → on", () => {
  assert.equal(semanticCheckEnabled(() => undefined), false);
  for (const v of ["", "false", "0", "no", "off", "TRUE ish"]) assert.equal(semanticCheckEnabled(() => v), false, v);
  for (const v of ["true", "TRUE", " 1 "]) assert.equal(semanticCheckEnabled((k) => (k === "SEMANTIC_CHECK_ENABLED" ? v : undefined)), true, v);
  assert.equal(semanticModel(() => undefined), "openai/gpt-5.4-mini");
  assert.equal(semanticModel((k) => (k === "OPENROUTER_SEMANTIC_MODEL" ? "x/y" : undefined)), "x/y");
});

test("P4R2 default-off: a disabled check makes NO call and leaves the editor pass byte-identical", async () => {
  const pass = await acceptedPass("research_study", F04_WRITER, F04_EDITED, F04_SOURCE);
  const r = await maybeRunSemanticCheck({
    enabled: false, model: SEMANTIC_MODEL_DEFAULT, writer: F04_WRITER, edited: pass.article, sourceText: F04_SOURCE,
    call: async () => {
      throw new Error("must not be called while disabled");
    },
  });
  assert.equal(r, null);
  const applied = applySemanticDecision(pass, { article: F04_WRITER, readMinutes: 2 }, r, "research_study");
  assert.equal(applied.pass, pass);
  assert.equal(applied.reviewRequired, false);
  assert.deepEqual(applied.blocking, []);
  assert.equal(pass.audit.semantic_check, undefined);
});

test("P4R2 default-off wiring: pipeline reads the flag from env and gates the only semantic call on it", () => {
  const src = readFileSync(fileURLToPath(new URL("./pipeline.ts", import.meta.url)), "utf8");
  assert.ok(src.includes("export const SEMANTIC_CHECK_ENABLED = semanticCheckEnabled((k) => Deno.env.get(k));"));
  assert.ok(src.includes("enabled: SEMANTIC_CHECK_ENABLED,"));
  assert.ok(src.includes("maxTokens: SEMANTIC_MAX_TOKENS,"));
  assert.equal((src.match(/responseFormat: SEMANTIC_RESPONSE_FORMAT/g) ?? []).length, 1);
  assert.equal((src.match(/maybeRunSemanticCheck\(/g) ?? []).length, 1);
  assert.equal(SEMANTIC_MAX_TOKENS, 1200);
  assert.equal(SEMANTIC_CHECK_VERSION, "s3.0-salma-semantic");
});

// =========================================================================
// Alignment, support floor, prose
// =========================================================================

test("P4R2 alignment: F04 two writer sentences merged into one editor sentence pair as a merge", () => {
  const ws = splitSentences(F04_WRITER.body);
  const es = splitSentences(F04_EDITED.body);
  const al = alignSentences(ws, es);
  const merge = al.pairs.find((p) => p.editor === es.indexOf(F04_E));
  assert.ok(merge, JSON.stringify(al));
  assert.deepEqual(merge!.writer.map((i) => ws[i]), [F04_W1, F04_W2]);
  assert.equal(al.unchanged.length, 2);
  assert.deepEqual(al.added, []);
  assert.deepEqual(al.removed, []);
});

test("P4R2 alignment: one-to-one rewording, split-off part, genuine addition and removal", () => {
  const ws = ["وافقت الهيئة على تسجيل الدواء الجديد لعلاج السكري لدى البالغين.", "وأوضحت الهيئة أن القرار يشمل الأقراص فقط دون الحقن.", "وتطلب الهيئة من المرضى استشارة الطبيب قبل البدء."];
  const es = ["اعتمدت الهيئة تسجيل الدواء الجديد لعلاج السكري لدى البالغين.", "وأوضحت الهيئة أن القرار يشمل الأقراص فقط.", "دون الحقن يشمل القرار الأقراص.", "وسيتوفر الدواء في الصيدليات الشهر المقبل."];
  const al = alignSentences(ws, es);
  assert.deepEqual(al.pairs.find((p) => p.editor === 0)?.writer, [0]);
  assert.deepEqual(al.pairs.find((p) => p.editor === 1)?.writer, [1]);
  assert.deepEqual(al.pairs.find((p) => p.editor === 2)?.writer, [1]);
  assert.deepEqual(al.added, [3]);
  assert.deepEqual(al.removed, [2]);
});

test("P4R2 merged editor pairs carry the source-support sentence as third context", () => {
  const built = buildSemanticPairs({ writer: F04_WRITER, edited: F04_EDITED, sourceText: F04_SOURCE });
  const merged = built.pairs.find((p) => p.candidate === F04_E)!;
  assert.deepEqual(merged.reference, [F04_W1, F04_W2]);
  assert.equal(merged.sourceContext.length, 1);
  assert.ok(/tracheal aspirate/i.test(merged.sourceContext[0]), merged.sourceContext[0]);
  assert.equal(merged.referenceIds.length, 3);
  // Texts are deduped and every id resolves.
  const ids = new Set(built.texts.map((t) => t.id));
  for (const p of built.pairs) for (const id of [p.candidateId, ...p.referenceIds]) assert.ok(ids.has(id));
});

test("P4R2 F01 fact-box support («Cases : 80») is below the floor → the writer pair is SKIPPED, not judged", async () => {
  const top = scoredSourceSupport(F01_W, splitSentences(F01_SOURCE), 2, 1);
  assert.ok(top.length > 0 && top.every((x) => x.score < SUPPORT_FLOOR), JSON.stringify(top));
  const writer: EditorArticle = { title: "إغلاق تحقيق تفشّي السالمونيلا", excerpt: F01_W, summary: "", body: F01_W };
  const built = buildSemanticPairs({ writer, edited: null, sourceText: F01_SOURCE });
  assert.deepEqual(built.pairs, []);
  assert.ok(built.skipped_low_support >= 1);
  let called = 0;
  const r = await maybeRunSemanticCheck({ enabled: true, model: "m", writer, edited: null, sourceText: F01_SOURCE, call: async () => (called++, { ok: true, content: "{}" }) });
  assert.equal(called, 0);
  assert.equal(r?.status, "passed");
  assert.equal(isProseSentence("Cases : 80"), false);
  assert.equal(isProseSentence("People should avoid drinking raw camel milk or camel urine."), true);
});

test("P4R2 sentence split keeps decimals and ratios intact; risk-class detection", () => {
  assert.deepEqual(splitSentences("بقي 82.2% بلا سرطان. وشملت 1.100 مريض."), ["بقي 82.2% بلا سرطان.", "وشملت 1.100 مريض."]);
  assert.ok(isRiskClassSentence(D17_W_RATIO));
  assert.ok(isRiskClassSentence(F11_W_SEQUENCE));
  assert.ok(isRiskClassSentence("خفّض الخطر بنسبة 42%."));
  assert.ok(isRiskClassSentence(O20_ADDED));
  assert.ok(!isRiskClassSentence("وجرى تصنيف شدة المرض وفق تصنيف ينسن."));
  assert.ok(isRiskActionSentence(O20_ADDED));
  assert.ok(!isRiskActionSentence(F11_W_SEQUENCE));
});

test("P4R2 source support aligns across languages (numbers + lexicon) and within Arabic", () => {
  assert.ok(bestSourceSupport(O20_ADDED, splitSentences(O20_SOURCE)).some((s) => s.includes("raw camel milk")));
  assert.ok(bestSourceSupport(D17_W_RATIO, splitSentences(D17_SOURCE))[0].includes("1 in 8 child deaths"));
  assert.ok(bestSourceSupport(F11_W_SEQUENCE, splitSentences(F11_SOURCE))[0].includes("بعد استكمال التقييم الفني"));
  assert.deepEqual(bestSourceSupport(D17_W_RATIO, ["The weather was mild in Geneva."]), []);
});

// =========================================================================
// Prompt: the question, hard negative rules, calibration — verbatim
// =========================================================================

test("P4R2 s3.0 prompt carries the exact question, the six hard negative rules and six calibration examples", () => {
  const sys = buildSemanticMessages([])[0].content;
  assert.ok(sys.includes(JUDGMENT_QUESTION));
  assert.ok(JUDGMENT_QUESTION.includes("كم (بما فيه مقام النسبة)") && JUDGMENT_QUESTION.includes("منجز أم منتظر"));
  assert.equal(JUDGMENT_NEGATIVE_RULES.length, 6);
  for (const r of JUDGMENT_NEGATIVE_RULES) assert.ok(sys.includes(r), r);
  for (const k of ["1)", "2)", "3)", "4)", "5)", "6)"]) assert.ok(sys.includes(k), k);
  assert.ok(sys.includes("ratio_semantics") && sys.includes("polarity_tense_status"));
  assert.ok(sys.includes(SEMANTIC_CHECK_VERSION));
});

test("P4R2 s3.0 schema/parser: one verdict per pair, enum dimension, different ⇔ dimension ≠ none", () => {
  const items = SEMANTIC_RESPONSE_FORMAT.json_schema.schema.properties.results.items;
  assert.deepEqual([...items.required].sort(), ["dimension", "id", "materially_different", "reason"]);
  assert.deepEqual([...items.properties.dimension.enum], [...Object.keys(DIMENSION_CODE), "none"]);
  const ok = JSON.stringify({ results: [{ id: "p1", materially_different: true, dimension: "ratio_semantics", reason: "مقام" }, { id: "p2", materially_different: false, dimension: "none", reason: "" }] });
  assert.equal(parseSemanticOutput(ok, ["p1", "p2"]).ok, true);
  const bad = (o: unknown) => parseSemanticOutput(JSON.stringify(o), ["p1"]);
  assert.deepEqual(bad({ results: [{ id: "p1", materially_different: true, dimension: "none", reason: "" }] }), { ok: false, error: "semantic_output_inconsistent" });
  assert.deepEqual(bad({ results: [{ id: "p1", materially_different: false, dimension: "attribution", reason: "" }] }), { ok: false, error: "semantic_output_inconsistent" });
  assert.deepEqual(bad({ results: [{ id: "p1", materially_different: true, dimension: "tone", reason: "" }] }), { ok: false, error: "semantic_output_unknown_dimension" });
  assert.deepEqual(bad({ results: [{ id: "p9", materially_different: false, dimension: "none", reason: "" }] }), { ok: false, error: "semantic_output_ids_mismatch" });
  assert.deepEqual(bad({ results: [{ id: "p1", materially_different: false, dimension: "none" }] }), { ok: false, error: "semantic_output_schema_invalid" });
});

// =========================================================================
// The five known error cases (stubbed judgments)
// =========================================================================

test("P4R2 F04 merge: the merged editor sentence is judged with its source context → semantic_material_changed → revert", async () => {
  const { result, applied, stub } = await check("research_study", F04_WRITER, F04_EDITED, F04_SOURCE, [{ match: "الهواء الخارج", dimension: "material_noun" }]);
  const sent = stub.pairs().find((p) => p.candidate === F04_E)!;
  assert.deepEqual(sent.reference, [F04_W1, F04_W2]);
  assert.ok(/tracheal aspirate/i.test(sent.source_context?.[0] ?? ""));
  assert.deepEqual(result.editor_findings.map((f) => f.codes), [["semantic_material_changed"]]);
  assert.equal(applied.pass.article.body, F04_WRITER.body);
  assert.equal(applied.pass.audit.decision, "factual_rejected");
  assert.deepEqual(applied.blocking, []);
});

test("P4R2 F11a (writer): «after technical evaluation» moved from registration to designation → scope → review", async () => {
  const { result, applied } = await check("regulation_or_service", F11_WRITER, F11_WRITER, F11_SOURCE, [{ match: "بل يأتي بعد استكمال التقييم الفني", dimension: "scope_qualifier", kind: "writer_risk" }]);
  assert.deepEqual(result.writer_findings.map((f) => f.codes), [["semantic_scope_changed"]]);
  assert.ok(result.writer_findings[0].reference[0].includes("على أن يُعلن قرار التسجيل"));
  assert.equal(applied.reviewRequired, true);
  assert.deepEqual(applied.blocking, []);
});

test("P4R2 F11b (editor excerpt): the age limit re-attached to the disease → scope → revert", async () => {
  const edited: EditorArticle = { ...F11_WRITER, excerpt: F11_E_EXCERPT };
  const { result, applied } = await check("regulation_or_service", F11_WRITER, edited, F11_SOURCE, [{ match: "وهو مرض وراثي نادر يصيب المرضى", dimension: "scope_qualifier" }]);
  assert.equal(result.editor_findings.length, 1);
  assert.equal(result.editor_findings[0].field, "excerpt");
  assert.deepEqual(result.editor_findings[0].codes, ["semantic_scope_changed"]);
  assert.equal(applied.pass.article.excerpt, F11_W_EXCERPT);
});

test("P4R2 D17 ratio: «1 in 8 child deaths» vs «1 in 8 children» → semantic_ratio_changed → review", async () => {
  const { result, applied } = await check("research_study", D17_WRITER, D17_WRITER, D17_SOURCE, [{ match: "من كل ثمانية", dimension: "ratio_semantics" }]);
  assert.deepEqual(result.writer_findings.map((f) => f.codes), [["semantic_ratio_changed"]]);
  assert.ok(result.writer_findings[0].reference[0].includes("1 in 8 child deaths were averted"));
  assert.equal(applied.reviewRequired, true);
  assert.deepEqual(applied.blocking, []);
});

test("P4R2 O20 added sentence: general advice narrowed to chronic patients → scope → revert (never blocking)", async () => {
  const { result, applied } = await check("safety_alert", O20_WRITER, O20_EDITED, O20_SOURCE, [{ match: "كما توصي من لديهم أمراض مزمنة", dimension: "scope_qualifier" }]);
  assert.equal(result.editor_findings.length, 1);
  assert.equal(result.editor_findings[0].kind, "editor_added");
  assert.ok(result.editor_findings[0].reference.some((s) => s.includes("raw camel milk")));
  assert.equal(applied.pass.article.body, O20_WRITER.body);
  assert.deepEqual(applied.blocking, []);
});

test("P4R2 safety_alert blocking needs a writer risk/action difference AND prose support; other profiles review", async () => {
  const writer: EditorArticle = { ...O20_WRITER, body: `${O20_P1}\n\n${O20_ADDED}` };
  const rules: Rule[] = [{ match: "كما توصي من لديهم", dimension: "scope_qualifier" }];
  const safety = await check("safety_alert", writer, writer, O20_SOURCE, rules);
  assert.deepEqual(safety.applied.blocking, ["semantic_scope_changed"]);
  const other = await check("standard_news", writer, writer, O20_SOURCE, rules);
  assert.deepEqual(other.applied.blocking, []);
  assert.equal(other.applied.reviewRequired, true);
  const short = await maybeRunSemanticCheck({
    enabled: true, model: "m", writer, edited: null,
    sourceText: "Chronic patients : avoid camel milk\n\nMERS-CoV continues to circulate in dromedary camels.",
    call: stubJudge(rules).call,
  });
  const f = short!.writer_findings.find((x) => x.candidate === O20_ADDED);
  assert.ok(f && f.supportProse === false, JSON.stringify(short));
  const a = applySemanticDecision(safety.pass, { article: writer, readMinutes: 2 }, short, "safety_alert");
  assert.deepEqual(a.blocking, []);
  assert.equal(a.reviewRequired, true);
});

// =========================================================================
// v1 + v2 FP archetypes → NO action (each pair IS sent; the hard rule covers it)
// =========================================================================

const ARCH_SOURCE =
  "The CDC said the outbreak of Salmonella linked to raw oysters is over after 80 cases in 23 states were reported.\n" +
  "Nigerian health authorities confirmed the first imported case of Ebola Bundibugyo virus disease in the Federal Capital Territory.\n" +
  "Researchers measured the protein in blood samples taken from infected adults during the first week.\n" +
  "The Saudi Food and Drug Authority recalled batches of diphenhydramine on the Saudi market after impurities exceeded the limit.\n" +
  "Kuwaiti authorities said inspections found violations that could threaten patient safety at five private facilities.";
const ARCH: { name: string; rule: string; writer: string; edited: string }[] = [
  { name: "subject paraphrase (CDC said X ≈ X)", rule: JUDGMENT_NEGATIVE_RULES[2], writer: "وقالت المراكز الأمريكية لمكافحة الأمراض إن تفشّي السالمونيلا المرتبط بالمحار النيء انتهى بعد تسجيل 80 حالة.", edited: "انتهى تفشّي السالمونيلا المرتبط بالمحار النيء بعد تسجيل 80 حالة، وفق المراكز الأمريكية لمكافحة الأمراض." },
  { name: "country ≈ its authorities (Nigeria)", rule: JUDGMENT_NEGATIVE_RULES[2], writer: "أكدت نيجيريا أول إصابة مستوردة بمرض فيروس إيبولا بونديبوجيو في إقليم العاصمة الفيدرالية.", edited: "أكدت السلطات الصحية النيجيرية أول إصابة مستوردة بمرض فيروس إيبولا بونديبوجيو في إقليم العاصمة الفيدرالية." },
  { name: "tense-only", rule: JUDGMENT_NEGATIVE_RULES[1], writer: "ويقول الباحثون إن الأداة قد تساعد لاحقاً في تحديد المرضى ذوي الأورام الأكثر شراسة واختيار علاجات أكثر استهدافاً.", edited: "وقال الباحثون إن الأداة قد تساعد لاحقاً في تحديد المرضى ذوي الأورام الأكثر شراسة واختيار علاجات أكثر استهدافاً." },
  { name: "compression", rule: JUDGMENT_NEGATIVE_RULES[0], writer: "وقاس الباحثون البروتين في عينات الدم المأخوذة من البالغين المصابين بالمرض خلال الأسبوع الأول.", edited: "وقاس الباحثون البروتين في الدم خلال الأسبوع الأول." },
  { name: "supported addition («في 23 ولاية»)", rule: JUDGMENT_NEGATIVE_RULES[4], writer: "وسُجّلت 80 حالة مرتبطة بالمحار النيء خلال التفشّي الذي أعلنت المراكز انتهاءه.", edited: "وسُجّلت 80 حالة في 23 ولاية مرتبطة بالمحار النيء خلال التفشّي الذي أعلنت المراكز انتهاءه." },
  { name: "attribution style (authorities/inspections)", rule: JUDGMENT_NEGATIVE_RULES[3], writer: "وكشفت التفتيشات في خمسة مرافق خاصة مخالفات قد تهدد سلامة المرضى، بحسب السلطات الكويتية.", edited: "وقالت السلطات الكويتية إن التفتيشات في خمسة مرافق خاصة كشفت مخالفات قد تهدد سلامة المرضى." },
];

test("P4R2 FP archetypes take NO action: every archetype pair is sent and its hard rule is in the prompt", async () => {
  const writer: EditorArticle = {
    title: "سحب تشغيلات من مستحضر دي فين هيدرامين بسبب شوائب",
    excerpt: "انتهاء تفشٍّ وتأكيد إصابة مستوردة.",
    summary: "ملخّص قصير.",
    body: ARCH.map((a) => a.writer).join("\n\n"),
  };
  const edited: EditorArticle = {
    ...writer,
    title: "سحب تشغيلات من مستحضر دي فين هيدرامين في السعودية بسبب شوائب",
    body: ARCH.map((a) => a.edited).join("\n\n"),
  };
  // A rule-obeying judge: no archetype is materially different.
  const { result, applied, stub } = await check("standard_news", writer, edited, ARCH_SOURCE, []);
  const sys = buildSemanticMessages([])[0].content;
  const sent = stub.pairs().map((p) => p.candidate);
  for (const a of ARCH) {
    assert.ok(sent.includes(a.edited), `${a.name}: pair not sent`);
    assert.ok(sys.includes(a.rule), a.name);
  }
  assert.ok(sent.includes(edited.title), "title «في السعودية» pair not sent");
  assert.ok(sys.includes(JUDGMENT_NEGATIVE_RULES[5]) && JUDGMENT_NEGATIVE_RULES[5].includes("في السعودية"));
  assert.equal(result.status, "passed");
  assert.equal(applied.reviewRequired, false);
  assert.equal(applied.pass.audit.edited_draft_accepted, true);
  assert.equal(applied.pass.audit.editorial_verdict, "ready");
});

test("P4R2 FP archetype: a fact-box-only support is skipped before judgment (F01 «Cases : 80»)", () => {
  const top = scoredSourceSupport(F01_W, splitSentences(F01_SOURCE), 2, 1);
  assert.ok(top.every((x) => x.score < SUPPORT_FLOOR));
  assert.deepEqual(buildSemanticPairs({ writer: { title: "ع", excerpt: F01_W, summary: "", body: F01_W }, edited: null, sourceText: F01_SOURCE }).pairs, []);
});

// =========================================================================
// Clean, never-upgrade, fail-safe, no-pairs
// =========================================================================

test("P4R2 clean judgments pass: an accepted edit stays accepted and ready", async () => {
  const { result, applied } = await check("research_study", F04_WRITER, F04_EDITED, F04_SOURCE, []);
  assert.equal(result.status, "passed");
  assert.ok(result.pairs_checked > 0);
  assert.equal(applied.pass.article.body, F04_EDITED.body);
  assert.equal(applied.pass.audit.editorial_verdict, "ready");
});

test("P4R2 never upgrades: a clean check on a needs_human_review pass keeps needs_human_review", async () => {
  const pass = await acceptedPass("research_study", F04_WRITER, F04_EDITED, F04_SOURCE);
  const down = { ...pass, audit: { ...pass.audit, editorial_verdict: "needs_human_review" as const, final_editorial_verdict: "needs_human_review" as const } };
  const result = await maybeRunSemanticCheck({ enabled: true, model: "m", writer: F04_WRITER, edited: down.article, sourceText: F04_SOURCE, call: stubJudge([]).call });
  const applied = applySemanticDecision(down, { article: F04_WRITER, readMinutes: 2 }, result, "research_study");
  assert.equal(applied.pass.audit.editorial_verdict, "needs_human_review");
  assert.equal(applied.pass.audit.final_editorial_verdict, "needs_human_review");
});

test("P4R2 checker failure (transport / throw / unparseable / id mismatch) → needs_human_review, edit kept, never blocking", async () => {
  const pass = await acceptedPass("safety_alert", O20_WRITER, O20_EDITED, O20_SOURCE);
  const failures: SemanticCall[] = [
    async () => ({ ok: false, reason: "timeout" }),
    async () => {
      throw new Error("boom");
    },
    async () => ({ ok: true, content: "not json" }),
    async () => ({ ok: true, content: JSON.stringify({ results: [] }) }),
  ];
  for (const call of failures) {
    const result = await maybeRunSemanticCheck({ enabled: true, model: "m", writer: O20_WRITER, edited: pass.article, sourceText: O20_SOURCE, call });
    assert.equal(result?.status, "checker_failed");
    const applied = applySemanticDecision(pass, { article: O20_WRITER, readMinutes: 2 }, result, "safety_alert");
    assert.equal(applied.reviewRequired, true);
    assert.deepEqual(applied.blocking, []);
    assert.equal(applied.pass.article.body, O20_EDITED.body);
    assert.ok(applied.pass.audit.reasons.some((r) => r.startsWith("semantic_check_failed:")));
  }
});

test("P4R2 duplicate pairs are sent once; no pairs at all → passed without a call", async () => {
  const dup: EditorArticle = { title: "ع", excerpt: D17_W_RATIO, summary: D17_W_RATIO, body: D17_W_RATIO };
  const built = buildSemanticPairs({ writer: dup, edited: null, sourceText: D17_SOURCE });
  assert.equal(built.pairs.filter((p) => p.candidate === D17_W_RATIO).length, 1);
  let called = 0;
  const r = await maybeRunSemanticCheck({
    enabled: true, model: "m",
    writer: { title: "عنوان", excerpt: "مقتطف", summary: "", body: "وجرى تصنيف شدة المرض وفق تصنيف ينسن." },
    edited: null, sourceText: D17_SOURCE,
    call: async () => (called++, { ok: true, content: "{}" }),
  });
  assert.equal(called, 0);
  assert.equal(r?.status, "passed");
});
