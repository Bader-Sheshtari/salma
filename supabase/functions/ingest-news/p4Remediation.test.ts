// P4R — Phase-4 remediation (Objective A + B3) regression and counter-tests.
//
// Pure fixtures only — NO live model calls, NO network, NO DB. Every item has a
// regression test (the Phase-4 gate failure it fixes) and a counter-test (the
// guard it must NOT weaken). Fixtures quote the Phase-4 corpora (P14/P15/D18
// numbers, F11 SFDA page, O19 Kuwait excerpt) verbatim where it matters.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildWritingInstructions,
  checkFactGrounding,
  editorialQualityWarnings,
  EDITORIAL_EXCERPT_LEAD_JACCARD,
  EXCERPT_DEFINITION,
  excerptDuplicatesLead,
  inventedForeignGlosses,
  isNameLikeGloss,
  NATURAL_ARABIC_LINES,
  NO_INVENTED_LATIN_RULE,
  parseWriterOutput,
  RATIO_RULE,
  regulatorGroup,
  regulatorPresent,
  REGULATOR_EQUIVALENTS,
  SOURCE_ORDER_MIN_ANCHORS,
  SOURCE_ORDER_RHO,
  sourceOrderCorrelation,
  validateArticle,
  WRITER_ALLOWED_FIELDS,
  WRITER_PROMPT_VERSION,
  WRITER_REPAIR_RESPONSE_FORMAT,
} from "./salmaWriter.ts";
import {
  buildEditorInstructions,
  buildFactPacket,
  type EditorArticle,
  type EditorCall,
  type EditorCallResult,
  EDITOR_PROMPT_VERSION,
  EDITOR_RESPONSE_FORMAT,
  editorialGate,
  repairableEditorialIssues,
  repairIssueText,
  RESTORE_SCOPE_RULE,
  revalidateAgainstBaseline,
  runEditorPass,
} from "./salmaEditor.ts";
import { classifyFidelityError, finalizeWriterDraft, makeFidelityRepairCall } from "./fidelityRepair.ts";
import { extractArticle, extractEssentialEntities } from "./fetchSourceText.ts";
import {
  ARABIC_GLOSSARY,
  buildGlossaryPromptBlock,
  GCC_REGULATOR_COUNTRY_RULE,
  renderGlossaryMarkdown,
} from "./glossaryAr.ts";

const PROFILES = ["standard_news", "regulation_or_service", "safety_alert", "research_study"] as const;

function numberErrors(draft: string, source: string, sourceLang: string | null = null): string[] {
  return checkFactGrounding(
    { title: "عنوان", excerpt: "", body: draft },
    { sourceText: source, sourceLang },
    "standard_news",
  ).errors.filter((e) => e.startsWith("unsupported_number"));
}

// =========================================================================
// Versions
// =========================================================================

test("P4R versions: writer e2.3-salma-writer / editor e2.3-salma-editor, carried in the prompts", () => {
  assert.equal(WRITER_PROMPT_VERSION, "e2.3-salma-writer");
  assert.equal(EDITOR_PROMPT_VERSION, "e2.3-salma-editor");
  for (const p of PROFILES) {
    assert.ok(buildWritingInstructions(p).includes("e2.3-salma-writer"), p);
    assert.ok(buildEditorInstructions(p).includes("e2.3-salma-editor"), p);
  }
});

// =========================================================================
// P4R-1 — extraction procedure + excerpt definition (prompt text)
// =========================================================================

test("P4R-1 writer prompt states extraction as a procedure (core answer, importance order, no source mirroring, drop dead paragraphs)", () => {
  for (const p of PROFILES) {
    const w = buildWritingInstructions(p);
    assert.ok(w.includes("طريقة الاستخلاص (إجراء إلزامي قبل الكتابة)"), p);
    assert.ok(w.includes("«ما الجديد الذي يهم القارئ؟»"), p);
    assert.ok(w.includes("دون أن تكتبه في المخرجات"), p);
    assert.ok(w.includes("رتّب الفقرات بحسب أهميتها لهذا الجواب"), p);
    assert.ok(w.includes("ممنوع أن تحاكي ترتيب فقرات المصدر فقرةً فقرة، إلا إذا تطابق ترتيب الأهمية مع ترتيب المصدر فعلاً"), p);
    assert.ok(w.includes("أسقط كل فقرة من المصدر لا تضيف شيئاً"), p);
  }
});

test("P4R-1 counter: the procedure is internal — the output contract is still the bare JSON object, no new field", () => {
  const w = buildWritingInstructions("standard_news");
  assert.ok(w.includes(`{"title":"…","excerpt":"…","summary":"…","body":"فقرات مفصولة بسطر فارغ"}`));
  assert.ok(!w.includes("\"core_answer\""));
  assert.ok(!w.includes("\"profile\""));
  assert.ok(!w.includes("أثبت"));
});

test("P4R-1 both prompts define the excerpt as the stake («لماذا يهمّني هذا؟») with no reuse of the lead's verbs/key nouns", () => {
  for (const p of PROFILES) {
    const w = buildWritingInstructions(p);
    const e = buildEditorInstructions(p);
    for (const s of [w, e]) {
      assert.ok(s.includes(EXCERPT_DEFINITION), p);
      assert.ok(s.includes("«لماذا يهمّني هذا؟»"), p);
      assert.ok(s.includes("لا يعيد المقتطف استخدام أفعال المقدّمة ولا أسمائها الرئيسية إلا اسم الموضوع نفسه"), p);
    }
  }
});

test("P4R-1 counter: the old excerpt definition is gone and the excerpt may not invent a consequence", () => {
  const e = buildEditorInstructions("standard_news");
  assert.ok(!e.includes("المقتطف يشرح الحدث المركزي ويدعم العنوان"));
  const w = buildWritingInstructions("standard_news");
  assert.ok(!w.includes("تنقل الخلاصة العملية بلغة بسيطة لا أكاديمية"));
  for (const s of [w, e]) assert.ok(s.includes("ولا يضيف عاقبة لا يذكرها المصدر"));
});

// =========================================================================
// P4R-2 — natural-Arabic targeted lines
// =========================================================================

test("P4R-2 both prompts carry verb–subject agreement, وسيط vs متوسط, and the no-calques list", () => {
  for (const p of PROFILES) {
    for (const s of [buildWritingInstructions(p), buildEditorInstructions(p)]) {
      assert.ok(s.includes(NATURAL_ARABIC_LINES), p);
      assert.ok(s.includes("«يتابع المركز» لا «تتابع المركز»"), p);
      assert.ok(s.includes("median = «الوسيط»"), p);
      assert.ok(s.includes("mean/average = «المتوسط»"), p);
      assert.ok(s.includes("«تأكّد الفحص» ← «أكّد الفحص»"), p);
      assert.ok(s.includes("«قام بإجراء» ← «أجرى»"), p);
    }
  }
});

