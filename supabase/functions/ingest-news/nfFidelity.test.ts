// NF — owner-authorized narrow fix: (1) language-independent number matching
// (candidate value sets on both sides, no source_lang gate) and (2) repair
// restore-or-escalate (a fidelity repair may correct a figure, never delete
// one). Pure fixtures; regressions are the re-gate's real failures (verbatim
// source fragments); every regression has a counter-test.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkFactGrounding,
  extractNumberEntries,
  lostFigures,
  numberCandidateSet,
  parseWriterOutput,
  validateArticle,
  WRITER_REPAIR_RESPONSE_FORMAT,
} from "./salmaWriter.ts";
import { finalizeWriterDraft, makeFidelityRepairCall, type FidelityArticle } from "./fidelityRepair.ts";

/** unsupported_number codes, with the real-world default sourceLang = null. */
function nums(draft: string, source: string, sourceLang: string | null = null): string[] {
  return checkFactGrounding({ title: "عنوان", excerpt: "", body: draft }, { sourceText: source, sourceLang }, "standard_news")
    .errors.filter((e) => e.startsWith("unsupported_number"));
}

// --- 1. Regressions from the re-gate (null source language) ----------------------

// P14 (WHO DON598, Measles – Bangladesh) — extracted text uses a PLAIN space.
const P14_SOURCE =
  "Since 15 March 2026 and as of 14 April, a total of 19 161 suspected measles cases and 2973 laboratory-confirmed measles cases have been reported. " +
  "A total of 12 318 hospital admissions and 9772 hospital discharges have also been reported.";
const P14_DRAFT =
  "ومنذ 15 مارس 2026 وحتى 14 أبريل، سُجلت 19,161 حالة مشتبه بها و2,973 حالة مؤكدة مخبرياً. كما أُبلغ عن 12,318 حالة دخول إلى المستشفى و9,772 حالة خروج.";

test("NF-1 P14: plain-space «19 161» / «12 318» ground the draft's 19,161 / 12,318 with a null language", () => {
  assert.deepEqual(nums(P14_DRAFT, P14_SOURCE, null), []);
  assert.deepEqual(nums(P14_DRAFT, P14_SOURCE, "en"), []);
  assert.deepEqual(nums(P14_DRAFT, P14_SOURCE.replace("19 161", "19 161"), null), []);
});

test("NF-1 P15: «694 ألف» ↔ plain-space «694 000» with a null language", () => {
  const src = "In 2024, it resulted in approximately 694 000 deaths globally – 70% in low- and middle-income countries.";
  assert.deepEqual(nums("تسبب في نحو 694 ألف وفاة عالمياً في 2024، كانت 70% منها في البلدان منخفضة ومتوسطة الدخل.", src), []);
  assert.deepEqual(nums("تسبب في نحو 694,000 وفاة عالمياً.", src), []);
});

test("NF-1 D18: «82,2%» ↔ «82.2%» in BOTH directions with a null language", () => {
  const ro = "Dintre cei care au primit vaccinul în plus față de Keytruda, 82,2% erau încă fără cancer după doi ani, comparativ cu 70% dintre pacienții care au primit doar Keytruda.";
  assert.deepEqual(nums("وبعد عامين من العلاج، بقي 82.2% من الذين تلقوا اللقاح مع كيترودا بلا سرطان، مقابل 70%.", ro), []);
  assert.deepEqual(nums("بقي 82,2% بلا سرطان مقابل 70%.", "82.2% were still cancer-free versus 70%."), []);
  // Romanian period-thousands «1.100» grounds 1100 without a language: the same
  // source shows the European convention («82,2»).
  assert.deepEqual(nums("وشملت أكثر من 1100 مريض.", `studiul de fază 3, care a inclus peste 1.100 de pacienți. ${ro}`), []);
});

test("NF-1 F07: «period 1, 675 patients» does NOT support a draft «1,675»", () => {
  // F07 (psychiatrictimes.com, olanzapine LAI), verbatim fragment.
  const src = "During the 8-week period 1, 675 patients were randomized 1:1:1:1 to low-, medium-, or high-dose olanzapine LAI or placebo.";
  assert.deepEqual(nums("وخلال الفترة الأولى وُزّع 1,675 مريضاً عشوائياً.", src), ["unsupported_number:1,675"]);
  assert.deepEqual(nums("وخلال الفترة الأولى وُزّع 675 مريضاً عشوائياً.", src), []);
});

