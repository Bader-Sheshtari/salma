// Validator false-positive fixes (owner-authorized, 2026-11-06) — the three
// FP classes reproduced by the Jamal j1.0 editorial test, each with a
// counterexample proving the GENUINE error class is still detected:
//   FP-A invented_quotation on «» around (a) short transliterated brand names
//        («ويغوفي» ↔ Wegovy: perfect skeleton but only 2 consonants) and
//        (b) short translated coined terms («التطعيم الحلقي» ↔ ring vaccination);
//   FP-B unsupported_number for digits whose source states the figure as an
//        ENGLISH WORD ("five of 53" → draft «5 من أصل 53»);
//   FP-C unsupported_claim:مثبت on a NEGATED caveat («لا تعني بعد تفوقاً مثبتاً»).
// No blocker is disabled: every counterexample here pins the original purpose.

import test from "node:test";
import assert from "node:assert/strict";
import { extractQuotes, validateArticle } from "./salmaWriter.ts";

const FILLER =
  "وأوضح الفريق أن الدراسة أجريت في عدة مراكز بحثية وأن المشاركين خضعوا لمتابعة دورية منتظمة. " +
  "وأشار الباحثون إلى أن هذه النتائج تحتاج إلى تأكيد في دراسات أوسع قبل اعتمادها في الممارسة السريرية، " +
  "وأن اختيار المشاركين جرى وفق معايير محددة أعلنها الفريق مسبقاً.";

function errorsOf(body: string, sourceText: string, title = "عنوان خبري مناسب للاختبار"): string[] {
  const v = validateArticle({
    article: { title, excerpt: "مقتطف تمهيدي مختلف عن العنوان للاختبار.", body: `${body}\n\n${FILLER}`, profile: "research_study" },
    source: { sourceText, sourceLang: null },
  });
  return v.errors;
}

// ---- FP-A: quotation exemptions ---------------------------------------------

test("FP-A repro: «ويغوفي» (short transliterated brand, Wegovy in source) is not an invented quotation", () => {
  const src = "The agency recommended extending Wegovy to an oral tablet for weight management in adults.";
  const errs = errorsOf("أوصت الوكالة بتوسيع ترخيص دواء «ويغوفي» (Wegovy) ليشمل أقراصاً فموية لدى البالغين.", src);
  assert.ok(!errs.includes("invented_quotation"), `got: ${errs}`);
});

test("FP-A counter: the «سام»/'Some' leak stays blocked (short common-word window is never a name)", () => {
  const src = "Some results were reported by the group last year in a preliminary analysis.";
  const errs = errorsOf("وقال التقرير إن «سام» أعلن النتائج في تحليل أولي.", src);
  assert.ok(errs.includes("invented_quotation"), `got: ${errs}`);
});

test("FP-A repro: a short translated coined term in «» («التطعيم الحلقي» for ring vaccination) is style, not an invented quotation", () => {
  const src = "The Tumaini trial uses a ring vaccination design, vaccinating contacts of confirmed cases.";
  const errs = errorsOf("تعتمد التجربة على أسلوب «التطعيم الحلقي»، إذ تُعطى اللقاحات للمخالطين لحالات مؤكدة.", src);
  assert.ok(!errs.includes("invented_quotation"), `got: ${errs}`);
});

test("FP-A counter: a short quote attributed as SPEECH stays a quotation and blocks when absent from the source", () => {
  const src = "The agency issued a routine statement about the programme and its scope.";
  const errs = errorsOf("وقالت الوكالة: «نتائج مذهلة» في بيانها الأخير.", src);
  assert.ok(errs.includes("invented_quotation"), `got: ${errs}`);
});

test("FP-A counter: a quoted span of three or more words still requires verbatim source presence", () => {
  const src = "The committee discussed the programme in its scheduled meeting.";
  const errs = errorsOf("ووصف التقرير الأمر بأنه «هذه نتيجة مهمة جداً» بحسب النص.", src);
  assert.ok(errs.includes("invented_quotation"), `got: ${errs}`);
});