test("P4R-2 counter: the calque list never models a blocked claim word or a numeric word target", () => {
  assert.ok(!NATURAL_ARABIC_LINES.includes("أثبت"));
  assert.ok(!/\d+\s*كلمة/.test(NATURAL_ARABIC_LINES));
  assert.ok(!NATURAL_ARABIC_LINES.includes("~"));
});

// =========================================================================
// P4R-3 — glossary (single source of truth + mirrored doc) + GCC rule
// =========================================================================

test("P4R-3 the glossary has ~40 entries with one approved spelling each (no duplicate Latin keys)", () => {
  assert.ok(ARABIC_GLOSSARY.length >= 38 && ARABIC_GLOSSARY.length <= 50, String(ARABIC_GLOSSARY.length));
  const latin = ARABIC_GLOSSARY.map((e) => e.latin.toLowerCase());
  assert.equal(new Set(latin).size, latin.length);
  const byLatin = (k: string) => ARABIC_GLOSSARY.find((e) => e.latin.startsWith(k))?.arabic;
  assert.equal(byLatin("FDA"), "إدارة الغذاء والدواء الأميركية");
  assert.equal(byLatin("SFDA"), "الهيئة العامة للغذاء والدواء");
  assert.equal(byLatin("Ebola (Bundibugyo"), "إيبولا بونديبوجيو");
  assert.equal(byLatin("Shamonda"), "فيروس شاموندا");
  assert.equal(byLatin("Cyclospora"), "طفيلي السيكلوسبورا");
  assert.equal(byLatin("North Kivu"), "كيفو الشمالية");
});

test("P4R-3 both prompts inject the glossary block and the GCC-regulator country rule", () => {
  const block = buildGlossaryPromptBlock();
  for (const p of PROFILES) {
    for (const s of [buildWritingInstructions(p), buildEditorInstructions(p)]) {
      assert.ok(s.includes(block), p);
      assert.ok(s.includes(GCC_REGULATOR_COUNTRY_RULE), p);
      assert.ok(s.includes("«الهيئة العامة للغذاء والدواء السعودية»"), p);
    }
  }
  for (const e of ARABIC_GLOSSARY) assert.ok(block.includes(e.arabic), e.latin);
});

test("P4R-3 docs/editorial/GLOSSARY_AR.md is the generated mirror of the code constant", () => {
  const docPath = fileURLToPath(new URL("../../../docs/editorial/GLOSSARY_AR.md", import.meta.url));
  const doc = readFileSync(docPath, "utf8");
  assert.equal(doc, renderGlossaryMarkdown(), "GLOSSARY_AR.md drifted — regenerate it from glossaryAr.ts (command in the doc header)");
  assert.ok(doc.startsWith("<!-- GENERATED MIRROR"));
});

test("P4R-3 counter: the glossary never licenses a Latin gloss and every approved regulator spelling stays in its OWN group", () => {
  assert.ok(buildGlossaryPromptBlock().includes("لا يبيح وضع صيغة لاتينية بين قوسين إلا إذا وردت تلك الصيغة نفسها في المصدر"));
  const fda = regulatorGroup("FDA")!;
  const cdc = regulatorGroup("CDC")!;
  const sfda = regulatorGroup("SFDA")!;
  assert.ok(regulatorPresent(fda, "قالت إدارة الغذاء والدواء الأميركية إن…"));
  assert.ok(regulatorPresent(cdc, "أفادت المراكز الأميركية لمكافحة الأمراض والوقاية منها بأن…"));
  assert.ok(regulatorPresent(sfda, "وافقت الهيئة العامة للغذاء والدواء السعودية على…"));
  // Cross-matrix: no group is satisfied by another group's approved spelling.
  assert.ok(!regulatorPresent(fda, "أفادت المراكز الأميركية لمكافحة الأمراض والوقاية منها"));
  assert.ok(!regulatorPresent(sfda, "قالت إدارة الغذاء والدواء الأميركية"));
  assert.ok(!regulatorPresent(fda, "وافقت الهيئة العامة للغذاء والدواء السعودية"));
  assert.equal(REGULATOR_EQUIVALENTS.length, 5);
});

// =========================================================================
// P4R-4 — editor per-paragraph purpose (cutting) mandate
// =========================================================================

test("P4R-4 editor prompt carries the per-paragraph purpose test", () => {
  for (const p of PROFILES) {
    const e = buildEditorInstructions(p);
    assert.ok(e.includes("اختبار الغرض لكل فقرة (تفويض الحذف)"), p);
    assert.ok(e.includes("لو حُذفت، هل يتغيّر ما يعرفه القارئ أو ما يفعله أو ما يستنتجه؟ إن كان الجواب «لا» فاحذفها"), p);
  }
});

test("P4R-4 counter: the don't-force-changes balance and the must-keep list still bind the cut", () => {
  const e = buildEditorInstructions("safety_alert");
  assert.ok(e.includes("التوازن: إذا كانت المسوّدة ممتازة أصلاً فلا تفرض عليها تغييرات"));
  assert.ok(e.includes("لا تحذف فقرة تحمل عنصراً من قائمة «ما لا يُحذف»"));
  assert.ok(e.includes("ما لا يُحذف عند التبسيط أو الاختصار"));
  // Writer-only mandate stays out of the writer prompt (the writer has its own procedure).
  assert.ok(!buildWritingInstructions("safety_alert").includes("اختبار الغرض لكل فقرة"));
});

// =========================================================================
// P4R-5 — source_order_paraphrase (advisory measurement)
// =========================================================================

const ORDER_SOURCE =
  "Since 15 March 2026 and as of 14 April, a total of 19 161 suspected measles cases and 2973 laboratory-confirmed measles cases have been reported. " +
  "Moreover, 166 suspected measles-related deaths have been recorded. " +
  "A total of 12 318 hospital admissions and 9772 hospital discharges have also been reported. " +
  "The highest burden has been reported in Dhaka (8263 cases) and Rajshahi (3747 cases).";
// Mirrors the source paragraph order anchor-for-anchor.
const ORDER_MIRRORED =
  "منذ 15 مارس 2026 وحتى 14 أبريل سُجلت 19,161 حالة مشتبه بها و2,973 حالة مؤكدة مخبرياً.\n\n" +
  "وسُجلت 166 وفاة مشتبه بها مرتبطة بالحصبة.\n\n" +
  "كما أُبلغ عن 12,318 حالة دخول إلى المستشفى و9,772 حالة خروج.\n\n" +
  "وتتركز أعلى الحصائل في دكا (Dhaka) بـ8,263 حالة وراجشاهي بـ3,747 حالة.";