// --- 1. Counter-tests: true positives unchanged ----------------------------------

test("NF-1 counter: 19,162 fails; «695 ألف» fails; 82,3 fails; 3101 fails", () => {
  assert.deepEqual(nums("سُجلت 19,162 حالة.", P14_SOURCE), ["unsupported_number:19,162"]);
  assert.deepEqual(nums("نحو 695 ألف وفاة.", "approximately 694 000 deaths"), ["unsupported_number:695"]);
  assert.deepEqual(nums("بقي 82,3% بلا سرطان.", "82,2% erau încă fără cancer"), ["unsupported_number:82,3"]);
  assert.deepEqual(nums("بقي 82.3% بلا سرطان.", "82,2% erau încă fără cancer"), ["unsupported_number:82.3"]);
  assert.deepEqual(nums("شملت الدراسة 3101 مريض.", "The phase 3 100 patients cohort was followed."), ["unsupported_number:3101"]);
});

test("NF-1 counter: implausible readings are not added (15,000 is never 15; 2024 158 never merges)", () => {
  assert.deepEqual(nums("سُجلت 15 حالة.", "around 15,000 cases were recorded."), ["unsupported_number:15"]);
  assert.deepEqual(nums("سُجلت 15 مليون حالة.", "around 15,000 cases."), ["unsupported_number:15"]);
  assert.deepEqual(nums("سُجلت 2024158 حالة.", "In 2024 158 cases were recorded."), ["unsupported_number:2024158"]);
  // The draft never merges a plain space: «3 100» is «3» and «100».
  assert.deepEqual(nums("في المرحلة 3 100 مريض.", "a phase 3 trial with 90 patients"), ["unsupported_number:100"]);
});

test("NF-1 documented residual: an ambiguous SOURCE typography may mask a draft reading («phase 3 100» ⇒ 3100)", () => {
  // Accepted trade-off (see the NF-1 comment in salmaWriter.ts): widening only
  // where the source's own typography is ambiguous.
  assert.deepEqual(nums("شملت الدراسة 3100 مريض.", "The phase 3 100 patients cohort was followed."), []);
  assert.deepEqual([...numberCandidateSet("phase 3 100 patients and 1.100 others", "source")].sort(), ["1.1", "100", "3", "3100"]);
  assert.deepEqual([...numberCandidateSet("phase 3 100 patients, 1.100 others, 82,2%", "source")].sort(), ["1.1", "100", "1100", "3", "3100", "82.2"]);
});

test("NF-1 candidate sets: source gets every plausible reading, draft the house reading", () => {
  const s = (t: string) => extractNumberEntries(t, "en", { side: "source", european: true })[0].values.sort();
  const d = (t: string) => extractNumberEntries(t, "en", { side: "draft" })[0].values;
  assert.deepEqual(s("1,675"), ["1.675", "1675"]);
  assert.deepEqual(s("82,2"), ["82.2"]);
  assert.deepEqual(s("15,000"), ["15000"]);
  assert.deepEqual(d("1,675"), ["1675"]);
  assert.deepEqual(d("82,2"), ["82.2"]);
  assert.deepEqual(d("١٩٬١٦١"), ["19161"]);
  // Without European evidence a source token gets the house reading only.
  assert.deepEqual(extractNumberEntries("1,675", "en", { side: "source" })[0].values, ["1675"]);
});

// --- 2. Repair restore-or-escalate -------------------------------------------------

const SRC =
  "Since 15 March 2026, a total of 19 161 suspected measles cases were reported, and a total of 12 318 hospital admissions were reported nationwide. " +
  "In 2024 the disease caused approximately 694,000 deaths globally according to the latest estimates published by the organization.";
const BODY =
  "سُجلت منذ 15 مارس 2026 نحو 19,161 حالة حصبة مشتبه بها في أنحاء البلاد، كما أُبلغ عن 12,319 حالة دخول إلى المستشفيات في مختلف المناطق خلال الفترة نفسها.\n\nوتسبب المرض عام 2024 في نحو 694 وفاة عالمياً بحسب أحدث التقديرات التي نشرتها المنظمة.";
