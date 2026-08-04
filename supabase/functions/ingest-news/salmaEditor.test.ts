// E1.4A — Salma Editorial Director tests (pure, NO live internet, NO Deno/
// Supabase). Runs under Node's native TS type stripping
// (`node --test salmaEditor.test.ts`) or `deno test`.
//
// These lock the editor contract described in the Editorial Director spec:
//  - the editor runs once on EVERY validated writer draft (no style-warning gate);
//  - exactly ONE model attempt is made — never a retry, never a Gemini fallback;
//  - the edited draft REPLACES the writer draft only when it re-passes the same
//    factual validation, preserves the required actions / essential entities /
//    risk, and clears the deterministic editorial gate; otherwise the writer
//    draft is always retained as the safe fallback;
//  - Arabic-first naming, first-impression, and clutter rules are enforced and
//    classified blocking / needs_review / advisory.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEditorInstructions,
  buildFactPacket,
  droppedRequiredActions,
  type EditorArticle,
  type EditorCall,
  type EditorCallResult,
  type EditorFactPacket,
  EDITOR_PROMPT_VERSION,
  EDITOR_RESPONSE_FORMAT,
  type EditorRevalidate,
  editorialGate,
  isRecoverableEditorFailure,
  parseEditorOutput,
  repairableEditorialIssues,
  runEditorPass,
  shouldRunEditor,
} from "./salmaEditor.ts";
import { validateArticle, type WritingProfile } from "./salmaWriter.ts";

// --- Shared safety-alert fixture (spec's Cyclophosphamide example) ---------

const SAFETY_SOURCE =
  "سحبت شركة أدوية دفعات من دواء سيكلوفوسفاميد للحقن في الولايات المتحدة بعد اكتشاف جسيمات معدنية داخل بعض القوارير، وقد تسبّب هذه الجسيمات خطر تجلّط الدم لدى المرضى. ونصحت الجهة المرضى والكوادر الطبية بالتوقف عن استخدام الدفعات المتأثرة فوراً. ولم تُسجَّل حتى الآن أي إصابات مرتبطة بهذا العيب.";
const SAFETY_MUST_PRESERVE = ["سيكلوفوسفاميد"];

const SAFETY_ORIGINAL: EditorArticle = {
  title: "سحب دواء سيكلوفوسفاميد بسبب جسيمات معدنية",
  excerpt: "إجراء احترازي لحماية المرضى من مضاعفات محتملة.",
  summary: "على المرضى التوقف عن استخدام الدفعات المتأثرة.",
  body:
    "سحبت الجهة المختصة دفعات من دواء سيكلوفوسفاميد للحقن بعد اكتشاف جسيمات معدنية قد تسبب خطر التجلّط لدى المرضى. ونصحت المرضى والكوادر الطبية بالتوقف عن استخدام الدفعات المتأثرة فوراً حفاظاً على سلامتهم.",
};

// A polished, Arabic-first edit that stays fully grounded in SAFETY_SOURCE:
// keeps the drug name, the stop-use action, and the risk, invents no number/
// quote/action, and reads as news rather than a regulatory notice.
const SAFETY_GOOD_EDIT_BODY =
  "رصدت السلطات الصحية جسيمات معدنية داخل قوارير من دواء سيكلوفوسفاميد المخصّص للحقن، وهو ما قد يعرّض المرضى لخطر التجلّط عند دخول هذه الجسيمات إلى الدم.\n\nونصحت الجهة المرضى والكوادر الطبية بالتوقف عن استخدام الدفعات المتأثرة، مؤكدة متابعتها للأمر دون تسجيل أي إصابات حتى الآن.";

function editorJson(a: {
  title: string;
  excerpt: string;
  summary: string;
  body: string;
  verdict?: "ready" | "needs_human_review";
  issues?: string[];
  changes?: string[];
}): string {
  return JSON.stringify({
    title: a.title,
    excerpt: a.excerpt,
    summary: a.summary,
    body: a.body,
    edit_applied: true,
    editorial_verdict: a.verdict ?? "ready",
    issues_found: a.issues ?? [],
    changes_made: a.changes ?? ["اختصار وتبسيط الصياغة"],
  });
}

const SAFETY_GOOD_EDIT = editorJson({
  title: "سحب دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية",
  excerpt: "قرار السحب جاء احترازياً لحماية المرضى من مضاعفات محتملة نتيجة التلوث.",
  summary: "ينبغي للمرضى والكوادر التوقف عن استخدام الدفعات المتأثرة فوراً.",
  body: SAFETY_GOOD_EDIT_BODY,
});

// Injected transports/validators (dependency injection keeps the module pure).
function countingCall(content: string): { call: EditorCall; calls: () => number } {
  let n = 0;
  const call: EditorCall = async () => {
    n++;
    return { ok: true, content };
  };
  return { call, calls: () => n };
}
function failingCall(reason: string): { call: EditorCall; calls: () => number } {
  let n = 0;
  const call: EditorCall = async () => {
    n++;
    return { ok: false, reason };
  };
  return { call, calls: () => n };
}
const okRevalidate: EditorRevalidate = (a) => ({ ok: true, readMinutes: 1, cleanTitle: a.title });
function realRevalidate(
  source: string,
  mustPreserve: string[],
  profile: WritingProfile,
): EditorRevalidate {
  return (a) => {
    const v = validateArticle({
      article: { title: a.title, excerpt: a.excerpt, body: a.body, profile },
      source: { sourceText: source, mustPreserve },
    });
    return v.ok
      ? { ok: true, readMinutes: v.readMinutes, cleanTitle: v.cleanTitle }
      : { ok: false, reason: v.rejectionReason ?? "validation_failed" };
  };
}

function safetyPacket() {
  return buildFactPacket({
    profile: "safety_alert",
    sourceText: SAFETY_SOURCE,
    mustPreserve: SAFETY_MUST_PRESERVE,
  });
}
function runSafety(
  editContent: string,
  revalidate: EditorRevalidate,
  original: EditorArticle = SAFETY_ORIGINAL,
) {
  const packet = safetyPacket();
  const { call, calls } = countingCall(editContent);
  return runEditorPass({
    profile: "safety_alert",
    model: "openai/gpt-5.4-mini",
    original: { article: original, readMinutes: 1 },
    packet,
    call,
    revalidate,
    verificationOnly: packet.verificationOnly,
  }).then((res) => ({ res, calls: calls() }));
}

// 1) The editor runs on EVERY validated draft, exactly once.
test("§14.1 the editor runs on every validated draft, exactly once", async () => {
  assert.equal(shouldRunEditor(true), true);
  assert.equal(shouldRunEditor(false), false);
  const { res, calls } = await runSafety(SAFETY_GOOD_EDIT, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(calls, 1);
  assert.equal(res.audit.editor_attempted, true);
});

// 2) Only one attempt — no retry, no fallback — even when the call fails.
test("§14.2 only one attempt is made (no retry) even on a failed call", async () => {
  const { call, calls } = failingCall("editor_timeout");
  const packet = safetyPacket();
  const res = await runEditorPass({
    profile: "safety_alert",
    model: "openai/gpt-5.4-mini",
    original: { article: SAFETY_ORIGINAL, readMinutes: 1 },
    packet,
    call,
    revalidate: okRevalidate,
    verificationOnly: packet.verificationOnly,
  });
  assert.equal(calls(), 1);
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.final_draft_source, "original");
  assert.match(res.audit.editor_rejection_reason ?? "", /editor_call_failed:editor_timeout/);
});

// 3) An Arabic-first, grounded edit is accepted.
test("§14.3 an Arabic-first grounded edit is accepted", async () => {
  const { res } = await runSafety(SAFETY_GOOD_EDIT, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.final_draft_source, "first_edit");
  assert.equal(res.audit.editorial_verdict, "ready");
  assert.ok(!/[A-Za-z]/.test(res.article.title));
});

// 4) A foreign name is allowed in parentheses at first mention only (no block).
test("§14.4 English in a first-mention parenthetical gloss is not blocking", () => {
  const gate = editorialGate(
    {
      title: "سحب دواء سيكلوفوسفاميد للحقن",
      excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة.",
      summary: "التوقف عن استخدام الدفعات المتأثرة فوراً.",
      body:
        "سحبت الجهة دواء سيكلوفوسفاميد (Cyclophosphamide) للحقن بعد رصد جسيمات معدنية قد تسبب خطر التجلّط، ونصحت بالتوقف عن استخدامه فوراً.",
    },
    "safety_alert",
  );
  assert.deepEqual(gate.blocking, []);
});

// 5) The same English term repeated after the first mention is flagged.
test("§14.5 English repeated after the first mention is flagged for review", () => {
  const gate = editorialGate(
    {
      title: "سحب دواء سيكلوفوسفاميد للحقن",
      excerpt: "قرار احترازي لحماية المرضى.",
      summary: "التوقف عن الاستخدام فوراً.",
      body:
        "سحبت الجهة دواء سيكلوفوسفاميد (Cyclophosphamide) للحقن، ثم أكدت أن الدفعات المتأثرة من Cyclophosphamide لا يجب استخدامها.",
    },
    "safety_alert",
  );
  assert.ok(gate.needs_review.includes("editorial_english_name_repeated_after_first"));
});