// Same facts, ordered by importance to the reader (deaths/hospital load first).
const ORDER_REORDERED =
  "أودت الحصبة بحياة 166 شخصاً يُشتبه في إصابتهم، ونُقل 12,318 مريضاً إلى المستشفيات خرج منهم 9,772.\n\n" +
  "وتتركز الإصابات في دكا (Dhaka) بـ8,263 حالة وراجشاهي بـ3,747 حالة.\n\n" +
  "وبلغ مجموع الحالات المشتبه بها 19,161 حالة، منها 2,973 حالة مؤكدة مخبرياً، منذ 15 مارس 2026 وحتى 14 أبريل.";

test("P4R-5 a draft mirroring the source order fires source_order_paraphrase (writer warning + gate advisory)", () => {
  const c = sourceOrderCorrelation(ORDER_MIRRORED, ORDER_SOURCE, { sourceLang: "en" });
  assert.ok(c.matched >= SOURCE_ORDER_MIN_ANCHORS, String(c.matched));
  assert.ok(c.rho !== null && c.rho >= SOURCE_ORDER_RHO, String(c.rho));
  assert.equal(c.fires, true);
  const v = validateArticle({
    article: { title: "تفشٍّ واسع للحصبة في بنغلاديش يرفع الوفيات", excerpt: "الضغط على المستشفيات يتزايد.", body: ORDER_MIRRORED, profile: "standard_news" },
    source: { sourceText: ORDER_SOURCE, sourceLang: "en" },
  });
  assert.ok(v.warnings.includes("source_order_paraphrase"), v.warnings.join(","));
  // Advisory only: never an error.
  assert.ok(!v.errors.some((e) => e.includes("source_order")));
  const gate = editorialGate(
    { title: "تفشٍّ واسع للحصبة في بنغلاديش", excerpt: "الضغط على المستشفيات يتزايد.", summary: "", body: ORDER_MIRRORED },
    "standard_news",
    { sourceText: ORDER_SOURCE },
  );
  // Gate: recorded in the advisory tier only — never blocking, never a verdict
  // change, never a repair trigger.
  assert.ok(gate.advisory.includes("source_order_paraphrase"));
  assert.ok(!gate.needs_review.includes("source_order_paraphrase"));
  assert.ok(!gate.blocking.includes("source_order_paraphrase"));
  assert.ok(!repairableEditorialIssues(gate).includes("source_order_paraphrase"));
});

test("P4R-5 counter: a draft reordered by importance does not fire; too few anchors never fire", () => {
  const c = sourceOrderCorrelation(ORDER_REORDERED, ORDER_SOURCE, { sourceLang: "en" });
  assert.ok(c.matched >= SOURCE_ORDER_MIN_ANCHORS, String(c.matched));
  assert.ok(c.rho !== null && c.rho < SOURCE_ORDER_RHO, String(c.rho));
  assert.equal(c.fires, false);
  const gate = editorialGate(
    { title: "تفشٍّ واسع للحصبة في بنغلاديش", excerpt: "الضغط على المستشفيات يتزايد.", summary: "", body: ORDER_REORDERED },
    "standard_news",
    { sourceText: ORDER_SOURCE },
  );
  assert.ok(!gate.advisory.includes("source_order_paraphrase"));
  // Four anchors in perfect order: below the minimum, no flag.
  const few = sourceOrderCorrelation("سُجلت 19,161 حالة و2,973 مؤكدة و166 وفاة و12,318 دخولاً.", ORDER_SOURCE, { sourceLang: "en" });
  assert.equal(few.fires, false);
  // No source → the gate never computes it.
  const noSrc = editorialGate({ title: "ع", excerpt: "م", summary: "", body: ORDER_MIRRORED }, "standard_news");
  assert.ok(!noSrc.advisory.includes("source_order_paraphrase"));
});

// =========================================================================
// P4R-6 — number folding (spaces / NBSP / thin / narrow NBSP, scale words, decimal comma)
// =========================================================================

// P14 (WHO DON598, Measles – Bangladesh), verbatim.
const P14_SOURCE =
  "Since 15 March 2026 and as of 14 April, a total of 19 161 suspected measles cases and 2973 laboratory-confirmed measles cases have been reported. " +
  "A total of 12 318 hospital admissions and 9772 hospital discharges have also been reported.";
const P14_DRAFT =
  "ومنذ 15 مارس 2026 وحتى 14 أبريل، سُجلت 19,161 حالة مشتبه بها و2,973 حالة مؤكدة مخبرياً. كما أُبلغ عن 12,318 حالة دخول إلى المستشفى و9,772 حالة خروج.";

test("P4R-6 P14: NBSP/thin/narrow-NBSP source groups ground the comma-grouped draft (any language)", () => {
  for (const sep of ["\u00A0", "\u2009", "\u202F"]) {
    const src = P14_SOURCE.replace("19 161", `19${sep}161`).replace("12 318", `12${sep}318`);
    assert.deepEqual(numberErrors(P14_DRAFT, src, null), [], JSON.stringify(sep));
    assert.deepEqual(numberErrors(P14_DRAFT, src, "en"), [], JSON.stringify(sep));
  }
});

test("P4R3-2 → NF-1 a PLAIN-space 3-digit group folds in ANY language (no source_lang gate)", () => {
  for (const lang of ["fr", "ro-RO", "en", null]) {
    assert.deepEqual(numberErrors(P14_DRAFT, P14_SOURCE, lang), [], String(lang));
  }
  assert.deepEqual(numberErrors("سُجلت 19,162 حالة.", "a total of 19 161 suspected cases", null), ["unsupported_number:19,162"]);
});

test("P4R3-2 → NF-1 «phase 3 100 patients»: 3101 fails (3100 is the documented residual); the draft never merges a plain space", () => {
  const src = "The phase 3 100 patients cohort was followed for two years.";
  assert.deepEqual(numberErrors("شملت الدراسة 3101 مريض.", src, null), ["unsupported_number:3101"]);
  assert.deepEqual(numberErrors("شملت الدراسة 3100 مريض.", src, null), []); // accepted residual (NF-1 comment)
  assert.deepEqual(numberErrors("في المرحلة 3 100 مريض.", "a phase 3 trial with 100 patients", "en"), []);
  assert.deepEqual(numberErrors("في المرحلة 3 100 مريض.", "a phase 3 trial with 90 patients", "en"), ["unsupported_number:100"]);
});