const DRAFT: FidelityArticle = { title: "تفشٍّ واسع للحصبة في البلاد", excerpt: "الضغط على المستشفيات يتزايد.", summary: "", body: BODY };

function validate(a: FidelityArticle) {
  const v = validateArticle({ article: { ...a, profile: "standard_news" }, source: { sourceText: SRC } });
  return { ok: v.ok, errors: v.errors, cleanTitle: v.cleanTitle, readMinutes: v.readMinutes };
}
const stubRepair = (body: string) =>
  makeFidelityRepairCall({
    send: async () => ({ ok: true, content: JSON.stringify({ title: DRAFT.title, excerpt: DRAFT.excerpt, summary: "", body }) }),
    buildMessages: () => "x",
    responseFormat: WRITER_REPAIR_RESPONSE_FORMAT,
    parse: parseWriterOutput,
  });
const guard = (b: FidelityArticle, a: FidelityArticle) => lostFigures(b, a, SRC);

test("NF-2 baseline: the draft carries two repairable figure errors (12,319 and 694)", () => {
  assert.deepEqual(validate(DRAFT).errors.sort(), ["unsupported_number:12,319", "unsupported_number:694"]);
});

test("NF-2 / NF2 a repair that DELETES «19,161» (and the flagged figures) is discarded → REJECT on the original errors, reason + lost tokens audited", async () => {
  const gutted = "سُجلت منذ 15 مارس 2026 حالات حصبة مشتبه بها في أنحاء البلاد، كما أُبلغ عن حالات دخول إلى المستشفيات في مختلف المناطق خلال الفترة نفسها.\n\nوتسبب المرض عام 2024 في وفيات عالمياً بحسب أحدث التقديرات التي نشرتها المنظمة.";
  const fin = await finalizeWriterDraft({ runEditor: async () => ({ article: DRAFT, readMinutes: 1, audit: null }), validate, repair: stubRepair(gutted), figuresLost: guard });
  assert.equal(fin.fidelity.decision, "reject");
  assert.equal(fin.fidelity.audit.repair_failure_reason, "repair_deleted_figures");
  assert.ok(fin.fidelity.audit.repair_lost_figures?.includes("19,161"), JSON.stringify(fin.fidelity.audit));
  assert.equal(fin.fidelity.audit.draft_source, "original");
  assert.equal(fin.fidelity.article.body, BODY); // never silently gutted
});

test("NF-2 a repair that CORRECTS 694 → «694 ألف» and 12,319 → 12,318 is accepted (clean)", async () => {
  const fixed = BODY.replace("12,319", "12,318").replace("نحو 694 وفاة", "نحو 694 ألف وفاة");
  const fin = await finalizeWriterDraft({ runEditor: async () => ({ article: DRAFT, readMinutes: 1, audit: null }), validate, repair: stubRepair(fixed), figuresLost: guard });
  assert.equal(fin.fidelity.decision, "clean");
  assert.equal(fin.fidelity.audit.draft_source, "repaired");
  assert.equal(fin.fidelity.audit.repair_lost_figures, undefined);
});

test("NF-2 the guard tolerates formatting changes of the same value and counts only source-supported replacements", () => {
  const a = (body: string): FidelityArticle => ({ title: "ع", excerpt: "", summary: "", body });
  assert.deepEqual(lostFigures(a("سُجلت 19,161 حالة بنسبة 2.50%."), a("سُجلت 19 161 حالة بنسبة 2.5%."), SRC), []);
  assert.deepEqual(lostFigures(a("سُجلت ١٩٬١٦١ حالة."), a("سُجلت 19,161 حالة."), SRC), []);
  // Single-digit integers may become number words.
  assert.deepEqual(lostFigures(a("سحبت 3 دفعات."), a("سحبت ثلاث دفعات."), SRC), []);
  // A replacement the source does NOT support does not excuse a vanished figure.
  assert.deepEqual(lostFigures(a("نحو 694 وفاة."), a("نحو 695 ألف وفاة."), SRC), ["694"]);
  // A plain deletion is reported.
  assert.deepEqual(lostFigures(a("سُجلت 19,161 حالة."), a("سُجلت حالات."), SRC), ["19,161"]);
});