// 6) USP / NDC / Lot / Inc labels are flagged as unnecessary clutter.
test("§14.6 regulatory labels (USP/NDC/Lot/Inc) are flagged for review", () => {
  const gate = editorialGate(
    {
      title: "سحب دواء سيكلوفوسفاميد للحقن",
      excerpt: "قرار احترازي لحماية المرضى من مضاعفات.",
      summary: "التوقف عن الاستخدام فوراً.",
      body:
        "سحبت الجهة دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية، وأشار الإشعار إلى الرمز USP ضمن بيانات الدفعة المتأثرة.",
    },
    "safety_alert",
  );
  assert.ok(gate.needs_review.includes("editorial_unnecessary_label"));
});

// 7) English in the title is a blocking Arabic-first violation.
test("§14.7 English in the title is blocking", () => {
  const gate = editorialGate(
    {
      title: "سحب دواء Cyclophosphamide للحقن",
      excerpt: "قرار احترازي لحماية المرضى.",
      summary: "التوقف عن الاستخدام فوراً.",
      body: "سحبت الجهة الدواء بعد رصد جسيمات معدنية قد تسبب خطر التجلّط، ونصحت بالتوقف عن استخدامه.",
    },
    "safety_alert",
  );
  assert.ok(gate.blocking.includes("editorial_title_has_english"));
});

// 8) The approved Cyclophosphamide edit passes end-to-end (real validation).
test("§14.8 the approved Cyclophosphamide edit is accepted end-to-end", async () => {
  const { res } = await runSafety(SAFETY_GOOD_EDIT, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.factual_revalidation_result, "passed");
  assert.deepEqual(res.audit.editorial_blocking, []);
  assert.ok(res.article.body.includes("سيكلوفوسفاميد"));
  assert.ok(res.article.body.includes("التوقف عن استخدام"));
});

// 9) The regulatory-heavy press-release version raises multiple warnings.
test("§14.9 the regulatory-heavy version raises multiple editorial warnings", () => {
  const gate = editorialGate(
    {
      title: "سحب دواء سيكلوفوسفاميد",
      excerpt: "بيان رسمي حول سحب المنتج.",
      summary: "التوقف عن الاستخدام.",
      body:
        "أعلنت شركة Sunny Pharmtech سحباً طوعياً وشاملاً لثلاث دفعات من Cyclophosphamide for Injection, USP على مستوى المستخدم بعد رصد جسيمات معدنية، ونصحت بالتوقف عن الاستخدام.",
    },
    "safety_alert",
  );
  assert.ok(gate.blocking.includes("editorial_foreign_name_english_only"));
  assert.ok(gate.needs_review.includes("editorial_press_release_opening"));
  assert.ok(gate.needs_review.includes("editorial_promo_or_literal_phrase"));
  assert.ok(gate.needs_review.includes("editorial_unnecessary_label"));
});

// 10) The approved Papaverine edit passes the gate with no blocking.
test("§14.10 the approved Papaverine edit passes with no blocking", () => {
  const gate = editorialGate(
    {
      title: "سحب دفعات من دواء بابافيرين للحقن",
      excerpt: "قرار احترازي بعد رصد مشكلة في التعقيم يهدد سلامة المرضى.",
      summary: "على المستشفيات التوقف عن استخدام الدفعات المتأثرة.",
      body:
        "سحبت الجهة المختصة دفعات من دواء بابافيرين (Papaverine) للحقن بعد رصد مشكلة في التعقيم قد تعرّض المرضى لخطر العدوى.\n\nوطلبت من المستشفيات التوقف عن استخدام الدفعات المتأثرة والتخلص منها وفق الإجراءات المعتمدة.",
    },
    "safety_alert",
  );
  assert.deepEqual(gate.blocking, []);
});

// 11) A factual change (invented quotation) is rejected; original retained.
test("§14.11 a factual change (invented quotation) is rejected", async () => {
  const bad = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية",
    excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة.",
    summary: "التوقف عن استخدام الدفعات المتأثرة فوراً.",
    body: SAFETY_GOOD_EDIT_BODY + "\n\nوقالت الجهة إن «هذا الدواء آمن تماماً بعد السحب».",
  });
  const { res } = await runSafety(bad, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.factual_revalidation_result, "failed");
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// 12) A changed number/date is rejected by factual re-validation.
test("§14.12 a changed number/date is rejected", async () => {
  const bad = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية",
    excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة.",
    summary: "التوقف عن استخدام الدفعات المتأثرة فوراً.",
    body: SAFETY_GOOD_EDIT_BODY + "\n\nويأتي القرار بعد بلاغات وردت منذ عام 2026.",
  });
  const { res } = await runSafety(bad, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.factual_revalidation_result, "failed");
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// 13) An edit that strips ALL risk from a safety alert is rejected.
test("§14.13 dropping all risk from a safety alert is rejected", async () => {
  const bad = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن",
    excerpt: "قرار تنظيمي روتيني يخص بعض الدفعات.",
    summary: "التوقف عن استخدام الدفعات المتأثرة.",
    body:
      "رصدت السلطات جسيمات معدنية داخل قوارير من دواء سيكلوفوسفاميد للحقن. ونصحت المرضى والكوادر بالتوقف عن استخدام الدفعات المتأثرة فوراً حرصاً على راحتهم.",
  });
  const { res } = await runSafety(bad, okRevalidate);
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.editor_rejection_reason, "editor_dropped_risk");
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// 14) Removing the required audience action is rejected (module guard).
test("§14.14 removing the required patient action is rejected", async () => {
  const bad = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن",
    excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة.",
    summary: "تفاصيل حول الدفعات المتأثرة.",
    body:
      "رصدت السلطات جسيمات معدنية داخل قوارير من دواء سيكلوفوسفاميد للحقن قد تسبب خطر التجلّط للمرضى. وتتابع الجهات المختصة الأمر عن كثب.",
  });
  const { res } = await runSafety(bad, okRevalidate);
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.match(res.audit.editor_rejection_reason ?? "", /editor_dropped_required_action/);
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// 15) Removing a facility-directed action is caught by factual re-validation.
test("§14.15 removing a facility action is caught by factual re-validation", async () => {
  const bad = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن",
    excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة.",
    summary: "تفاصيل حول الدفعات المتأثرة.",
    body:
      "رصدت السلطات جسيمات معدنية داخل قوارير من دواء سيكلوفوسفاميد للحقن قد تسبب خطر التجلّط للمرضى. وتتابع الجهات المختصة الأمر عن كثب دون تسجيل إصابات.",
  });
  const { res } = await runSafety(bad, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.factual_revalidation_result, "failed");
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// 16) Malformed model output retains the original draft.
test("§14.16 malformed editor output retains the original draft", async () => {
  const { res } = await runSafety("this is not json at all", okRevalidate);
  assert.equal(res.audit.editor_output_parsed, false);
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.final_draft_source, "original");
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// 17) An accepted-but-imperfect edit is marked needs_human_review.
test("§14.17 an accepted low-quality edit is marked needs_human_review", async () => {
  // Grounded and structurally valid, but leaks a USP label (needs_review, not
  // blocking), so it is accepted yet flagged for a human.
  const flagged = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية",
    excerpt: "قرار السحب جاء احترازياً لحماية المرضى من مضاعفات محتملة نتيجة التلوث.",
    summary: "ينبغي للمرضى والكوادر التوقف عن استخدام الدفعات المتأثرة فوراً.",
    body: SAFETY_GOOD_EDIT_BODY + "\n\nوورد الرمز USP ضمن بيانات الدفعة في الإشعار.",
    verdict: "ready",
  });
  const { res } = await runSafety(flagged, okRevalidate);
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.editorial_verdict, "needs_human_review");
  assert.ok(res.audit.editorial_review.includes("editorial_unnecessary_label"));
});

// 18) On any rejection the original writer draft is the safe fallback.
test("§14.18 the original writer draft is always the safe fallback", async () => {
  for (const [content, reval] of [
    ["not json", okRevalidate],
    [SAFETY_GOOD_EDIT, () => ({ ok: false, reason: "unsupported_number:9" }) as ReturnType<EditorRevalidate>],
  ] as const) {
    const { res } = await runSafety(content, reval);
    assert.equal(res.audit.edited_draft_accepted, false);
    assert.equal(res.audit.final_draft_source, "original");
    assert.deepEqual(res.article, SAFETY_ORIGINAL);
    assert.equal(res.readMinutes, 1);
  }
});