test("P4R-6 P15: «694 ألف» ↔ «694 000» ↔ «694,000» (scale words both sides)", () => {
  // P15 (WHO breast-cancer survival estimates); the extractor keeps &nbsp; between digits as U+00A0.
  const src = "In 2024, it resulted in approximately 694\u00A0000 deaths globally – 70% in low- and middle-income countries.";
  assert.deepEqual(numberErrors("تسبب في نحو 694 ألف وفاة عالمياً في 2024، كانت 70% منها في البلدان منخفضة ومتوسطة الدخل.", src, "en"), []);
  assert.deepEqual(numberErrors("تسبب في نحو 694,000 وفاة عالمياً في 2024.", src, "en"), []);
  assert.deepEqual(numberErrors("تسبب في نحو 694\u00A0000 وفاة عالمياً في 2024.", src, "en"), []);
  assert.deepEqual(numberErrors("نحو 694,000 وفاة.", "about 694 thousand deaths", "en"), []);
});

test("P4R-6 D18: decimal comma in a Romanian source (82,2 ↔ 82.2) under the threaded sourceLang", () => {
  // D18 (hotnews.ro, Romanian), verbatim; develop-story now threads sourceLang.
  const src = "Dintre cei care au primit vaccinul în plus față de Keytruda, 82,2% erau încă fără cancer după doi ani, comparativ cu 70% dintre pacienții care au primit doar Keytruda.";
  assert.deepEqual(numberErrors("وبعد عامين من العلاج، بقي 82.2% من الذين تلقوا اللقاح مع كيترودا بلا سرطان، مقابل 70% ممن تلقوا كيترودا وحده.", src, "ro"), []);
  assert.deepEqual(numberErrors("بقي 82,2% بلا سرطان مقابل 70%.", src, "ro"), []);
  // An explicitly non-English, non-EU language also gets the decimal-comma fallback.
  assert.deepEqual(numberErrors("بقي 82.2% بلا سرطان.", "82,2% bebas kanker", "id"), []);
});

test("P4R3-3 → NF-1 decimal comma is read in ANY language («1,2» = 1.2, «82,2» = 82.2), wrong values still fail", () => {
  assert.deepEqual(numberErrors("قيمة 1.2 وحدة.", "the value was 1,2 units.", null), []);
  assert.deepEqual(numberErrors("قيمة 1.3 وحدة.", "the value was 1,2 units.", null), ["unsupported_number:1.3"]);
  assert.deepEqual(numberErrors("بقي 82.2% بلا سرطان.", "82,2% erau încă fără cancer", null), []);
  assert.deepEqual(numberErrors("بقي 82.2% بلا سرطان.", "82,2% erau încă fără cancer", "ro"), []);
});

test("P4R-6 counter: 19,162 vs “19 161” still fails; «695 ألف» vs “694 000” fails; “82,3” vs “82,2” fails", () => {
  assert.deepEqual(numberErrors("سُجلت 19,162 حالة.", "a total of 19\u00A0161 suspected cases", null), ["unsupported_number:19,162"]);
  assert.deepEqual(numberErrors("سُجلت 19,162 حالة.", "a total of 19 161 suspected cases", "fr"), ["unsupported_number:19,162"]);
  assert.deepEqual(numberErrors("سُجلت 19\u00A0162 حالة.", "a total of 19\u2009161 suspected cases", null), ["unsupported_number:19 162"]);
  assert.deepEqual(numberErrors("نحو 695 ألف وفاة.", "approximately 694\u00A0000 deaths", "en"), ["unsupported_number:695"]);
  assert.deepEqual(numberErrors("بقي 82,3% بلا سرطان.", "82,2% erau încă fără cancer", "ro"), ["unsupported_number:82,3"]);
  assert.deepEqual(numberErrors("بقي 82.3% بلا سرطان.", "82,2% erau încă fără cancer", "ro"), ["unsupported_number:82.3"]);
  // NF-1: «1,50» is an unambiguous decimal comma (= 1.5); a different value fails.
  assert.ok(numberErrors("قيمة 1,50 وحدة.", "the value was exactly 1.6 units.", "en").length > 0);
  assert.deepEqual(numberErrors("في 2024 سُجلت 158 حالة.", "In 2024 158 cases were recorded.", "en"), []);
  assert.deepEqual(numberErrors("سُجلت 2024158 حالة.", "In 2024 158 cases were recorded.", "fr"), ["unsupported_number:2024158"]);
});

// =========================================================================
// P4R-7 — repair transport uses a writer-shaped strict schema
// =========================================================================

// ≥25 words so the draft is a real article (malformed_output is hard-blocking).
const REPAIR_BODY_WITH = (lot: string) =>
  `سحبت الشركة${lot}من الدواء بعد رصد جسيمات معدنية داخل بعض القوارير، وقد تسبب هذه الجسيمات خطر التجلّط لدى المرضى.\n\nونصحت الشركة المرضى والكوادر الطبية بالتوقف عن استخدام الدفعات المتأثرة إلى حين صدور تعليمات جديدة من الجهة المختصة.`;
const REPAIR_SOURCE =
  "سحبت الشركة دفعات من الدواء بعد رصد جسيمات معدنية داخل بعض القوارير، وقد تسبب هذه الجسيمات خطر التجلّط لدى المرضى. ونصحت الشركة المرضى والكوادر الطبية بالتوقف عن استخدام الدفعات المتأثرة إلى حين صدور تعليمات جديدة من الجهة المختصة.";
const REPAIR_DRAFT = {
  title: "سحب دفعات من دواء بعد رصد جسيمات",
  excerpt: "قد يتعرّض المرضى لخطر التجلّط.",
  summary: "التوقف عن استخدام الدفعات المتأثرة.",
  body: REPAIR_BODY_WITH(" 5 دفعات "),
};

test("P4R-7 WRITER_REPAIR_RESPONSE_FORMAT is writer-shaped, strict, and distinct from the editor schema", () => {
  const f = WRITER_REPAIR_RESPONSE_FORMAT;
  assert.equal(f.type, "json_schema");
  assert.equal(f.json_schema.strict, true);
  assert.equal(f.json_schema.schema.additionalProperties, false);
  assert.deepEqual(Object.keys(f.json_schema.schema.properties).sort(), [...WRITER_ALLOWED_FIELDS].sort());
  for (const k of ["title", "excerpt", "body"]) assert.ok((f.json_schema.schema.required as readonly string[]).includes(k), k);
  assert.ok(!("edit_applied" in f.json_schema.schema.properties));
  assert.notEqual(f.json_schema.name, EDITOR_RESPONSE_FORMAT.json_schema.name);
});