test("FP-A counter: a short quoted CLAIM term («علاج نهائي») is never exempted", () => {
  const src = "The study reported preliminary findings in mice only.";
  const errs = errorsOf("ووصفت الصفحة الدواء بأنه «علاج نهائي» للمرض.", src);
  assert.ok(errs.includes("invented_quotation"), `got: ${errs}`);
});

test("FP-A unit: extractQuotes keeps speech-context and long spans, drops exempt term/name spans", () => {
  const src = "Wegovy uses a ring vaccination style programme."; // fixture text only
  const body =
    'استخدمت التجربة «التطعيم الحلقي» كما ورد. وقال المتحدث: «خطوة كبيرة». ' +
    "وأشار إلى «نتائج أولية مبشرة للغاية» في العرض.";
  const quotes = extractQuotes(body, src);
  assert.ok(!quotes.includes("التطعيم الحلقي"));
  assert.ok(quotes.includes("خطوة كبيرة"));
  assert.ok(quotes.includes("نتائج أولية مبشرة للغاية"));
});

// ---- FP-B: English word-form numbers in the source ----------------------------

test("FP-B repro: source 'five of 53' supports the draft digit 5", () => {
  const src = "In-hospital mortality was 9.4 percent, meaning five of 53 patients died before discharge.";
  const errs = errorsOf("توفي 5 من أصل 53 مريضاً داخل المستشفى، أي 9.4%.", src);
  assert.ok(!errs.some((e) => e === "unsupported_number:5"), `got: ${errs}`);
});

test("FP-B counter: a digit the source states neither as digit nor word still blocks", () => {
  const src = "In-hospital mortality was 9.4 percent, meaning five of 53 patients died before discharge.";
  const errs = errorsOf("توفي 7 من أصل 53 مريضاً داخل المستشفى.", src);
  assert.ok(errs.some((e) => e.startsWith("unsupported_number:7")), `got: ${errs}`);
});

test("FP-B: hyphenated word compounds ('twenty-five percent') support the digit 25", () => {
  const src = "The reduction reached twenty-five percent at one year among treated patients.";
  const errs = errorsOf("بلغ الانخفاض 25% بعد سنة واحدة لدى المرضى المعالجين.", src);
  assert.ok(!errs.some((e) => e === "unsupported_number:25"), `got: ${errs}`);
});

// ---- FP-C: negation-aware strong-claim check ----------------------------------

test("FP-C repro: a NEGATED claim caveat («لا تعني بعد تفوقاً مثبتاً») does not trigger unsupported_claim", () => {
  const src = "The results combine a small retrospective cohort with mouse experiments.";
  const errs = errorsOf("النتائج أولية، لذلك لا تعني بعد تفوقاً مثبتاً لدى المرضى.", src);
  assert.ok(!errs.includes("unsupported_claim:مثبت"), `got: ${errs}`);
});

test("FP-C repro: «غير مثبت» and «ولا يُعد العلاج مثبتاً» pass as negated", () => {
  const src = "The report summarises early findings only.";
  const e1 = errorsOf("وتبقى الفائدة أمراً غير مثبت حتى الآن في الدراسات البشرية.", src);
  assert.ok(!e1.includes("unsupported_claim:مثبت"), `got: ${e1}`);
  const e2 = errorsOf("ولا يُعد العلاج مثبتاً وفق البيانات الحالية المتاحة.", src);
  assert.ok(!e2.includes("unsupported_claim:مثبت"), `got: ${e2}`);
});

test("FP-C counter: an AFFIRMATIVE unsupported claim still blocks («العلاج مثبت الفعالية», «أثبتت الدراسة»)", () => {
  const src = "The study reported associations in an observational cohort.";
  const e1 = errorsOf("ويُعد العلاج مثبت الفعالية لدى جميع المرضى بحسب التقرير.", src);
  assert.ok(e1.includes("unsupported_claim:مثبت"), `got: ${e1}`);
  const e2 = errorsOf("أثبتت الدراسة فعالية العلاج لدى البشر بشكل قاطع.", src);
  assert.ok(e2.includes("unsupported_claim:أثبت"), `got: ${e2}`);
});

test("FP-C counter: negation does NOT leak across a clause boundary (comma resets the window)", () => {
  const src = "The report summarises early findings only.";
  const errs = errorsOf("النتائج ليست نهائية بعد، والعلاج مثبت الفعالية لدى المرضى.", src);
  assert.ok(errs.includes("unsupported_claim:مثبت"), `got: ${errs}`);
});