// Supporting: strict parser + prompt wiring.
test("parser accepts a well-formed editor object and rejects extras/malformed", () => {
  const ok = parseEditorOutput(SAFETY_GOOD_EDIT);
  assert.equal(ok.ok, true);
  assert.equal(parseEditorOutput("{}").ok, false);
  assert.equal(parseEditorOutput('{"title":"x"}').ok, false);
  const extra = JSON.parse(SAFETY_GOOD_EDIT);
  extra.unexpected = 1;
  assert.equal(parseEditorOutput(JSON.stringify(extra)).ok, false);
  const notApplied = JSON.parse(SAFETY_GOOD_EDIT);
  notApplied.edit_applied = false;
  assert.equal(parseEditorOutput(JSON.stringify(notApplied)).ok, false);
});

test("editor instructions carry the prompt version and the strict schema", () => {
  const sys = buildEditorInstructions("safety_alert");
  assert.ok(sys.includes(EDITOR_PROMPT_VERSION));
  assert.ok(sys.includes("edit_applied"));
  assert.ok(sys.includes("editorial_verdict"));
});

// --- Required-action preservation: discard equivalence + distinct actions --
// The editor's required-action check compares official-action CODES, so an
// Arabized shortening of the disposal reference ("التخلص منه" for the fuller
// "التخلص من المنتج") is the SAME discard action and must not read as dropped —
// while removing discard entirely, or keeping only return, must still fail.

const DISCARD_PACKET: EditorFactPacket = {
  profile: "safety_alert",
  sourceText:
    "Facilities should return the product to place of purchase and discard the product.",
  readerEssential: [],
  conditional: [],
  verificationOnly: [],
  requiredActions: ["return", "discard"],
};

function artBody(body: string): EditorArticle {
  return { title: "سحب منتج", excerpt: "مقتطف", summary: "ملخّص", body };
}

test("dropped-action: 'التخلص منه' preserves the discard action (not a drop)", () => {
  const original = artBody("على المنشآت إرجاع المنتج إلى مكان الشراء أو التخلص من المنتج.");
  const edited = artBody("على المنشآت إرجاع المنتج إلى مكان الشراء أو التخلص منه.");
  assert.deepEqual(droppedRequiredActions(original, edited, DISCARD_PACKET), []);
});

test("dropped-action: 'إتلاف المنتج' preserves the discard action (not a drop)", () => {
  const original = artBody("على المنشآت إرجاع المنتج إلى مكان الشراء أو التخلص من المنتج.");
  const edited = artBody("على المنشآت إرجاع المنتج إلى مكان الشراء ثم إتلاف المنتج.");
  assert.deepEqual(droppedRequiredActions(original, edited, DISCARD_PACKET), []);
});

test("dropped-action: removing the discard action entirely STILL fails", () => {
  const original = artBody("على المنشآت إرجاع المنتج إلى مكان الشراء أو التخلص من المنتج.");
  // Edit keeps only return; the disposal instruction is gone.
  const edited = artBody("على المنشآت إرجاع المنتج إلى مكان الشراء فقط.");
  assert.deepEqual(droppedRequiredActions(original, edited, DISCARD_PACKET), ["discard"]);
});

test("dropped-action: return ALONE does not satisfy discard when both are required", () => {
  const original = artBody("على المنشآت إرجاع المنتج وإتلاف المنتج.");
  const edited = artBody("على المنشآت إرجاع المنتج إلى مكان الشراء.");
  // return is preserved, but discard is not — return cannot cover for discard.
  assert.deepEqual(droppedRequiredActions(original, edited, DISCARD_PACKET), ["discard"]);
});

// --- Number/noun agreement (both polarities, over the whole visible story) --

test("agreement gate: 'ثلاثة دفعات' (masc number + fem plural) is flagged", () => {
  const g = editorialGate(
    artBody("سحبت الشركة ثلاثة دفعات من المنتج بعد رصد جسيمات."),
    "safety_alert",
  );
  assert.ok(g.needs_review.includes("editorial_arabic_agreement_error"));
});

test("agreement gate: 'ثلاث أدوية' (fem number + masc plural) is flagged", () => {
  const g = editorialGate(
    artBody("شملت المراجعة ثلاث أدوية مختلفة في السوق المحلية."),
    "safety_alert",
  );
  assert.ok(g.needs_review.includes("editorial_arabic_agreement_error"));
});

test("agreement gate: correct 'ثلاث دفعات' and 'ثلاثة مستشفيات' are NOT flagged", () => {
  const g1 = editorialGate(
    artBody("سحبت الشركة ثلاث دفعات من المنتج بعد رصد جسيمات في العبوات."),
    "safety_alert",
  );
  assert.ok(!g1.needs_review.includes("editorial_arabic_agreement_error"));
  const g2 = editorialGate(
    artBody("شمل القرار ثلاثة مستشفيات حكومية في المنطقة الجنوبية للبلاد."),
    "safety_alert",
  );
  assert.ok(!g2.needs_review.includes("editorial_arabic_agreement_error"));
});

test("agreement gate: a slip in the EXCERPT (not just body) is caught", () => {
  const g = editorialGate(
    {
      title: "سحب دفعات من منتج طبي",
      excerpt: "سحبت الشركة ثلاثة دفعات من المنتج بعد رصد جسيمات.",
      summary: "على المنشآت وقف الاستخدام.",
      body: "سحبت الشركة عدداً من الدفعات بعد رصد جسيمات داخل العبوات.",
    },
    "safety_alert",
  );
  assert.ok(g.needs_review.includes("editorial_arabic_agreement_error"));
});

test("agreement gate: 'ليست أدوية' does NOT false-trigger the check", () => {
  const g = editorialGate(
    artBody("هذه المواد ليست أدوية بل مكمّلات غذائية عادية لا تستلزم وصفة."),
    "safety_alert",
  );
  assert.ok(!g.needs_review.includes("editorial_arabic_agreement_error"));
});

// --- Opening style: prefer the direct active event over an announce lead -----

test("opening gate: an 'أعلنت … سحباً' lead is flagged as a press-release opening", () => {
  const g = editorialGate(
    artBody("أعلنت شركة سني فارماتيك سحباً طوعياً لثلاث دفعات من المنتج بعد رصد جسيمات."),
    "safety_alert",
  );
  assert.ok(g.needs_review.includes("editorial_press_release_opening"));
});

test("opening gate: a direct active 'سحبت شركة …' lead is NOT flagged", () => {
  const g = editorialGate(
    artBody("سحبت شركة سني فارماتيك ثلاث دفعات من المنتج بعد رصد جسيمات داخل العبوات."),
    "safety_alert",
  );
  assert.ok(!g.needs_review.includes("editorial_press_release_opening"));
});

test("editor prompt states the number-agreement rule and the direct-opening preference", () => {
  const sys = buildEditorInstructions("safety_alert");
  assert.ok(sys.includes("ثلاث دفعات"));
  assert.ok(sys.includes("ثلاثة أدوية"));
  assert.ok(sys.includes("سحبت شركة"));
});

// =========================================================================
// E1.6 — Provider-level structured output + one formatting-only recovery.
// =========================================================================

// A scripted transport: returns the next EditorCallResult per call, records the
// model and the strictRecovery flag it was invoked with, and counts calls. The
// last scripted result repeats if the orchestrator ever called more than
// expected — so an over-eager retry would be caught by the call count, not hidden.
function sequenceCall(results: EditorCallResult[]): {
  call: EditorCall;
  calls: () => number;
  models: () => string[];
  recoveryFlags: () => boolean[];
} {
  let n = 0;
  const models: string[] = [];
  const recoveryFlags: boolean[] = [];
  const call: EditorCall = async (model, opts) => {
    models.push(model);
    recoveryFlags.push(opts?.strictRecovery === true);
    const item = results[Math.min(n, results.length - 1)];
    n++;
    return item;
  };
  return { call, calls: () => n, models: () => models, recoveryFlags: () => recoveryFlags };
}

function runSafetyWith(
  call: EditorCall,
  revalidate: EditorRevalidate,
  original: EditorArticle = SAFETY_ORIGINAL,
) {
  const packet = safetyPacket();
  return runEditorPass({
    profile: "safety_alert",
    model: "openai/gpt-5.4-mini",
    original: { article: original, readMinutes: 1 },
    packet,
    call,
    revalidate,
    verificationOnly: packet.verificationOnly,
  });
}

const ok = (content: string): EditorCallResult => ({ ok: true, content });

// §14.19 A valid strict-JSON edit succeeds on the FIRST call — no recovery.
test("§14.19 valid strict JSON is accepted on the first call, no recovery", async () => {
  const seq = sequenceCall([ok(SAFETY_GOOD_EDIT)]);
  const res = await runSafetyWith(seq.call, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(seq.calls(), 1);
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.editor_attempts, 1);
  assert.equal(res.audit.first_attempt_failure_reason, null);
  assert.equal(res.audit.recovery_attempted, false);
  assert.equal(res.audit.recovery_succeeded, false);
  assert.equal(res.audit.final_editor_failure_reason, null);
  assert.deepEqual(seq.recoveryFlags(), [false]);
});