test("P4R-7 a stubbed repair round-trips through the writer parser with the writer schema", async () => {
  const sent: unknown[] = [];
  const repair = makeFidelityRepairCall({
    send: async (_messages: string, responseFormat) => {
      sent.push(responseFormat);
      return {
        ok: true,
        content: JSON.stringify({ title: REPAIR_DRAFT.title, excerpt: REPAIR_DRAFT.excerpt, summary: "", body: REPAIR_BODY_WITH(" دفعات ") }),
      };
    },
    buildMessages: (issues) => issues.join("|"),
    responseFormat: WRITER_REPAIR_RESPONSE_FORMAT,
    parse: parseWriterOutput,
  });
  const r = await repair(["unsupported_number:5"], REPAIR_DRAFT);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], WRITER_REPAIR_RESPONSE_FORMAT);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.article.body, REPAIR_BODY_WITH(" دفعات "));
    // An empty provider summary keeps the draft's own summary.
    assert.equal(r.article.summary, REPAIR_DRAFT.summary);
  }
  // End to end through the single-repair finalizer: the repaired draft is clean.
  const validate = (a: typeof REPAIR_DRAFT) => {
    const v = validateArticle({
      article: { ...a, profile: "standard_news" },
      source: { sourceText: REPAIR_SOURCE },
    });
    return { ok: v.ok, errors: v.errors, cleanTitle: v.cleanTitle, readMinutes: v.readMinutes };
  };
  const fin = await finalizeWriterDraft({
    runEditor: async () => ({ article: REPAIR_DRAFT, readMinutes: 1, audit: null }),
    validate,
    repair,
  });
  assert.deepEqual(fin.fidelity.audit.original_repairable, ["unsupported_number:5"]);
  assert.equal(fin.fidelity.audit.repair_attempted, true);
  assert.equal(fin.fidelity.audit.repair_call_succeeded, true);
  assert.equal(fin.fidelity.audit.draft_source, "repaired");
  assert.equal(fin.fidelity.decision, "clean");
});

test("P4R-7 counter: repair output carrying editor-only keys is still rejected by the strict writer parser", async () => {
  const repair = makeFidelityRepairCall({
    send: async () => ({
      ok: true,
      content: JSON.stringify({ ...REPAIR_DRAFT, edit_applied: true, editorial_verdict: "ready", issues_found: [], changes_made: [] }),
    }),
    buildMessages: () => "x",
    responseFormat: WRITER_REPAIR_RESPONSE_FORMAT,
    parse: parseWriterOutput,
  });
  const r = await repair(["unsupported_number:5"], REPAIR_DRAFT);
  assert.deepEqual(r, { ok: false, reason: "writer_output_schema_invalid" });
  // A transport failure stays a plain reason.
  const down = makeFidelityRepairCall({
    send: async () => ({ ok: false, reason: "editor_timeout" }),
    buildMessages: () => "x",
    responseFormat: WRITER_REPAIR_RESPONSE_FORMAT,
    parse: parseWriterOutput,
  });
  assert.deepEqual(await down([], REPAIR_DRAFT), { ok: false, reason: "editor_timeout" });
});

