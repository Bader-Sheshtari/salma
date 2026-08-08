// Post-editor source-fidelity repair tests (pure, NO live OpenRouter calls).
// Runs under Node's native TS type stripping (`node --test`) or `deno test`.
//
// Covers the 13 required editorial-policy-alignment behaviors:
//   1  unsupported_number repaired by deleting/correcting the number.
//   2  unsupported_number still rejects if it remains after repair.
//   3  invented quotation removed → the draft proceeds.
//   4  unsupported claim removed/softened using only the source.
//   5  missing_official_action can become pending + needs_human_review if unresolved.
//   6  invented_official_action remains blocking.
//   7  audience_misdirected_action remains blocking.
//   8  association_as_causation remains blocking.
//   9  missing_essential_entity remains blocking.
//   10 Editorial Director runs before the final fidelity rejection.
//   11 maximum one repair call.
//   12 no article can become published automatically.
//   13 (verification-suite) all existing tests remain green — plus fail-closed
//      classification of unknown codes so no existing validator is downgraded.

import test from "node:test";
import assert from "node:assert/strict";
import {
  assessFidelityErrors,
  classifyFidelityError,
  finalizeWriterDraft,
  orchestrateFidelityRepair,
  type FidelityArticle,
  type FidelityRepairCall,
  type FidelityValidation,
} from "./fidelityRepair.ts";

const DRAFT: FidelityArticle = {
  title: "عنوان تجريبي",
  excerpt: "مقتطف",
  summary: "",
  body: "نص المقال التجريبي للاختبار.".repeat(6),
};
const REPAIRED: FidelityArticle = { ...DRAFT, body: "النص بعد الإصلاح." };

const val = (errors: string[]): FidelityValidation => ({
  ok: errors.length === 0,
  errors,
  cleanTitle: "عنوان تجريبي",
  readMinutes: 3,
});

/** A validator returning scripted results in order (v0, then v1 after repair). */
function scripted(...results: FidelityValidation[]) {
  let i = 0;
  const calls: FidelityArticle[] = [];
  const fn = (a: FidelityArticle): FidelityValidation => {
    calls.push(a);
    return results[Math.min(i++, results.length - 1)];
  };
  return { fn, get calls() { return calls; } };
}

/** A repair transport that returns a fixed article and counts its invocations. */
function repairReturning(article: FidelityArticle): FidelityRepairCall & { count: () => number } {
  let n = 0;
  const call: FidelityRepairCall = async () => {
    n++;
    return { ok: true, article };
  };
  (call as FidelityRepairCall & { count: () => number }).count = () => n;
  return call as FidelityRepairCall & { count: () => number };
}

// --- 1: unsupported_number repaired by deleting/correcting it ---------------
test("1: unsupported_number is repaired and the draft proceeds", async () => {
  const v = scripted(val(["unsupported_number:11"]), val([]));
  const repair = repairReturning(REPAIRED);
  const r = await orchestrateFidelityRepair({ draft: DRAFT, readMinutes: 3, validate: v.fn, repair });
  assert.equal(r.decision, "clean");
  assert.equal(r.audit.draft_source, "repaired");
  assert.equal(r.audit.repair_call_succeeded, true);
  assert.equal(r.article.body, REPAIRED.body);
  assert.equal(repair.count(), 1);
});

// --- 2: unsupported_number still present after repair → reject --------------
test("2: unsupported_number still present after repair rejects", async () => {
  const v = scripted(val(["unsupported_number:11"]), val(["unsupported_number:11"]));
  const repair = repairReturning(REPAIRED);
  const r = await orchestrateFidelityRepair({ draft: DRAFT, readMinutes: 3, validate: v.fn, repair });
  assert.equal(r.decision, "reject");
  assert.equal(r.rejectionReason, "unsupported_number:11");
  assert.equal(repair.count(), 1);
});

// --- 3: invented quotation removed → proceed -------------------------------
test("3: invented_quotation is repaired and the draft proceeds", async () => {
  const v = scripted(val(["invented_quotation"]), val([]));
  const r = await orchestrateFidelityRepair({ draft: DRAFT, readMinutes: 3, validate: v.fn, repair: repairReturning(REPAIRED) });
  assert.equal(r.decision, "clean");
  assert.equal(r.audit.draft_source, "repaired");
});

// --- 4: unsupported claim removed/softened using only the source -----------
test("4: unsupported_claim is repaired and the draft proceeds", async () => {
  const v = scripted(val(["unsupported_claim:فعالية"]), val([]));
  const r = await orchestrateFidelityRepair({ draft: DRAFT, readMinutes: 3, validate: v.fn, repair: repairReturning(REPAIRED) });
  assert.equal(r.decision, "clean");
});

// --- 5: missing_official_action unresolved → pending + needs_human_review ---
test("5: unresolved missing_official_action becomes pending needs_human_review", async () => {
  const v = scripted(val(["missing_official_action"]), val(["missing_official_action"]));
  const repair = repairReturning(REPAIRED);
  const r = await orchestrateFidelityRepair({ draft: DRAFT, readMinutes: 3, validate: v.fn, repair });
  assert.equal(r.decision, "needs_human_review");
  assert.equal(r.rejectionReason, null);
  assert.equal(r.audit.needs_human_review, true);
  assert.deepEqual(r.audit.needs_human_review_reason, ["missing_official_action"]);
  assert.equal(repair.count(), 1); // omission is treated as a repair instruction first
});