// §14.20 Malformed JSON triggers EXACTLY ONE formatting-only recovery call; a
// valid recovery response is then accepted. Max editor calls is 2.
test("§14.20 malformed JSON triggers one recovery call and a valid recovery is accepted", async () => {
  const seq = sequenceCall([ok("this is not json at all"), ok(SAFETY_GOOD_EDIT)]);
  const res = await runSafetyWith(seq.call, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(seq.calls(), 2);
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.final_draft_source, "first_edit");
  assert.equal(res.audit.second_attempt_type, "formatting_recovery");
  assert.equal(res.audit.editor_attempts, 2);
  assert.ok((res.audit.first_attempt_failure_reason ?? "").startsWith("editor_output_"));
  assert.equal(res.audit.recovery_attempted, true);
  assert.equal(res.audit.recovery_succeeded, true);
  assert.equal(res.audit.final_editor_failure_reason, null);
  // The recovery call carried the stricter-JSON flag; the first did not.
  assert.deepEqual(seq.recoveryFlags(), [false, true]);
});

// §14.21 Two malformed responses safely retain the ORIGINAL; never marked ready.
test("§14.21 two malformed responses retain the original and mark needs_human_review", async () => {
  const seq = sequenceCall([ok("garbage one"), ok("garbage two")]);
  const res = await runSafetyWith(seq.call, okRevalidate);
  assert.equal(seq.calls(), 2);
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.final_draft_source, "original");
  assert.equal(res.audit.editorial_verdict, "needs_human_review");
  assert.equal(res.audit.editor_attempts, 2);
  assert.equal(res.audit.recovery_attempted, true);
  assert.equal(res.audit.recovery_succeeded, false);
  assert.ok((res.audit.first_attempt_failure_reason ?? "").startsWith("editor_output_"));
  assert.ok((res.audit.final_editor_failure_reason ?? "").startsWith("editor_output_"));
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
  assert.deepEqual(seq.recoveryFlags(), [false, true]);
});