test("P4R-7 wiring: pipeline.ts sends the writer schema on the repair and keeps the editor schema as the editor default", () => {
  const src = readFileSync(fileURLToPath(new URL("./pipeline.ts", import.meta.url)), "utf8");
  assert.ok(src.includes("responseFormat: WRITER_REPAIR_RESPONSE_FORMAT,"));
  assert.ok(src.includes("parse: parseWriterOutput,"));
  assert.ok(src.includes("response_format: opts.responseFormat ?? EDITOR_RESPONSE_FORMAT,"));
  // The old inline repair that forced the editor schema is gone.
  assert.ok(!/repair: async \(issues, draft\) => \{\s*const res = await chatEditor\(/.test(src));
});

// =========================================================================
// P4R-8 — invented_foreign_gloss (blocking, repairable)
// =========================================================================

// F11 (sfda.gov.sa/ar/news/19679), verbatim lines — Arabic only, no Latin name.
const F11_SOURCE =
  "\"الغذاء والدواء\" توافق على تعيين \"إنفيلبراي\" كدواء واعد لعلاج المصابين بمرض غوشيه من النوع الثالث\n\n" +
  "وافقت الهيئة العامة للغذاء والدواء على طلب شركة سانوفي بتعيين \"إنفیلبراي\"، المحتوي على المادة الفعالة \"فينغلوستات\"، ضمن مسار الأدوية الواعدة، لعلاج المرضى من عمر سنتين فأكثر المصابين بمرض \"غوشيه\" من النوع الثالث، ويُستخدم الدواء علاجًا طويل الأمد للمساهمة في علاج الأعراض العصبية والمحافظة على الاستقرار الجهازي الذي تحقق سابقًا بالعلاج التعويضي بالإنزيم.\n\n" +
  "وأوضحت الهيئة أن قرار تعيين الدواء لا يعني تسجيله، وإنما يُعد موافقة للشركة على تقديمه ضمن هذا المسار وفق شروط وآليات محددة.";
// F11-1 editor first edit (the invented gloss), verbatim first paragraph.
const F11_EDIT_BODY =
  "وافقت الهيئة العامة للغذاء والدواء على تعيين إنفيلبراي (Enfilbry) ضمن مسار الأدوية الواعدة لعلاج المصابين بمرض غوشيه من النوع الثالث، بما يتيح لشركة سانوفي التقدّم به وفق هذا المسار قبل قرار التسجيل النهائي.\n\n" +
  "ويستهدف الدواء المرضى من عمر سنتين فأكثر، ويُستخدم علاجًا طويل الأمد للمساهمة في علاج الأعراض العصبية والمحافظة على الاستقرار الجهازي الذي تحقق سابقًا بالعلاج التعويضي بالإنزيم. والمادة الفعالة فيه هي فينغلوستات.";
const F11_WRITER_BODY = F11_EDIT_BODY.replace("إنفيلبراي (Enfilbry)", "دواء إنفيلبراي");
const F11_FIELDS = {
  title: "الغذاء والدواء توافق على تعيين إنفيلبراي دواءً واعدًا لغوشيه من النوع الثالث",
  excerpt: "التعيين يسمح للشركة بالتقدّم بالدواء ضمن مسار مخصّص للأدوية الواعدة قبل قرار التسجيل.",
  summary: "القرار لا يعني تسجيل الدواء بعد.",
};

test("P4R-8 F11: «إنفيلبراي (Enfilbry)» against an Arabic-only source is a blocking invented_foreign_gloss", () => {
  const fg = checkFactGrounding({ ...F11_FIELDS, body: F11_EDIT_BODY }, { sourceText: F11_SOURCE }, "regulation_or_service");
  assert.ok(fg.errors.includes("invented_foreign_gloss:Enfilbry"), fg.errors.join(","));
  const v = validateArticle({ article: { ...F11_FIELDS, body: F11_EDIT_BODY, profile: "regulation_or_service" }, source: { sourceText: F11_SOURCE } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes("invented_foreign_gloss:Enfilbry"));
  // Same class as an invented quotation: the single fidelity repair may delete it.
  assert.equal(classifyFidelityError("invented_foreign_gloss:Enfilbry"), "repairable");
  // The summary is covered too.
  const s = checkFactGrounding({ ...F11_FIELDS, summary: "إنفيلبراي (Enfilbry) لم يُسجَّل بعد.", body: F11_WRITER_BODY }, { sourceText: F11_SOURCE }, "regulation_or_service");
  assert.ok(s.errors.includes("invented_foreign_gloss:Enfilbry"));
});

test("P4R-8 F11: an editor edit that invents the gloss fails baseline re-validation; the writer draft is kept", async () => {
  const revalidateReal = (baseline: string[]) => (a: EditorArticle) => {
    const v = validateArticle({ article: { ...a, profile: "regulation_or_service" }, source: { sourceText: F11_SOURCE } });
    return revalidateAgainstBaseline(v, baseline);
  };
  const original: EditorArticle = { ...F11_FIELDS, body: F11_WRITER_BODY };
  const baseline = validateArticle({ article: { ...original, profile: "regulation_or_service" }, source: { sourceText: F11_SOURCE } }).errors;
  assert.deepEqual(baseline, []);
  const call: EditorCall = async () => ({
    ok: true,
    content: JSON.stringify({ ...F11_FIELDS, body: F11_EDIT_BODY, edit_applied: true, editorial_verdict: "ready", issues_found: [], changes_made: ["تعديل"] }),
  });
  const res = await runEditorPass({
    profile: "regulation_or_service",
    model: "openai/gpt-5.4-mini",
    original: { article: original, readMinutes: 1 },
    packet: buildFactPacket({ profile: "regulation_or_service", sourceText: F11_SOURCE, mustPreserve: [] }),
    call,
    revalidate: revalidateReal(baseline),
  });
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.decision, "factual_rejected");
  assert.ok(String(res.audit.editor_rejection_reason).includes("invented_foreign_gloss:Enfilbry"));
  assert.equal(res.article.body, F11_WRITER_BODY);
});

test("P4R-8 counter: source-backed glosses pass (Papaverine … Injection, USP; Spectra Medical Devices; dropped labels; Arabic in parens)", () => {
  const papSrc = "American Regent is voluntarily recalling one lot of Papaverine Hydrochloride Injection, USP 30 mg/mL due to particulate matter.";
  assert.deepEqual(inventedForeignGlosses(["سحبت الشركة دفعة من حقن بابافيرين (Papaverine Hydrochloride Injection, USP)."], papSrc), []);
  // A droppable label/dosage-form phrase omitted from the gloss still matches.
  assert.deepEqual(inventedForeignGlosses(["بابافيرين (Papaverine Hydrochloride Injection)"], papSrc), []);
  assert.deepEqual(inventedForeignGlosses(["سيكلوفوسفاميد (Cyclophosphamide)"], "Cyclophosphamide for Injection, USP"), []);
  const specSrc = "Spectra Medical Devices, LLC is recalling certain catheters.";
  assert.deepEqual(inventedForeignGlosses(["شركة سبكترا (Spectra Medical Devices)"], specSrc), []);
  assert.deepEqual(inventedForeignGlosses(["(spectra  medical devices)"], specSrc), []);
  // Parentheses without ≥2 Latin letters are not glosses.
  assert.deepEqual(inventedForeignGlosses(["نحو 30 حالة (أي 5%)"], specSrc), []);
  // A Latin form ALSO present in an Arabic source (F11 «(ER+)») passes.
  assert.deepEqual(inventedForeignGlosses(["مستقبلات الإستروجين (ER+)"], "سرطان الثدي الموجب لمستقبلات الإستروجين (ER+) والسالب لـHER2"), []);
  // …but a near-miss identity still blocks (no fuzzy matching).
  assert.deepEqual(inventedForeignGlosses(["بابافيرين (Papaverine Sulfate)"], papSrc), ["Papaverine Sulfate"]);
});

test("P4R-8 editor prompt carve-out: no Latin form in the source ⇒ the Arabic name stands alone", () => {
  for (const p of PROFILES) {
    const e = buildEditorInstructions(p);
    assert.ok(e.includes(`استثناء: ${NO_INVENTED_LATIN_RULE}`), p);
    assert.ok(e.includes("ممنوع اختراع صيغة لاتينية"), p);
    assert.ok(buildWritingInstructions(p).includes(NO_INVENTED_LATIN_RULE), p);
    // Counter: the exact-original-identity rule for source-backed names is unchanged.
    assert.ok(e.includes("لا تحذف الاسم الأجنبي الأصلي بالكامل مطلقاً"), p);
  }
});

// =========================================================================
// P4R-9 — excerpt duplicating the lead (content words, 0.5) is repairable
// =========================================================================

// O19 (gulfnews, Kuwait shuts five facilities) — writer excerpt + lead, verbatim.
const O19_EXCERPT =
  "الكويت أغلقت خمسة مرافق صحية خاصة وعلّقت عمل مختبر في منشأة سادسة بعد مخالفات رصدتها التفتيشات وُصفت بأنها قد تهدد سلامة المرضى.";
const O19_BODY =
  "أغلقت الكويت خمسة مرافق صحية خاصة وعلّقت عمل مختبر في منشأة سادسة بعد تفتيشات كشفت مخالفات قالت السلطات إنها قد تهدد سلامة المرضى.\n\n" +
  "ومن بين المخالفات التي رصدها المفتشون أن ممرضة أجرت إجراءً بالليزر لمريض من دون التصريح المطلوب، وأن طبيب أسنان أجرى فحوص أشعة من دون ترخيص لممارسة الأشعة.";
const O19_TITLE = "الكويت تغلق خمسة مرافق صحية وتوقف مختبراً بسبب مخالفات تهدد سلامة المرضى";
const O19_SUMMARY = "تبقى القرارات سارية إلى أن تستكمل الجهات المختصة التحقيقات.";
const O19_DISTINCT_EXCERPT = "قد تؤثر هذه المخالفات في دقة الفحوص المخبرية وسلامة الإجراءات التي يتلقاها المرضى.";

test("P4R-9 O19: the writer excerpt restating the lead flags (writer + gate) and is repairable", () => {
  assert.equal(EDITORIAL_EXCERPT_LEAD_JACCARD, 0.5);
  assert.equal(excerptDuplicatesLead(O19_EXCERPT, O19_BODY), true);
  const w = editorialQualityWarnings({ title: O19_TITLE, excerpt: O19_EXCERPT, body: O19_BODY }, "regulation_or_service");
  assert.ok(w.includes("editorial_excerpt_duplicates_opening"), w.join(","));
  const gate = editorialGate({ title: O19_TITLE, excerpt: O19_EXCERPT, summary: O19_SUMMARY, body: O19_BODY }, "regulation_or_service");
  assert.ok(gate.needs_review.includes("editorial_excerpt_duplicates_opening"));
  assert.ok(repairableEditorialIssues(gate).includes("editorial_excerpt_duplicates_opening"));
  assert.ok(repairIssueText("editorial_excerpt_duplicates_opening").includes("«لماذا يهمّني هذا؟»"));
});

test("P4R-9 O19: one editorial repair rewrites the excerpt as the stake and replaces the first edit", async () => {
  const first = JSON.stringify({ title: O19_TITLE, excerpt: O19_EXCERPT, summary: O19_SUMMARY, body: O19_BODY, edit_applied: true, editorial_verdict: "ready", issues_found: [], changes_made: ["تعديل"] });
  const repaired = JSON.stringify({ title: O19_TITLE, excerpt: O19_DISTINCT_EXCERPT, summary: O19_SUMMARY, body: O19_BODY, edit_applied: true, editorial_verdict: "ready", issues_found: [], changes_made: ["إعادة كتابة المقتطف"] });
  const results: EditorCallResult[] = [{ ok: true, content: first }, { ok: true, content: repaired }];
  const kinds: string[] = [];
  const issues: (string[] | null)[] = [];
  let n = 0;
  const call: EditorCall = async (_m, opts) => {
    kinds.push(opts?.repair ? "repair" : opts?.strictRecovery ? "recovery" : "normal");
    issues.push(opts?.repair?.issues ?? null);
    return results[Math.min(n++, results.length - 1)];
  };
  const original: EditorArticle = { title: O19_TITLE, excerpt: O19_EXCERPT, summary: O19_SUMMARY, body: O19_BODY };
  const res = await runEditorPass({
    profile: "regulation_or_service",
    model: "openai/gpt-5.4-mini",
    original: { article: original, readMinutes: 1 },
    packet: buildFactPacket({ profile: "regulation_or_service", sourceText: "—", mustPreserve: [] }),
    call,
    revalidate: (a) => ({ ok: true, readMinutes: 1, cleanTitle: a.title }),
  });
  assert.deepEqual(kinds, ["normal", "repair"]);
  assert.deepEqual(issues[1], ["editorial_excerpt_duplicates_opening"]);
  assert.equal(res.audit.final_draft_source, "repaired_edit");
  assert.equal(res.article.excerpt, O19_DISTINCT_EXCERPT);
  assert.ok(!res.audit.editorial_review.includes("editorial_excerpt_duplicates_opening"));
});

test("P4R-9 counter: a distinct (stake) excerpt passes; excerpt↔title and summary↔excerpt thresholds unchanged", () => {
  assert.equal(excerptDuplicatesLead(O19_DISTINCT_EXCERPT, O19_BODY), false);
  const w = editorialQualityWarnings({ title: O19_TITLE, excerpt: O19_DISTINCT_EXCERPT, body: O19_BODY }, "regulation_or_service");
  assert.ok(!w.includes("editorial_excerpt_duplicates_opening"));
  const gate = editorialGate({ title: O19_TITLE, excerpt: O19_DISTINCT_EXCERPT, summary: O19_SUMMARY, body: O19_BODY }, "regulation_or_service");
  assert.ok(!gate.needs_review.includes("editorial_excerpt_duplicates_opening"));
  // Shared subject words alone (the subject may be repeated) do not reach 0.5.
  assert.equal(excerptDuplicatesLead("مرافق الكويت الصحية المغلقة قد تعود للعمل بعد تصحيح المخالفات.", O19_BODY), false);
});

// =========================================================================
// P4R-10 — product-name capture: word-boundary, quote pairing, no verb starts
// =========================================================================

test("P4R-10 F11 footer lines yield no verb-phrase entity («توافق على تعيين»، «تعتمد تسجيل مستحضر»)", () => {
  const footer = "\"الغذاء والدواء\" توافق على تعيين \"بوفيتاكيسبت\" ضمن مسار الأدوية الواعدة";
  assert.deepEqual(extractEssentialEntities(footer), []);
  const title = "\"الغذاء والدواء\" توافق على تعيين \"إنفيلبراي\" كدواء واعد لعلاج المصابين بمرض غوشيه من النوع الثالث";
  assert.deepEqual(extractEssentialEntities(title), []);
  const jas = "\"الغذاء والدواء\" تعتمد تسجيل مستحضر \"جاسكايد\" لعلاج مرض التليف الرئوي مجهول السبب لدى البالغين";
  const ents = extractEssentialEntities(jas);
  assert.ok(!ents.includes("تعتمد تسجيل مستحضر"), ents.join(","));
  assert.ok(!ents.some((e) => /^(?:تعتمد|توافق)/.test(e)), ents.join(","));
});

test("P4R-10 counter: «مستحضر \"جاسكايد\"» and «دواء «X»» still extract; «الدواء» with the article still anchors", () => {
  assert.deepEqual(extractEssentialEntities("اعتمدت الهيئة تسجيل مستحضر \"جاسكايد\" لعلاج التليف الرئوي."), ["جاسكايد"]);
  assert.ok(extractEssentialEntities("\"الغذاء والدواء\" تعتمد تسجيل مستحضر \"جاسكايد\" لعلاج مرض التليف الرئوي").includes("جاسكايد"));
  assert.ok(extractEssentialEntities("سحبت الشركة دواء «سيكلوفوسفاميد» من الأسواق.").includes("سيكلوفوسفاميد"));
  assert.ok(extractEssentialEntities("حذّرت الهيئة من الدواء \"ميثوتريكسات\" المغشوش.").includes("ميثوتريكسات"));
});

// =========================================================================
// P4R-11 — restore keeps its own subject/scope; ratio rule repeats the denominator
// =========================================================================

test("P4R-11 restore repair texts keep the item's own subject and scope (no audience merge)", () => {
  for (const code of ["restore_missing_action:stop_use", "restore_missing_action:return", "restore_missing_entity:سيكلوفوسفاميد"]) {
    const t = repairIssueText(code);
    assert.ok(t.includes(RESTORE_SCOPE_RULE), code);
    assert.ok(t.includes("بفاعله ونطاقه كما وردا في جملة المصدر نفسها"), code);
    assert.ok(t.includes("ولا تدمجه مع توصية أو إجراء موجّه إلى جمهور مختلف"), code);
  }
  const sys = buildEditorInstructions("safety_alert", { repairIssues: ["restore_missing_action:return"] });
  assert.ok(sys.includes(RESTORE_SCOPE_RULE));
});

test("P4R-11 counter: non-restore repair texts are unchanged (no scope rule leaks into wording fixes)", () => {
  assert.ok(!repairIssueText("editorial_unnecessary_voluntary").includes(RESTORE_SCOPE_RULE));
  assert.ok(repairIssueText("restore_missing_entity:X").startsWith("أعِد إلى النص العنصر الناقص: X كما ورد في المصدر"));
});

test("P4R-11 both prompts carry the ratio rule: repeat the denominator noun, never infer it", () => {
  for (const p of PROFILES) {
    for (const s of [buildWritingInstructions(p), buildEditorInstructions(p)]) {
      assert.ok(s.includes(RATIO_RULE), p);
      assert.ok(s.includes("«وفاة واحدة من كل ثماني وفيات»"), p);
      assert.ok(s.includes("كرّر اسم المقام كما ورد في المصدر"), p);
      assert.ok(s.includes("ولا تستنتجه"), p);
    }
  }
});

// =========================================================================
// P4R3 — review fixes
// =========================================================================

test("P4R3-1 an attached proclitic before the product keyword still captures («ودواء»، «بلقاح»)", () => {
  assert.ok(extractEssentialEntities("وحذّرت الهيئة من المستحضر المغشوش ودواء «نوروفين بلس» المقلّد.").includes("نوروفين بلس"));
  assert.ok(extractEssentialEntities("وبدأت الحملة بالتطعيم بلقاح «إكس» في المدارس.").includes("إكس"));
  assert.ok(extractEssentialEntities("ونصحت بعدم استخدام لدواء \"زيد\" مؤقتاً.").includes("زيد"));
});

test("P4R3-1 counter: the agency name «الغذاء والدواء» never anchors a capture (footer lines yield nothing)", () => {
  assert.deepEqual(extractEssentialEntities("\"الغذاء والدواء\" تعتمد تسجيل \"بوفيتاكيسبت\" ضمن مسار الأدوية الواعدة"), []);
  assert.deepEqual(extractEssentialEntities("\"الغذاء والدواء\" توافق على تعيين \"بوفيتاكيسبت\" ضمن مسار الأدوية الواعدة"), []);
  assert.deepEqual(extractEssentialEntities("هيئة الغذاء والدواء «توضح» الإجراءات للغذاء والدواء «الجديدة»"), []);
});

test("P4R3-2 the extractor keeps &nbsp; between digits as U+00A0 (and nowhere else)", () => {
  const html = `<html><head><title>Measles</title></head><body><article><p>Since 15 March 2026 and as of 14 April, a total of 19&nbsp;161 suspected measles cases and 2973 laboratory-confirmed measles cases have been reported across the country.</p><p>A total of 12&#160;318 hospital admissions and 9772 hospital discharges have also been reported by the national surveillance&nbsp;system in all eight divisions.</p></article></body></html>`;
  const r = extractArticle(html);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.text.includes("19\u00A0161"), r.text);
    assert.ok(r.text.includes("12\u00A0318"));
    assert.ok(r.text.includes("surveillance system"));
    assert.ok(!r.text.includes("surveillance\u00A0system"));
    assert.deepEqual(numberErrors("سُجلت 19,161 حالة و12,318 حالة دخول.", r.text, null), []);
  }
});