test("5b: a restored missing_official_action ends clean", async () => {
  const v = scripted(val(["missing_official_action"]), val([]));
  const r = await orchestrateFidelityRepair({ draft: DRAFT, readMinutes: 3, validate: v.fn, repair: repairReturning(REPAIRED) });
  assert.equal(r.decision, "clean");
});

// --- 6-9: hard-blocking codes remain blocking (never repaired) --------------
for (const code of [
  "invented_official_action:سحب",
  "audience_misdirected_action:توقفوا",
  "association_as_causation",
  "missing_essential_entity:اسم",
]) {
  test(`6-9: ${code.split(":")[0]} remains blocking`, async () => {
    assert.equal(classifyFidelityError(code), "blocking");
    const repair = repairReturning(REPAIRED);
    const r = await orchestrateFidelityRepair({ draft: DRAFT, readMinutes: 3, validate: scripted(val([code])).fn, repair });
    assert.equal(r.decision, "reject");
    assert.equal(r.rejectionReason, code);
    assert.equal(r.audit.repair_attempted, false);
    assert.equal(repair.count(), 0); // no repair spent on a hard-blocking breach
  });
}

// --- 10: Editorial Director runs before the final fidelity rejection --------
test("10: the editor runs before any fidelity rejection", async () => {
  const log: string[] = [];
  const out = await finalizeWriterDraft<{ ran: true }>({
    runEditor: async () => {
      log.push("editor");
      return { article: DRAFT, readMinutes: 3, audit: { ran: true } };
    },
    validate: () => {
      log.push("fidelity-validate");
      return val(["invented_official_action:x"]);
    },
    repair: repairReturning(REPAIRED),
  });
  assert.equal(log[0], "editor");
  assert.ok(log.indexOf("editor") < log.indexOf("fidelity-validate"));
  assert.equal(out.fidelity.decision, "reject"); // rejection came AFTER the editor
  assert.deepEqual(out.editorial, { ran: true });
});

// --- 11: maximum one repair call across every eligible path -----------------
test("11: repair is called at most once (repairable path)", async () => {
  const repair = repairReturning(REPAIRED);
  await orchestrateFidelityRepair({
    draft: DRAFT,
    readMinutes: 3,
    validate: scripted(val(["unsupported_number:5", "unsupported_claim:موافقة"]), val(["unsupported_number:5"])).fn,
    repair,
  });
  assert.equal(repair.count(), 1);
});

test("11b: a failed repair transport is not retried (still one call)", async () => {
  let n = 0;
  const repair: FidelityRepairCall = async () => {
    n++;
    return { ok: false, reason: "editor_timeout" };
  };
  const r = await orchestrateFidelityRepair({
    draft: DRAFT,
    readMinutes: 3,
    validate: scripted(val(["unsupported_number:5"])).fn,
    repair,
  });
  assert.equal(n, 1);
  assert.equal(r.decision, "reject"); // repairable that could not be fixed
  assert.equal(r.audit.repair_failure_reason, "editor_timeout");
});

test("11c: a failed repair on an omission-only draft becomes needs_human_review", async () => {
  const repair: FidelityRepairCall = async () => ({ ok: false, reason: "editor_network_error" });
  const r = await orchestrateFidelityRepair({
    draft: DRAFT,
    readMinutes: 3,
    validate: scripted(val(["missing_unaffected_batch_statement"])).fn,
    repair,
  });
  assert.equal(r.decision, "needs_human_review");
  assert.equal(r.rejectionReason, null);
});

// --- 12: no article is ever auto-published ----------------------------------
test("12: every decision is pending-or-reject, never published", async () => {
  const scenarios: FidelityValidation[][] = [
    [val([])],
    [val(["unsupported_number:1"]), val([])],
    [val(["unsupported_number:1"]), val(["unsupported_number:1"])],
    [val(["missing_official_action"]), val(["missing_official_action"])],
    [val(["missing_essential_entity:x"])],
  ];
  const allowed = new Set(["clean", "needs_human_review", "reject"]);
  for (const results of scenarios) {
    const r = await orchestrateFidelityRepair({ draft: DRAFT, readMinutes: 3, validate: scripted(...results).fn, repair: repairReturning(REPAIRED) });
    assert.ok(allowed.has(r.decision), r.decision);
    assert.notEqual(r.decision as string, "published");
  }
});

// --- 13: fail-closed classification (no existing validator downgraded) ------
test("13: unknown fidelity codes fail closed to blocking", () => {
  assert.equal(classifyFidelityError("some_future_error"), "blocking");
  const a = assessFidelityErrors([
    "unsupported_number:3",
    "missing_official_action",
    "malformed_output:body",
    "brand_new_code",
  ]);
  assert.deepEqual(a.repairable, ["unsupported_number:3"]);
  assert.deepEqual(a.omission, ["missing_official_action"]);
  assert.deepEqual(a.blocking, ["malformed_output:body", "brand_new_code"]);
});