// §14.22 A FACTUAL rejection never triggers a recovery (evaluated, not a format
// failure): exactly one call, original retained.
test("§14.22 a factual rejection never triggers a recovery call", async () => {
  const bad = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية",
    excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة.",
    summary: "التوقف عن استخدام الدفعات المتأثرة فوراً.",
    body: SAFETY_GOOD_EDIT_BODY + "\n\nوقالت الجهة إن «هذا الدواء آمن تماماً بعد السحب».",
  });
  const seq = sequenceCall([ok(bad), ok(SAFETY_GOOD_EDIT)]);
  const res = await runSafetyWith(seq.call, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(seq.calls(), 1);
  assert.equal(res.audit.factual_revalidation_result, "failed");
  assert.equal(res.audit.editor_attempts, 1);
  assert.equal(res.audit.recovery_attempted, false);
  assert.equal(res.audit.recovery_succeeded, false);
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// §14.23 A dropped required-audience-action rejection never triggers a recovery.
test("§14.23 a dropped required-action rejection never triggers a recovery call", async () => {
  const bad = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن",
    excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة.",
    summary: "تفاصيل حول الدفعات المتأثرة.",
    body:
      "رصدت السلطات جسيمات معدنية داخل قوارير من دواء سيكلوفوسفاميد للحقن قد تسبب خطر التجلّط للمرضى. وتتابع الجهات المختصة الأمر عن كثب.",
  });
  const seq = sequenceCall([ok(bad), ok(SAFETY_GOOD_EDIT)]);
  const res = await runSafetyWith(seq.call, okRevalidate);
  assert.equal(seq.calls(), 1);
  assert.match(res.audit.editor_rejection_reason ?? "", /editor_dropped_required_action/);
  assert.equal(res.audit.editor_attempts, 1);
  assert.equal(res.audit.recovery_attempted, false);
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// §14.24 Maximum editor calls is two, and the model requested is never swapped
// for a fallback (no Gemini): every call uses the SAME configured editor model.
test("§14.24 at most two editor calls and no model fallback (no Gemini)", async () => {
  const seq = sequenceCall([ok("nope"), ok("still nope"), ok(SAFETY_GOOD_EDIT)]);
  const res = await runSafetyWith(seq.call, okRevalidate);
  assert.equal(seq.calls(), 2); // never reaches the 3rd scripted result
  assert.equal(res.audit.editor_attempts, 2);
  for (const m of seq.models()) {
    assert.equal(m, "openai/gpt-5.4-mini");
    assert.ok(!/gemini/i.test(m));
  }
});

// §14.25 A recoverable transport-completion failure (truncated completion) is
// retried once; a NON-recoverable transport failure (timeout) is not.
test("§14.25 recoverability of editor failure reasons is classified correctly", () => {
  // Recoverable: strict-parser structural failures, invalid/empty completion.
  assert.equal(isRecoverableEditorFailure("editor_output_invalid_json"), true);
  assert.equal(isRecoverableEditorFailure("editor_output_truncated"), true);
  assert.equal(isRecoverableEditorFailure("editor_output_schema_invalid"), true);
  assert.equal(isRecoverableEditorFailure("editor_completed_invalid:length"), true);
  assert.equal(isRecoverableEditorFailure("editor_empty_completion"), true);
  // NOT recoverable: transport failures and non-formatting rejections.
  assert.equal(isRecoverableEditorFailure("editor_timeout"), false);
  assert.equal(isRecoverableEditorFailure("editor_network_error"), false);
  assert.equal(isRecoverableEditorFailure("editor_http_500"), false);
  assert.equal(isRecoverableEditorFailure("editor_api_key_missing"), false);
  assert.equal(isRecoverableEditorFailure("unsupported_number:9"), false);
});

// §14.26 A truncated-completion first attempt (recoverable) is retried once and
// the valid recovery is accepted, proving the recovery path is completion-aware.
test("§14.26 a truncated completion is recovered once and then accepted", async () => {
  const seq = sequenceCall([
    { ok: false, reason: "editor_completed_invalid:length" },
    ok(SAFETY_GOOD_EDIT),
  ]);
  const res = await runSafetyWith(seq.call, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(seq.calls(), 2);
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.recovery_attempted, true);
  assert.equal(res.audit.recovery_succeeded, true);
  assert.equal(res.audit.first_attempt_failure_reason, "editor_call_failed:editor_completed_invalid:length");
});

// §14.27 A NON-recoverable transport failure (timeout) is never retried.
test("§14.27 a non-recoverable transport failure is not retried", async () => {
  const seq = sequenceCall([{ ok: false, reason: "editor_timeout" }, ok(SAFETY_GOOD_EDIT)]);
  const res = await runSafetyWith(seq.call, okRevalidate);
  assert.equal(seq.calls(), 1);
  assert.equal(res.audit.editor_attempts, 1);
  assert.equal(res.audit.recovery_attempted, false);
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// §14.28 Valid Arabic-first parenthetical identities do NOT count as excess
// English (the Cyclophosphamide false-positive fix). Two names, each glossed
// once in parentheses, with an all-Arabic title.
test("§14.28 valid first-mention Arabic-first glosses do not trigger excess-English", () => {
  const g = editorialGate(
    {
      title: "سحب دفعات من دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات",
      excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة نتيجة التلوث.",
      summary: "على المرضى والكوادر التوقف عن استخدام الدفعات المتأثرة فوراً.",
      body:
        "سحبت شركة سني فارماتيك (Sunny Pharmtech) ثلاث دفعات من دواء سيكلوفوسفاميد (Cyclophosphamide) للحقن بعد رصد جسيمات معدنية قد تعرّض المرضى لخطر التجلّط.\n\nونصحت المرضى والكوادر بالتوقف عن استخدام الدفعات المتأثرة فوراً.",
    },
    "safety_alert",
  );
  assert.ok(!g.advisory.includes("editorial_excess_english_tokens"));
  assert.ok(!g.advisory.includes("editorial_excess_english_in_parenthetical"));
  assert.ok(!g.needs_review.includes("editorial_english_name_repeated_after_first"));
  assert.deepEqual(g.blocking, []);
});

// §14.29 Genuinely excess distinct English OUTSIDE a gloss still flags, and a
// bloated parenthetical (a phrase, not a name) still flags separately.
test("§14.29 unnecessary/excess English still triggers the advisories", () => {
  const outside = editorialGate(
    {
      title: "تقرير عن أدوية في السوق",
      excerpt: "مراجعة موسّعة لعدد من المنتجات الطبية.",
      summary: "قائمة بالمنتجات قيد المراجعة.",
      body: "شملت المراجعة منتجات تحمل الأسماء Alpha Beta Gamma Delta ضمن السوق المحلية.",
    },
    "safety_alert",
  );
  assert.ok(outside.advisory.includes("editorial_excess_english_tokens"));

  const bloatedParen = editorialGate(
    {
      title: "سحب دفعات من دواء سيكلوفوسفاميد للحقن",
      excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة.",
      summary: "التوقف عن استخدام الدفعات المتأثرة فوراً.",
      body:
        "سحبت الجهة دواء سيكلوفوسفاميد (Cyclophosphamide for Injection USP Powder Solution) بعد رصد جسيمات معدنية، ونصحت بالتوقف عن استخدامه.",
    },
    "safety_alert",
  );
  assert.ok(bloatedParen.advisory.includes("editorial_excess_english_in_parenthetical"));
});

// §14.30 The strict-recovery instruction is only appended when requested, and it
// keeps the same output contract while adding a formatting-only correction note.
test("§14.30 the strict-recovery instruction is appended only on recovery", () => {
  const base = buildEditorInstructions("safety_alert");
  const strict = buildEditorInstructions("safety_alert", { strictJsonRecovery: true });
  assert.ok(strict.length > base.length);
  assert.ok(strict.includes("محاولة تصحيح التنسيق فقط"));
  assert.ok(!base.includes("محاولة تصحيح التنسيق فقط"));
  // Both still state the required control fields (contract is unchanged).
  assert.ok(strict.includes("edit_applied"));
  assert.ok(strict.includes("editorial_verdict"));
});

// §14.31 The provider-level structured-output contract is a strict json_schema
// requiring exactly the editor object and forbidding extra fields.
test("§14.31 the editor response_format is a strict json_schema for the exact object", () => {
  assert.equal(EDITOR_RESPONSE_FORMAT.type, "json_schema");
  assert.equal(EDITOR_RESPONSE_FORMAT.json_schema.strict, true);
  const schema = EDITOR_RESPONSE_FORMAT.json_schema.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), [
    "body",
    "edit_applied",
    "editorial_verdict",
    "excerpt",
    "issues_found",
    "changes_made",
    "summary",
    "title",
  ].sort());
  assert.deepEqual(schema.properties.editorial_verdict.enum, ["ready", "needs_human_review"]);
});

// --- §15 E1.7 editorial-judgment discipline -------------------------------
// Reader-value prioritization, regulatory-detail trimming, accurate recall
// attribution, and no unsupported absolute reassurance. The approved compact
// targets must pass clean; verbose regulatory-notice versions must warn; the
// two integrity issues (mis-attribution, unsupported reassurance) require the
// verified source to judge and are needs_review (so verdict ≠ ready).

// Verified sources: both are COMPANY-initiated voluntary recalls; neither
// calls the unaffected batches "safe".
const PAP_SOURCE =
  "أعلنت شركة أمريكان ريجنت (American Regent) سحباً طوعياً لدفعة واحدة من حقن بابافيرين بعد العثور على جسيمات زجاجية ومادة كيميائية داخل بعض العبوات. والدفعات الأخرى غير مشمولة بالسحب. ودعت المرضى إلى وقف الاستخدام والتواصل مع الطبيب، وطلبت من المنشآت الصحية عدم استخدام الدفعة المتأثرة.";
const CYC_SOURCE =
  "سحبت شركة سني فارماتيك (Sunny Pharmtech) ثلاث دفعات من حقن سيكلوفوسفاميد في الولايات المتحدة بعد العثور على جسيمات معدنية داخل بعض العبوات. وقد يسبب إعطاء الدواء عبر الوريد مع وجود هذه الجسيمات مضاعفات خطرة من بينها انسداد الأوعية الدموية. وطلبت الشركة من المستشفيات والصيدليات وقف استخدام الدفعات المتأثرة وعزلها وإعادتها وفق تعليمات السحب. ولم تُسجّل حتى الآن إصابات أو آثار جانبية مرتبطة بالمشكلة.";

// The user-approved compact target articles.
const PAP_TARGET: EditorArticle = {
  title: "سحب دفعة من حقن بابافيرين بعد العثور على جسيمات داخل العبوات",
  excerpt:
    "سحبت شركة أمريكان ريجنت دفعة من حقن بابافيرين بعد اكتشاف جسيمات داخل بعض العبوات، ودعت المرضى إلى وقف استخدامها والتواصل مع الطبيب.",
  summary: "على المرضى وقف استخدام الحقن والتواصل مع الطبيب.",
  body:
    "سحبت شركة أمريكان ريجنت (American Regent) دفعة من حقن بابافيرين (Papaverine) في الولايات المتحدة، بعد العثور على جسيمات زجاجية ومادة كيميائية داخل بعض العبوات.\n\nوحذّرت من أن استخدام المنتج المتأثر قد يسبب تهيجاً أو تورماً موضعياً، وقد يؤدي في حالات خطرة إلى انسداد الأوعية الدموية.\n\nودعت المرضى إلى وقف استخدام الحقن والتواصل مع الطبيب، كما طلبت من المنشآت الصحية عدم استخدام الدفعة المتأثرة. ولم تُسجّل حتى الآن آثار جانبية مرتبطة بها.",
};
const CYC_TARGET: EditorArticle = {
  title: "سحب ثلاث دفعات من حقن سيكلوفوسفاميد بسبب جسيمات معدنية",
  excerpt:
    "سحبت شركة سني فارماتيك ثلاث دفعات من الحقن بعد العثور على جسيمات معدنية، وطلبت من المستشفيات والصيدليات وقف استخدامها وعزل الكميات المتأثرة.",
  summary: "على المستشفيات والصيدليات وقف استخدام الدفعات المتأثرة وعزلها.",
  body:
    "سحبت شركة سني فارماتيك (Sunny Pharmtech) ثلاث دفعات من حقن سيكلوفوسفاميد (Cyclophosphamide) في الولايات المتحدة، بعد العثور على جسيمات معدنية داخل بعض العبوات.\n\nوحذّرت من أن إعطاء الدواء عبر الوريد مع وجود هذه الجسيمات قد يسبب مضاعفات خطرة، من بينها انسداد الأوعية الدموية.\n\nوطلبت من المستشفيات والصيدليات وقف استخدام الدفعات المتأثرة وعزلها وإعادتها وفق تعليمات السحب. ولم تُسجّل حتى الآن إصابات أو آثار جانبية مرتبطة بالمشكلة.",
};

const E17_CODES = [
  "editorial_unnecessary_clinical_use",
  "editorial_unnecessary_strength_or_packaging",
  "editorial_excess_complications",
  "editorial_unnecessary_batch_number",
  "editorial_unnecessary_formal_english",
  "editorial_incorrect_recall_attribution",
  "editorial_unsupported_reassurance",
];

// §15.1 The approved Papaverine compact target passes clean against its source:
// no blocking, and none of the E1.7 detail/integrity warnings — including no
// mis-attribution, because the company (not the regulator) is credited.
test("§15.1 the Papaverine compact target passes clean", () => {
  const gate = editorialGate(PAP_TARGET, "safety_alert", { sourceText: PAP_SOURCE });
  assert.deepEqual(gate.blocking, []);
  for (const code of E17_CODES) assert.ok(!gate.needs_review.includes(code), `unexpected ${code}`);
  assert.ok(!gate.needs_review.includes("editorial_incorrect_recall_attribution"));
});

// §15.2 A verbose Papaverine version — regulator-credited recall, batch number,
// formal English identity, and "safe" wording — raises exactly the E1.7 warnings.
test("§15.2 the verbose Papaverine version raises the E1.7 warnings", () => {
  const gate = editorialGate(
    {
      title: "سحب دفعة من حقن بابافيرين بعد العثور على جسيمات",
      excerpt: "بيان حول سحب دفعة من الحقن.",
      summary: "التوقف عن استخدام الدفعة المتأثرة.",
      body:
        "سحبت إدارة الغذاء والدواء الأميركية دفعة من دواء بابافيرين هيدروكلورايد (Papaverine Hydrochloride Injection, USP) في الولايات المتحدة، وذلك ضمن رقم الدفعة 25202 بعد العثور على جسيمات.\n\nوتبقى بقية الدفعات آمنة ولا تشكّل أي خطر على المرضى، ودعت إلى وقف استخدام الدفعة المتأثرة.",
    },
    "safety_alert",
    { sourceText: PAP_SOURCE },
  );
  assert.ok(gate.needs_review.includes("editorial_incorrect_recall_attribution"));
  assert.ok(gate.needs_review.includes("editorial_unnecessary_batch_number"));
  assert.ok(gate.needs_review.includes("editorial_unnecessary_formal_english"));
  assert.ok(gate.needs_review.includes("editorial_unsupported_reassurance"));
});

// §15.3 "غير مشمولة بالسحب" must not become "آمنة" unless the source supports it:
// unsupported → warns; when the source itself uses the absolute wording → clean.
test("§15.3 absolute reassurance is flagged only when the source does not support it", () => {
  const article: EditorArticle = {
    title: "سحب دفعة من حقن بابافيرين",
    excerpt: "دعوة إلى وقف استخدام الدفعة المتأثرة.",
    summary: "التوقف عن الاستخدام.",
    body:
      "سحبت شركة أمريكان ريجنت (American Regent) دفعة من حقن بابافيرين (Papaverine)، وتبقى بقية الدفعات آمنة.",
  };
  const unsupported = editorialGate(article, "safety_alert", { sourceText: PAP_SOURCE });
  assert.ok(unsupported.needs_review.includes("editorial_unsupported_reassurance"));

  const supportedSource = `${PAP_SOURCE} وأكدت الشركة أن بقية الدفعات آمنة.`;
  const supported = editorialGate(article, "safety_alert", { sourceText: supportedSource });
  assert.ok(!supported.needs_review.includes("editorial_unsupported_reassurance"));
});

// §15.4 A company-initiated recall is not attributed to the regulator: crediting
// the company is clean; crediting the regulator over the same source warns.
test("§15.4 a company recall is not attributed to the regulator", () => {
  const companyCredited = editorialGate(PAP_TARGET, "safety_alert", { sourceText: PAP_SOURCE });
  assert.ok(!companyCredited.needs_review.includes("editorial_incorrect_recall_attribution"));

  const regulatorCredited = editorialGate(
    {
      title: "سحب دفعة من حقن بابافيرين",
      excerpt: "قرار احترازي لحماية المرضى.",
      summary: "التوقف عن الاستخدام.",
      body:
        "سحبت إدارة الغذاء والدواء الأميركية دفعة من حقن بابافيرين (Papaverine) بعد العثور على جسيمات، ودعت المرضى إلى وقف الاستخدام.",
    },
    "safety_alert",
    { sourceText: PAP_SOURCE },
  );
  assert.ok(regulatorCredited.needs_review.includes("editorial_incorrect_recall_attribution"));
});

// §15.5 The approved Cyclophosphamide compact target passes clean.
test("§15.5 the Cyclophosphamide compact target passes clean", () => {
  const gate = editorialGate(CYC_TARGET, "safety_alert", { sourceText: CYC_SOURCE });
  assert.deepEqual(gate.blocking, []);
  for (const code of E17_CODES) assert.ok(!gate.needs_review.includes(code), `unexpected ${code}`);
});

// §15.6 A verbose Cyclophosphamide version — clinical-use paragraph, dosage
// strengths / single-dose vials, a long complication chain, and formal English
// identity — raises the corresponding E1.7 detail warnings.
test("§15.6 the verbose Cyclophosphamide version raises the E1.7 detail warnings", () => {
  const gate = editorialGate(
    {
      title: "سحب ثلاث دفعات من حقن سيكلوفوسفاميد",
      excerpt: "قرار احترازي بعد رصد جسيمات معدنية.",
      summary: "التوقف عن استخدام الدفعات المتأثرة.",
      body:
        "يُستخدم سيكلوفوسفاميد لعلاج أنواع من السرطان والمتلازمة الكلوية، وقد سُحبت ثلاث دفعات منه بتركيزين 1 غرام و2 غرام في قوارير أحادية الجرعة.\n\nوحذّرت الشركة من أن الجسيمات قد تسبب التهاب الوريد أو ورم حبيبي أو انسداداً قد يصل إلى أحداث خثرية مهددة للحياة، ضمن منتج (Cyclophosphamide for Injection, USP).\n\nوطلبت وقف الاستخدام فوراً.",
    },
    "safety_alert",
  );
  assert.ok(gate.needs_review.includes("editorial_unnecessary_clinical_use"));
  assert.ok(gate.needs_review.includes("editorial_unnecessary_strength_or_packaging"));
  assert.ok(gate.needs_review.includes("editorial_excess_complications"));
  assert.ok(gate.needs_review.includes("editorial_unnecessary_formal_english"));
});

// §15.7 The compact target still preserves the essential risk and action and
// re-passes real factual validation end-to-end (edit accepted, verdict ready).
test("§15.7 the compact target preserves risk + action and passes revalidation", async () => {
  const packet = buildFactPacket({
    profile: "safety_alert",
    sourceText: CYC_SOURCE,
    mustPreserve: ["سيكلوفوسفاميد"],
  });
  const { call, calls } = countingCall(editorJson({
    title: CYC_TARGET.title,
    excerpt: CYC_TARGET.excerpt,
    summary: CYC_TARGET.summary ?? "",
    body: CYC_TARGET.body,
  }));
  const res = await runEditorPass({
    profile: "safety_alert",
    model: "openai/gpt-5.4-mini",
    original: { article: CYC_TARGET, readMinutes: 1 },
    packet,
    call,
    revalidate: realRevalidate(CYC_SOURCE, ["سيكلوفوسفاميد"], "safety_alert"),
    verificationOnly: packet.verificationOnly,
  });
  assert.equal(calls(), 1);
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.factual_revalidation_result, "passed");
  assert.equal(res.audit.editorial_verdict, "ready");
  assert.ok(res.article.body.includes("انسداد الأوعية الدموية"));
  assert.ok(res.article.body.includes("وقف استخدام"));
});