test("P4R3-4 statistic, figure and bare-acronym brackets are not name glosses", () => {
  const src = "سجّلت الدراسة انخفاضاً في الخطر.";
  assert.deepEqual(inventedForeignGlosses(["انخفض الخطر (95% CI 1.2-2.3)."], src), []);
  assert.deepEqual(inventedForeignGlosses(["نسبة الخطر (HR 0.75)."], src), []);
  assert.deepEqual(inventedForeignGlosses(["إدارة الغذاء والدواء (FDA)."], src), []);
  assert.deepEqual(inventedForeignGlosses(["(OR, 1.4)", "(p = 0.03)", "(n = 44)"], src), []);
  assert.equal(isNameLikeGloss("Enfilbry"), true);
  assert.equal(isNameLikeGloss("Organon"), true);
});

test("P4R3-4 counter: an invented name gloss still blocks («(Enfilbry)», mixed-case names)", () => {
  assert.deepEqual(inventedForeignGlosses(["إنفيلبراي (Enfilbry)"], F11_SOURCE), ["Enfilbry"]);
  assert.deepEqual(inventedForeignGlosses(["شركة (Sunny Pharmtech)"], "سحبت شركة دفعات."), ["Sunny Pharmtech"]);
  assert.deepEqual(inventedForeignGlosses(["فيروس (MERS-CoV)"], "فيروس كورونا"), ["MERS-CoV"]);
});