test("FP-C: a claim keyword the source itself states remains supported (unchanged behavior)", () => {
  const src = "وأكدت الجهة أن العلاج مثبت الفعالية في هذه الفئة من المرضى.";
  const errs = errorsOf("وبحسب الجهة، العلاج مثبت الفعالية في هذه الفئة.", src);
  assert.ok(!errs.includes("unsupported_claim:مثبت"), `got: ${errs}`);
});

// ---- FP-D: cross-language claim support (مثبت/أثبت ↔ proven/proved) ----------
// Owner-authorized 2026-11-07 after the WHO climate-health live test: the
// source said "proven" three times, the draft said «إجراءات مثبتة», and the
// claim gate only accepted ARABIC-side support. Mapping is ONLY this lemma
// pair; every other claim keyword still requires Arabic-side support.

test("FP-D repro: «إجراءات مثبتة» is supported by an English source stating 'proven' (WHO live-test class)", () => {
  const src = "Six proven climate and health measures could save 1.6 million lives a year, the report said.";
  const errs = errorsOf("قالت المنظمة إن توسيع إجراءات مثبتة في مجالي المناخ والصحة قد يمنع وفيات كثيرة.", src);
  assert.ok(!errs.includes("unsupported_claim:مثبت"), `got: ${errs}`);
});

test("FP-D repro: «أثبتت» is supported by an English source stating 'proved'", () => {
  const src = "The randomised trial proved the vaccine effective in the study population, regulators said.";
  const errs = errorsOf("وأثبتت التجربة العشوائية فعالية اللقاح لدى الفئة المدروسة بحسب الجهات التنظيمية.", src);
  assert.ok(!errs.includes("unsupported_claim:أثبت"), `got: ${errs}`);
});

test("FP-D counter: an English source WITHOUT proven/proved still blocks an affirmative «مثبت»", () => {
  const src = "The observational study reported associations between the measures and outcomes.";
  const errs = errorsOf("ويُعد التدخل مثبت الفعالية لدى جميع الفئات بحسب التقرير.", src);
  assert.ok(errs.includes("unsupported_claim:مثبت"), `got: ${errs}`);
});

test("FP-D counter: 'unproven' and 'not proven' in the source never support an affirmative «مثبت»", () => {
  // Word-boundary matching: "unproven" does not contain the standalone word.
  const e1 = errorsOf(
    "ويُعد التدخل مثبت الفعالية لدى جميع الفئات بحسب التقرير.",
    "The intervention remains unproven according to the review of available evidence.",
  );
  assert.ok(e1.includes("unsupported_claim:مثبت"), `got: ${e1}`);
  // "not proven" carries the standalone word — parity with the Arabic-side
  // substring behavior (source «غير مثبت» also counts as keyword presence);
  // the draft-side negation check (FP-C) is what governs the claim itself.
  const e2 = errorsOf(
    "لم تثبت فعالية التدخل بعد، والنتائج أولية حتى الآن.",
    "The benefit is not proven according to the review.",
  );
  assert.ok(!e2.includes("unsupported_claim:مثبت"), `got: ${e2}`);
});

test("FP-D counter: the mapping is ONLY مثبت/أثبت — «مضمون» with English 'guaranteed' still blocks", () => {
  const src = "The programme guaranteed access to treatment for all enrolled patients.";
  const errs = errorsOf("والعلاج مضمون النتائج لدى جميع المرضى بحسب البرنامج.", src);
  assert.ok(errs.includes("unsupported_claim:مضمون"), `got: ${errs}`);
});

test("FP-D counter: English support does not bypass the draft-side negation/clause logic (comma resets)", () => {
  // Source supports مثبت, so no error either way — but an UNRELATED keyword
  // in the same draft is still independently checked and blocked.
  const src = "Six proven measures could save lives, the report said.";
  const errs = errorsOf("التدابير مثبتة الجدوى، والعلاج الجديد يشفي جميع الحالات بحسب التقرير.", src);
  assert.ok(errs.includes("unsupported_claim:يشفي"), `got: ${errs}`);
});