// =========================================================================
// §16 E1.8 — Final English-placement policy + one targeted editorial repair.
// The second editor call is EITHER a formatting recovery OR an editorial repair,
// never both; a factually-valid edit is always retained; a repair is chosen only
// when it strictly reduces the repairable issues without touching a protected
// fact; the original is used only when NO valid editor draft exists.
// =========================================================================

// A transport that scripts results per call AND records, for each call, whether
// it was a normal / formatting-recovery / editorial-repair call, plus the repair
// draft + issues it carried. Proves the two-call budget and mutual exclusivity.
function trackingCall(results: EditorCallResult[]): {
  call: EditorCall;
  calls: () => number;
  kinds: () => ("normal" | "recovery" | "repair")[];
  repairDrafts: () => (EditorArticle | null)[];
  repairIssues: () => (string[] | null)[];
} {
  let n = 0;
  const kinds: ("normal" | "recovery" | "repair")[] = [];
  const repairDrafts: (EditorArticle | null)[] = [];
  const repairIssuesArr: (string[] | null)[] = [];
  const call: EditorCall = async (_model, opts) => {
    kinds.push(opts?.repair ? "repair" : opts?.strictRecovery ? "recovery" : "normal");
    repairDrafts.push(opts?.repair?.draft ?? null);
    repairIssuesArr.push(opts?.repair?.issues ?? null);
    const item = results[Math.min(n, results.length - 1)];
    n++;
    return item;
  };
  return {
    call,
    calls: () => n,
    kinds: () => kinds,
    repairDrafts: () => repairDrafts,
    repairIssues: () => repairIssuesArr,
  };
}

// A first edit that is factually grounded in SAFETY_SOURCE but carries exactly
// one repairable editorial issue: the literal/regulatory phrase «على مستوى
// المستخدم». Arabic-only title/excerpt/summary; one first-paragraph gloss.
const FIRST_EDIT_PROMO_BODY =
  "سحبت شركة الأدوية دفعات من دواء سيكلوفوسفاميد (Cyclophosphamide) للحقن بعد رصد جسيمات معدنية قد تسبب خطر التجلّط.\n\nونصحت المرضى والكوادر بالتوقف عن استخدام الدفعات المتأثرة على مستوى المستخدم.";
const REPAIRED_CLEAN_BODY =
  "سحبت شركة الأدوية دفعات من دواء سيكلوفوسفاميد (Cyclophosphamide) للحقن بعد رصد جسيمات معدنية قد تسبب خطر التجلّط.\n\nونصحت المرضى والكوادر بالتوقف عن استخدام الدفعات المتأثرة فوراً.";
const E18_FIELDS = {
  title: "سحب دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية",
  excerpt: "قرار احترازي لحماية المرضى من مضاعفات محتملة نتيجة التلوث.",
  summary: "التوقف عن استخدام الدفعات المتأثرة فوراً.",
};
const firstEditPromoJson = editorJson({ ...E18_FIELDS, body: FIRST_EDIT_PROMO_BODY });
const repairedCleanJson = editorJson({ ...E18_FIELDS, body: REPAIRED_CLEAN_BODY });

// §16.1 The Arabic-only fields reject English: title (blocking), excerpt and
// summary (needs_review), each with its own code.
test("§16.1 English in title/excerpt/summary is caught per field", () => {
  const gate = editorialGate(
    {
      title: "سحب دواء Cyclophosphamide",
      excerpt: "سحبت شركة American Regent الدفعات المتأثرة.",
      summary: "التوقف عن الاستخدام Papaverine فوراً.",
      body:
        "سحبت شركة أمريكان ريجنت (American Regent) دفعات من الدواء بعد رصد جسيمات، ونصحت بالتوقف عن الاستخدام.",
    },
    "safety_alert",
  );
  assert.ok(gate.blocking.includes("editorial_title_has_english"));
  assert.ok(gate.needs_review.includes("editorial_excerpt_has_english"));
  assert.ok(gate.needs_review.includes("editorial_summary_has_english"));
});