test("NF-2 wiring: numeric repair instructions say replace-never-delete and the guard is passed in pipeline.ts", () => {
  const src = readFileSync(fileURLToPath(new URL("./pipeline.ts", import.meta.url)), "utf8");
  assert.ok(src.includes("figuresLost: (before, after) => lostFigures(before, after, verifiedFactText),"));
  assert.ok(src.includes("لا تحذف الرقم ولا الجملة التي تحمله"));
  assert.ok(src.includes("لا تحذف التاريخ ولا الجملة التي تحمله"));
  assert.ok(!src.includes("احذفه، أو استبدله بالقيمة الصحيحة كما وردت حرفيًا في المصدر، أو أعِد صياغة الجملة دون هذا الرقم"));
});

// =========================================================================
// NF2 — review fixes
// =========================================================================

const P99_SRC = "Health officials said 98 people were injured in the incident, and the investigation is continuing according to the ministry statement released on Monday.";
const P99_BODY = "أصيب 99 شخصاً في الحادث بحسب المسؤولين الصحيين، فيما يتواصل التحقيق وفق بيان الوزارة الصادر يوم الاثنين في العاصمة بعد ساعات من الواقعة نفسها.\n\nوقالت الوزارة إن فرق الإسعاف نقلت المصابين إلى المستشفيات القريبة، وإن التحقيق سيحدد أسباب الحادث وظروفه خلال الأيام المقبلة.";
const P99: FidelityArticle = { title: "إصابة العشرات في حادث", excerpt: "التحقيق مستمر.", summary: "", body: P99_BODY };
const v99 = (a: FidelityArticle) => {
  const v = validateArticle({ article: { ...a, profile: "standard_news" }, source: { sourceText: P99_SRC } });
  return { ok: v.ok, errors: v.errors, cleanTitle: v.cleanTitle, readMinutes: v.readMinutes };
};
const repairTo = (body: string) =>
  makeFidelityRepairCall({
    send: async () => ({ ok: true, content: JSON.stringify({ title: P99.title, excerpt: P99.excerpt, summary: "", body }) }),
    buildMessages: () => "x",
    responseFormat: WRITER_REPAIR_RESPONSE_FORMAT,
    parse: parseWriterOutput,
  });
const g99 = (b: FidelityArticle, a: FidelityArticle) => lostFigures(b, a, P99_SRC);

test("NF2-blocker reviewer probe: «أصيب 99 شخصاً», the repair drops 99 → REJECT (unsupported_number:99) with repair_deleted_figures", async () => {
  assert.deepEqual(v99(P99).errors, ["unsupported_number:99"]);
  const fin = await finalizeWriterDraft({
    runEditor: async () => ({ article: P99, readMinutes: 1, audit: null }), validate: v99, figuresLost: g99,
    repair: repairTo(P99_BODY.replace("أصيب 99 شخصاً", "أصيب عدد من الأشخاص")),
  });
  assert.equal(fin.fidelity.decision, "reject");
  assert.equal(fin.fidelity.rejectionReason, "unsupported_number:99");
  assert.equal(fin.fidelity.audit.repair_failure_reason, "repair_deleted_figures");
  assert.deepEqual(fin.fidelity.audit.repair_lost_figures, ["99"]);
  assert.equal(fin.fidelity.audit.needs_human_review, false);
});

test("NF2-blocker a repair that RESTORES the source value (99 → 98) is clean", async () => {
  const fin = await finalizeWriterDraft({
    runEditor: async () => ({ article: P99, readMinutes: 1, audit: null }), validate: v99, figuresLost: g99,
    repair: repairTo(P99_BODY.replace("أصيب 99", "أصيب 98")),
  });
  assert.equal(fin.fidelity.decision, "clean");
  assert.equal(fin.fidelity.audit.draft_source, "repaired");
});