test("P4R3-5 an invented gloss in the SUMMARY repairs to no summary (cleared, not restored) and the draft is clean", async () => {
  const draft = { ...REPAIR_DRAFT, body: REPAIR_BODY_WITH(" دفعات "), summary: "توقّف عن استخدام دواء (Enfilbry) المتأثر." };
  const validate = (a: typeof draft) => {
    const v = validateArticle({ article: { ...a, profile: "standard_news" }, source: { sourceText: REPAIR_SOURCE } });
    return { ok: v.ok, errors: v.errors, cleanTitle: v.cleanTitle, readMinutes: v.readMinutes };
  };
  assert.deepEqual(validate(draft).errors, ["invented_foreign_gloss:Enfilbry"]);
  const repair = makeFidelityRepairCall({
    send: async () => ({ ok: true, content: JSON.stringify({ title: draft.title, excerpt: draft.excerpt, summary: "", body: draft.body }) }),
    buildMessages: () => "x",
    responseFormat: WRITER_REPAIR_RESPONSE_FORMAT,
    parse: parseWriterOutput,
  });
  const fin = await finalizeWriterDraft({ runEditor: async () => ({ article: draft, readMinutes: 1, audit: null }), validate, repair });
  assert.equal(fin.fidelity.decision, "clean");
  assert.equal(fin.fidelity.article.summary, "");
});

test("P4R3-5 counter: an empty repaired summary still keeps the draft summary when no issue is located there", async () => {
  const draft = { ...REPAIR_DRAFT };
  const repair = makeFidelityRepairCall({
    send: async () => ({ ok: true, content: JSON.stringify({ title: draft.title, excerpt: draft.excerpt, summary: "", body: REPAIR_BODY_WITH(" دفعات ") }) }),
    buildMessages: () => "x",
    responseFormat: WRITER_REPAIR_RESPONSE_FORMAT,
    parse: parseWriterOutput,
  });
  const r = await repair(["unsupported_number:5"], draft);
  assert.ok(r.ok && r.article.summary === draft.summary);
});