// §16.2 Exactly one first-paragraph parenthetical identity per name passes: no
// blocking, no repeat, no excess, and NOTHING repairable about the English.
test("§16.2 one first-body-paragraph parenthetical passes clean", () => {
  const gate = editorialGate(PAP_TARGET, "safety_alert");
  assert.deepEqual(gate.blocking, []);
  assert.ok(!gate.needs_review.includes("editorial_english_name_repeated_after_first"));
  assert.ok(!gate.advisory.includes("editorial_excess_english_tokens"));
  assert.ok(!gate.advisory.includes("editorial_excess_english_in_parenthetical"));
  const repairable = repairableEditorialIssues(gate);
  for (const code of [
    "editorial_title_has_english",
    "editorial_excerpt_has_english",
    "editorial_summary_has_english",
    "editorial_foreign_name_english_only",
    "editorial_english_name_repeated_after_first",
  ]) {
    assert.ok(!repairable.includes(code), `unexpected repairable ${code}`);
  }
});

// §16.3 The English identity repeated in a later body paragraph is repairable.
test("§16.3 English repeated later in the body is a repairable issue", () => {
  const gate = editorialGate(
    {
      title: "سحب دفعة من حقن بابافيرين",
      excerpt: "قرار احترازي لحماية المرضى.",
      summary: "التوقف عن الاستخدام فوراً.",
      body:
        "سحبت شركة أمريكان ريجنت (American Regent) دفعة من حقن بابافيرين (Papaverine) بعد رصد جسيمات.\n\nوأكدت American Regent أن بقية الدفعات غير مشمولة بالسحب.",
    },
    "safety_alert",
  );
  assert.ok(gate.needs_review.includes("editorial_english_name_repeated_after_first"));
  assert.ok(repairableEditorialIssues(gate).includes("editorial_english_name_repeated_after_first"));
});

// §16.4 The English identity repeated ACROSS the excerpt and the body is
// repairable — the exact issue this refinement targets.
test("§16.4 English repeated between excerpt and body is repairable", () => {
  const gate = editorialGate(
    {
      title: "سحب دفعة من حقن بابافيرين",
      excerpt: "سحبت شركة American Regent دفعة من الحقن.",
      summary: "التوقف عن الاستخدام فوراً.",
      body:
        "سحبت شركة أمريكان ريجنت (American Regent) دفعة من حقن بابافيرين (Papaverine) بعد رصد جسيمات، ونصحت بالتوقف عن الاستخدام.",
    },
    "safety_alert",
  );
  const repairable = repairableEditorialIssues(gate);
  assert.ok(repairable.includes("editorial_excerpt_has_english"));
  assert.ok(repairable.includes("editorial_english_name_repeated_after_first"));
});

// §16.5 The literal/regulatory phrase «على مستوى المستخدم» is a repairable issue.
test("§16.5 على مستوى المستخدم is a repairable editorial issue", () => {
  const gate = editorialGate({ ...E18_FIELDS, body: FIRST_EDIT_PROMO_BODY }, "safety_alert");
  assert.ok(gate.needs_review.includes("editorial_promo_or_literal_phrase"));
  assert.deepEqual(repairableEditorialIssues(gate), ["editorial_promo_or_literal_phrase"]);
});

// §16.6 A factually-valid repair that clears the issue REPLACES the first edit:
// the second call is the editorial repair (carrying the first edited draft + the
// exact issues), and the repaired draft is chosen. Exactly two calls.
test("§16.6 a valid repair replaces the first edit", async () => {
  const track = trackingCall([ok(firstEditPromoJson), ok(repairedCleanJson)]);
  const res = await runSafetyWith(track.call, okRevalidate);
  assert.equal(track.calls(), 2);
  assert.deepEqual(track.kinds(), ["normal", "repair"]);
  assert.equal(res.audit.second_attempt_type, "editorial_repair");
  assert.equal(res.audit.final_draft_source, "repaired_edit");
  assert.equal(res.audit.repair_succeeded, true);
  assert.deepEqual(res.audit.repair_issues, ["editorial_promo_or_literal_phrase"]);
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.editorial_verdict, "ready");
  assert.equal(res.article.body, REPAIRED_CLEAN_BODY);
  // The repair call carried the FIRST edited draft (not the writer draft).
  assert.equal(track.repairDrafts()[1]?.body, FIRST_EDIT_PROMO_BODY);
  assert.deepEqual(track.repairIssues()[1], ["editorial_promo_or_literal_phrase"]);
});

// §16.7 A repair that drops a protected fact is REJECTED and the first valid edit
// is retained (needs_human_review), with the rejection reason recorded.
test("§16.7 a fact-dropping repair is rejected, first valid edit retained", async () => {
  const repairDropsAction = editorJson({
    ...E18_FIELDS,
    body:
      "سحبت السلطات الصحية دفعات من دواء سيكلوفوسفاميد (Cyclophosphamide) للحقن بعد رصد جسيمات معدنية قد تسبب خطر التجلّط. وتتابع الجهات المختصة الأمر عن كثب.",
  });
  const track = trackingCall([ok(firstEditPromoJson), ok(repairDropsAction)]);
  const res = await runSafetyWith(track.call, okRevalidate);
  assert.equal(track.calls(), 2);
  assert.deepEqual(track.kinds(), ["normal", "repair"]);
  assert.equal(res.audit.second_attempt_type, "editorial_repair");
  assert.equal(res.audit.final_draft_source, "first_edit");
  assert.equal(res.audit.repair_succeeded, false);
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.first_valid_edited_draft_available, true);
  assert.match(res.audit.final_rejection_reason ?? "", /editor_dropped_required_action/);
  assert.equal(res.article.body, FIRST_EDIT_PROMO_BODY);
});

// §16.8 Formatting recovery and editorial repair are mutually exclusive: a
// malformed first response spends the second call on formatting recovery, and no
// editorial repair follows even if the recovered draft still has a repairable
// issue. At most two calls.
test("§16.8 formatting recovery precludes a further repair (two-call cap)", async () => {
  const track = trackingCall([ok("not json at all"), ok(firstEditPromoJson)]);
  const res = await runSafetyWith(track.call, okRevalidate);
  assert.equal(track.calls(), 2);
  assert.deepEqual(track.kinds(), ["normal", "recovery"]);
  assert.equal(res.audit.second_attempt_type, "formatting_recovery");
  assert.equal(res.audit.recovery_attempted, true);
  assert.equal(res.audit.recovery_succeeded, true);
  assert.equal(res.audit.final_draft_source, "first_edit");
  assert.equal(res.audit.edited_draft_accepted, true);
  // The recovered draft still carries the promo phrase → needs_human_review, but
  // NO third call was ever made.
  assert.equal(res.audit.editorial_verdict, "needs_human_review");
});

// §16.9 When the repair does not reduce the repairable issues, the first valid
// edit is kept (never regress) — still exactly two calls.
test("§16.9 a non-improving repair keeps the first edit; never more than two calls", async () => {
  // The repair returns the SAME flawed body → issues not reduced.
  const track = trackingCall([ok(firstEditPromoJson), ok(firstEditPromoJson)]);
  const res = await runSafetyWith(track.call, okRevalidate);
  assert.equal(track.calls(), 2);
  assert.deepEqual(track.kinds(), ["normal", "repair"]);
  assert.equal(res.audit.final_draft_source, "first_edit");
  assert.equal(res.audit.repair_succeeded, false);
  assert.equal(res.article.body, FIRST_EDIT_PROMO_BODY);
});