test("NF2-blocker P14-style: a deletion that would clear the only error is still REJECTED with the reason (never clean, never pending)", async () => {
  // The only error is the flagged 12,319; deleting it would validate clean.
  const body = BODY.replace("نحو 694 وفاة", "نحو 694 ألف وفاة");
  const draft: FidelityArticle = { ...DRAFT, body };
  assert.deepEqual(validate(draft).errors, ["unsupported_number:12,319"]);
  const deleted = body.replace("كما أُبلغ عن 12,319 حالة دخول", "كما أُبلغ عن حالات دخول");
  assert.ok(validate({ ...draft, body: deleted }).ok); // the gutted draft WOULD pass
  const fin = await finalizeWriterDraft({ runEditor: async () => ({ article: draft, readMinutes: 1, audit: null }), validate, repair: stubRepair(deleted), figuresLost: guard });
  assert.equal(fin.fidelity.decision, "reject");
  assert.equal(fin.fidelity.audit.repair_failure_reason, "repair_deleted_figures");
  assert.deepEqual(fin.fidelity.audit.repair_lost_figures, ["12,319"]);
});

test("NF2-major an English source (no European evidence) never supports a comma-float reading — the reviewer's list", () => {
  const src = "The trial enrolled 1,250 patients; 4,500 doses, 2,500 vials, 1,675 participants, 15,500 visits and 2,026 follow-ups were recorded.";
  for (const d of ["1.25", "4.5%", "2.5", "1.675", "15.5", "2.026"]) {
    assert.deepEqual(nums(`سُجّل ${d} في التجربة.`, src), [`unsupported_number:${d.replace("%", "")}`], d);
  }
  // The thousands readings stay supported.
  assert.deepEqual(nums("شملت التجربة 1,250 مريضاً و4,500 جرعة و2,026 متابعة.", src), []);
});

test("NF2-major European evidence is document-level: D18's Romanian source still folds 82.2 and 1100 with a null language", () => {
  const ro = "Datele din studiul de fază 3, care a inclus peste 1.100 de pacienți, au arătat că 82,2% erau încă fără cancer după doi ani.";
  assert.deepEqual(nums("شملت الدراسة أكثر من 1100 مريض، وبقي 82.2% بلا سرطان.", ro), []);
  assert.deepEqual(nums("بقي 1.1 بلا سرطان.", "inclus peste 1.100 de pacienți"), []); // English decimal reading (no evidence)
  assert.deepEqual(nums("شملت الدراسة 1100 مريض.", "inclus peste 1.100 de pacienți"), ["unsupported_number:1100"]);
  // P14 / P15 unaffected.
  assert.deepEqual(nums(P14_DRAFT, P14_SOURCE), []);
  assert.deepEqual(nums("نحو 694 ألف وفاة.", "approximately 694 000 deaths"), []);
});

test("NF2-minor-A single digits count: «3» → «ثلاثة» is preserved; a genuinely deleted «3» flags", () => {
  const a = (body: string): FidelityArticle => ({ title: "ع", excerpt: "", summary: "", body });
  assert.deepEqual(lostFigures(a("سحبت الشركة 3 دفعات."), a("سحبت الشركة ثلاث دفعات."), SRC), []);
  assert.deepEqual(lostFigures(a("سحبت الشركة 3 دفعات."), a("سحبت الشركة الثلاثة دفعات."), SRC), []);
  assert.deepEqual(lostFigures(a("سحبت الشركة 3 دفعات."), a("سحبت الشركة دفعات."), SRC), ["3"]);
  assert.deepEqual(lostFigures(a("سحبت الشركة 3 دفعات."), a("سحبت الشركة سبع دفعات."), SRC), ["3"]);
});

test("NF2-minor-B a replacement excuses a loss only in the corresponding sentence («أصيب 12…» → «…في 2026» elsewhere flags)", () => {
  const src = "In 2026, 13 people were injured. The outbreak began in March 2026 in the north.";
  const a = (body: string): FidelityArticle => ({ title: "ع", excerpt: "", summary: "", body });
  // 12 deleted from its sentence; the new supported 2026 sits in ANOTHER sentence.
  assert.deepEqual(lostFigures(a("أصيب 12 شخصاً في الحادث. وبدأ التفشي في مارس في الشمال."), a("أصيب أشخاص في الحادث. وبدأ التفشي في مارس 2026 في الشمال."), src), ["12"]);
  // The same-sentence correction is excused.
  assert.deepEqual(lostFigures(a("أصيب 12 شخصاً في الحادث. وبدأ التفشي في مارس في الشمال."), a("أصيب 13 شخصاً في الحادث. وبدأ التفشي في مارس في الشمال."), src), []);
});