// §16.10 A factual (or audience) failure on the first edit NEVER triggers an
// editorial repair: exactly one call, and the original writer draft is retained.
test("§16.10 a factual failure never triggers an editorial repair", async () => {
  const track = trackingCall([ok(firstEditPromoJson), ok(repairedCleanJson)]);
  const res = await runSafetyWith(
    track.call,
    () => ({ ok: false, reason: "audience_action_mismatch" }) as ReturnType<EditorRevalidate>,
  );
  assert.equal(track.calls(), 1);
  assert.deepEqual(track.kinds(), ["normal"]);
  assert.equal(res.audit.second_attempt_type, "none");
  assert.equal(res.audit.recovery_attempted, false);
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.final_draft_source, "original");
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// §16.11 The editorial-repair instruction lists the exact issues to fix and
// forbids any factual change, while keeping the same output contract.
test("§16.11 the repair instruction lists the issues and forbids factual change", () => {
  const base = buildEditorInstructions("safety_alert");
  const repair = buildEditorInstructions("safety_alert", {
    repairIssues: ["editorial_promo_or_literal_phrase", "editorial_unnecessary_voluntary"],
  });
  assert.ok(repair.length > base.length);
  assert.ok(repair.includes("تصحيح تحريري موجّه"));
  assert.ok(repair.includes("على مستوى المستخدم"));
  assert.ok(repair.includes("طوعاً"));
  // Same output contract, and it is not the formatting-recovery note.
  assert.ok(repair.includes("edit_applied"));
  assert.ok(!repair.includes("محاولة تصحيح التنسيق فقط"));
});

// -------------------------------------------------------------------------
// §17 Safety-alert risk-retention fix (prompt-only). The deterministic risk
// guard (droppedAllRisk) and the factual validator are UNCHANGED; these tests
// pin the behaviour the prompt update must never let regress: a safety alert
// must keep exactly one concise verified risk sentence, an edit that removes
// all risk is still rejected as editor_dropped_risk, a faithful shortened risk
// is accepted, an exaggerated/unsupported risk still fails factual validation,
// and non-safety profiles are never forced to carry a medical-risk sentence.
// -------------------------------------------------------------------------
const RISK_RE = /خطر|تجل/; // a surviving reader-facing risk cue for this source

// §17.1 A safety-alert edit that keeps one concise verified risk sentence is
// accepted, and the risk survives into the stored article.
test("§17.1 a concise verified risk sentence is preserved and accepted", async () => {
  const edit = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية",
    excerpt: "قرار احترازي بعد رصد جسيمات قد تعرّض المرضى لخطر التجلّط.",
    summary: "على المرضى والكوادر التوقف عن استخدام الدفعات المتأثرة فوراً.",
    body:
      "رصدت السلطات الصحية جسيمات معدنية داخل قوارير من دواء سيكلوفوسفاميد المخصّص للحقن، وهو ما قد يعرّض المرضى لخطر التجلّط عند دخولها إلى الدم.\n\nونصحت الجهة المرضى والكوادر الطبية بالتوقف عن استخدام الدفعات المتأثرة فوراً.",
  });
  const { res } = await runSafety(edit, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.final_draft_source, "first_edit");
  assert.equal(res.audit.editor_rejection_reason, null);
  assert.match(res.article.body, RISK_RE);
});

// §17.2 An edit that strips EVERY risk sentence is still rejected as
// editor_dropped_risk, and the original (which keeps the risk) is retained.
test("§17.2 an edit removing all risk fails with editor_dropped_risk", async () => {
  // Faithful otherwise (keeps drug + stop-use action) but carries NO risk term.
  const noRisk = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية",
    excerpt: "قرار احترازي مع دعوة إلى وقف استخدام الدفعات المتأثرة.",
    summary: "على المرضى والكوادر التوقف عن استخدام الدفعات المتأثرة فوراً.",
    body:
      "رصدت السلطات الصحية جسيمات معدنية داخل قوارير من دواء سيكلوفوسفاميد المخصّص للحقن في الولايات المتحدة.\n\nونصحت الجهة المرضى والكوادر الطبية بالتوقف عن استخدام الدفعات المتأثرة فوراً، دون تسجيل أي حالات حتى الآن.",
  });
  // okRevalidate isolates the risk guard: factual re-validation passes, so the
  // ONLY bar left is droppedAllRisk.
  const { res } = await runSafety(noRisk, okRevalidate);
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.final_draft_source, "original");
  assert.equal(res.audit.editor_rejection_reason, "editor_dropped_risk");
  assert.deepEqual(res.article, SAFETY_ORIGINAL);
});

// §17.3 A shortened but faithful risk statement (a terse single clause) is
// accepted — compression is allowed as long as one risk cue remains.
test("§17.3 a shortened faithful risk statement is accepted", async () => {
  const edit = editorJson({
    title: "سحب دواء سيكلوفوسفاميد للحقن بعد رصد جسيمات معدنية",
    excerpt: "جسيمات معدنية قد تعرّض المرضى لخطر التجلّط تدفع إلى سحب الدواء.",
    summary: "على المرضى والكوادر التوقف عن استخدام الدفعات المتأثرة فوراً.",
    body:
      "رُصدت جسيمات معدنية في قوارير من دواء سيكلوفوسفاميد للحقن، وقد تسبب خطر التجلّط لدى المرضى.\n\nونصحت الجهة المرضى والكوادر الطبية بالتوقف عن استخدام الدفعات المتأثرة فوراً.",
  });
  const { res } = await runSafety(edit, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.final_draft_source, "first_edit");
  assert.match(res.article.body, RISK_RE);
});

// §17.4 An exaggerated / unsupported risk still fails: fabricating a harm figure
// not in the source is rejected by the UNCHANGED factual validator, so the
// original is retained. (Purely qualitative exaggeration remains governed by the
// prompt; the deterministic net catches unsupported numbers.)
test("§17.4 an exaggerated/unsupported risk still fails factual validation", async () => {
  const exaggerated = editorJson({
    title: "سحب دواء سيكلوفوسفاميد بعد وفاة 12 مريضاً",
    excerpt: "تسبّبت الجسيمات في وفاة 12 مريضاً وإصابة 300 آخرين.",
    summary: "على المرضى والكوادر التوقف عن استخدام الدفعات المتأثرة فوراً.",
    body:
      "رصدت السلطات الصحية جسيمات معدنية داخل قوارير من دواء سيكلوفوسفاميد للحقن، وقد تسبّبت في وفاة 12 مريضاً وإصابة 300 آخرين خلال الأسبوع الماضي.\n\nونصحت الجهة المرضى والكوادر بالتوقف عن استخدام الدفعات المتأثرة فوراً.",
  });
  const { res } = await runSafety(exaggerated, realRevalidate(SAFETY_SOURCE, SAFETY_MUST_PRESERVE, "safety_alert"));
  assert.equal(res.audit.edited_draft_accepted, false);
  assert.equal(res.audit.final_draft_source, "original");
  assert.equal(res.audit.factual_revalidation_result, "failed");
  assert.match(res.audit.editor_rejection_reason ?? "", /unsupported_number/);
});

// §17.5 A non-safety profile (quick_news) with NO risk in its source is never
// forced to include a medical-risk sentence: a risk-free edit is accepted and is
// never rejected as editor_dropped_risk.
test("§17.5 quick_news is not forced to carry a medical-risk sentence", async () => {
  const NEWS_SOURCE =
    "افتتحت وزارة الصحة مركزاً صحياً جديداً في منطقة الجهراء يقدّم خدمات الرعاية الأولية للسكان، ويضم عيادات للأسرة والأسنان ومختبراً للتحاليل. ويعمل المركز من الثامنة صباحاً حتى الثامنة مساءً.";
  const NEWS_ORIGINAL: EditorArticle = {
    title: "افتتاح مركز صحي جديد في الجهراء",
    excerpt: "مركز يقدّم خدمات الرعاية الأولية لسكان المنطقة.",
    summary: "المركز يعمل من الثامنة صباحاً حتى الثامنة مساءً.",
    body:
      "افتتحت وزارة الصحة مركزاً صحياً جديداً في منطقة الجهراء يقدّم خدمات الرعاية الأولية للسكان.\n\nويضم المركز عيادات للأسرة والأسنان ومختبراً للتحاليل، ويعمل من الثامنة صباحاً حتى الثامنة مساءً.",
  };
  const NEWS_EDIT = editorJson({
    title: "مركز صحي جديد في الجهراء يقدّم الرعاية الأولية",
    excerpt: "وزارة الصحة تفتتح مركزاً يضم عيادات للأسرة والأسنان ومختبراً للتحاليل.",
    summary: "المركز يعمل يومياً من الثامنة صباحاً حتى الثامنة مساءً.",
    body:
      "افتتحت وزارة الصحة مركزاً صحياً جديداً في منطقة الجهراء يقدّم خدمات الرعاية الأولية للسكان، ويضم عيادات للأسرة والأسنان ومختبراً للتحاليل.\n\nويعمل المركز يومياً من الثامنة صباحاً حتى الثامنة مساءً.",
  });
  const packet = buildFactPacket({ profile: "quick_news", sourceText: NEWS_SOURCE, mustPreserve: [] });
  const { call } = countingCall(NEWS_EDIT);
  const res = await runEditorPass({
    profile: "quick_news",
    model: "openai/gpt-5.4-mini",
    original: { article: NEWS_ORIGINAL, readMinutes: 1 },
    packet,
    call,
    revalidate: okRevalidate,
    verificationOnly: packet.verificationOnly,
  });
  assert.equal(res.audit.edited_draft_accepted, true);
  assert.equal(res.audit.final_draft_source, "first_edit");
  assert.notEqual(res.audit.editor_rejection_reason, "editor_dropped_risk");
});

// §17.6 The safety-alert prompt makes the risk-retention rule explicit: keep one
// concise most-important confirmed risk, list the five must-keep elements, and
// forbid inventing/strengthening/exaggerating the risk.
test("§17.6 the safety-alert prompt states the mandatory risk-retention rule", () => {
  const p = buildEditorInstructions("safety_alert");
  assert.ok(p.includes("الإبقاء الإلزامي على الخطر في تحذيرات السلامة"));
  assert.ok(p.includes("جملة واحدة موجزة على الأقل"));
  assert.ok(p.includes("العناصر الخمسة"));
  assert.ok(p.includes("يُمنع حذف كل معلومات الخطر"));
  assert.ok(p.includes("لا تختلق خطراً ولا تقوّيه"));
});
