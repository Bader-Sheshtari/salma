// E1.3C — writer-model routing tests (pure, NO live OpenRouter calls).
// Runs under Node's native TS type stripping (`node writerRouter.test.ts`) or
// `deno test`.

import test from "node:test";
import assert from "node:assert/strict";
import type { WritingProfile } from "./salmaWriter.ts";
import { selectProfile, parseWriterOutput } from "./salmaWriter.ts";
import {
  SENSITIVE_PROFILES,
  FORBIDDEN_WRITER_MODELS,
  isSensitiveProfile,
  isForbiddenWriterModel,
  assertWriterConfig,
  selectWriterModel,
  classifyTechnicalFailure,
  fallbackAllowed,
  resolveWriterModel,
  orchestrateWriter,
  evaluateWriterCompletion,
  type WriterHttpResult,
  type WriterModelConfig,
  type WriterValidation,
} from "./writerRouter.ts";

// Approved pilot config (matches the safe code defaults wired into index.ts).
const CONFIG: WriterModelConfig = {
  defaultModel: "openai/gpt-5.4-mini",
  sensitiveModel: "anthropic/claude-sonnet-5",
  fallbackModel: "openai/gpt-4o-mini",
};

const ALL_PROFILES: WritingProfile[] = [
  "quick_news",
  "standard_news",
  "regulation_or_service",
  "safety_alert",
  "research_study",
];

// --- profile -> model routing ----------------------------------------------

test("non-sensitive profiles route to the default (gpt-5.4-mini)", () => {
  for (const p of ["quick_news", "standard_news", "regulation_or_service"] as WritingProfile[]) {
    assert.equal(selectWriterModel(p, CONFIG), "openai/gpt-5.4-mini", p);
  }
});

test("sensitive profiles route to the sensitive model (claude-sonnet-5)", () => {
  for (const p of ["safety_alert", "research_study"] as WritingProfile[]) {
    assert.equal(selectWriterModel(p, CONFIG), "anthropic/claude-sonnet-5", p);
  }
});

test("exactly the safety and research profiles are sensitive", () => {
  assert.deepEqual([...SENSITIVE_PROFILES].sort(), ["research_study", "safety_alert"]);
  assert.ok(isSensitiveProfile("safety_alert"));
  assert.ok(isSensitiveProfile("research_study"));
  assert.ok(!isSensitiveProfile("quick_news"));
});

test("gemini is never selected as a primary model for any profile", () => {
  for (const p of ALL_PROFILES) {
    assert.notEqual(selectWriterModel(p, CONFIG), "google/gemini-3-flash-preview", p);
    assert.ok(!isForbiddenWriterModel(selectWriterModel(p, CONFIG)), p);
  }
});

test("gemini is on the forbidden list and rejected case-insensitively", () => {
  assert.ok(FORBIDDEN_WRITER_MODELS.includes("google/gemini-3-flash-preview"));
  assert.ok(isForbiddenWriterModel("google/gemini-3-flash-preview"));
  assert.ok(isForbiddenWriterModel("  GOOGLE/Gemini-3-Flash-Preview  "));
  assert.ok(!isForbiddenWriterModel("openai/gpt-5.4-mini"));
});

// --- E1.3C final review: ambiguous stories reach the sensitive model --------

test("(d) an ambiguous medicine warning is routed to the sensitive model (claude-sonnet-5)", () => {
  const arProfile = selectProfile({ sourceText: "قلق بشأن دواء شائع قد يكون له آثار غير متوقعة" });
  const enProfile = selectProfile({ sourceText: "Regulators raise concerns over a widely used medicine" });
  assert.equal(arProfile, "safety_alert");
  assert.equal(selectWriterModel(arProfile, CONFIG), "anthropic/claude-sonnet-5");
  assert.equal(selectWriterModel(enProfile, CONFIG), "anthropic/claude-sonnet-5");
});

test("(e) an ambiguous observational study is routed to the sensitive model (claude-sonnet-5)", () => {
  const arProfile = selectProfile({ sourceText: "دراسة رصدية تربط بين مشروب شائع وتغيّر في الوزن" });
  const enProfile = selectProfile({ sourceText: "Observational study links a common drink to lower risk" });
  assert.equal(arProfile, "research_study");
  assert.equal(selectWriterModel(arProfile, CONFIG), "anthropic/claude-sonnet-5");
  assert.equal(selectWriterModel(enProfile, CONFIG), "anthropic/claude-sonnet-5");
});

// --- config guard ----------------------------------------------------------

test("a valid config passes the boundary guard", () => {
  assert.doesNotThrow(() => assertWriterConfig(CONFIG));
});

test("a config that routes any role to gemini is rejected", () => {
  assert.throws(
    () => assertWriterConfig({ ...CONFIG, sensitiveModel: "google/gemini-3-flash-preview" }),
    /forbidden_model/,
  );
});

test("a config with an empty model is rejected", () => {
  assert.throws(() => assertWriterConfig({ ...CONFIG, fallbackModel: "" }), /missing_model/);
});

// --- technical-failure classification --------------------------------------

test("network, timeout, rate-limit and 5xx are technical failures", () => {
  assert.equal(classifyTechnicalFailure({ networkError: true }), "network_error");
  assert.equal(classifyTechnicalFailure({ timedOut: true }), "timeout");
  assert.equal(classifyTechnicalFailure({ httpStatus: 0 }), "network_error");
  assert.equal(classifyTechnicalFailure({ httpStatus: 429 }), "rate_limited");
  assert.equal(classifyTechnicalFailure({ httpStatus: 408 }), "timeout");
  assert.equal(classifyTechnicalFailure({ httpStatus: 500 }), "provider_unavailable");
  assert.equal(classifyTechnicalFailure({ httpStatus: 503 }), "provider_unavailable");
  assert.equal(classifyTechnicalFailure({ emptyOrMalformed: true }), "empty_or_malformed_response");
});

test("a 200 and client errors 400/401/403 are NOT technical failures", () => {
  assert.equal(classifyTechnicalFailure({ httpStatus: 200 }), null);
  assert.equal(classifyTechnicalFailure({ httpStatus: 400 }), null);
  assert.equal(classifyTechnicalFailure({ httpStatus: 401 }), null);
  assert.equal(classifyTechnicalFailure({ httpStatus: 403 }), null);
});

// --- fallback decision ------------------------------------------------------

test("fallback runs only on a technical failure", () => {
  assert.ok(fallbackAllowed({ kind: "technical_failure", reason: "timeout" }));
  assert.ok(!fallbackAllowed({ kind: "ok" }));
  assert.ok(!fallbackAllowed({ kind: "validation_failure", rejectionReason: "unsupported_number:5" }));
});

test("resolveWriterModel keeps the primary when the attempt is ok", () => {
  const r = resolveWriterModel("safety_alert", CONFIG, { kind: "ok" });
  assert.deepEqual(r, { model: "anthropic/claude-sonnet-5", usedFallback: false });
});

test("resolveWriterModel falls back to gpt-4o-mini on a technical failure", () => {
  const r = resolveWriterModel("quick_news", CONFIG, { kind: "technical_failure", reason: "rate_limited" });
  assert.deepEqual(r, { model: "openai/gpt-4o-mini", usedFallback: true });
});

test("a factual-validation failure rejects the draft, never falls back", () => {
  const r = resolveWriterModel("research_study", CONFIG, {
    kind: "validation_failure",
    rejectionReason: "association_as_causation",
  });
  assert.deepEqual(r, { model: null, usedFallback: false });
});

// --- end-to-end orchestration (injected call + validator) ------------------

const okValidate = (content: string): WriterValidation =>
  ({ ok: true, article: { title: "عنوان صحي واضح ومناسب للنشر", excerpt: "موجز", body: content }, readMinutes: 1 });

test("a clean primary write uses the profile's model, no fallback", async () => {
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "standard_news",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      return { ok: true, content: "نص عربي مكتوب" };
    },
    validate: okValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.modelUsed, "openai/gpt-5.4-mini");
  assert.equal(r.usedFallback, false);
  assert.deepEqual(calls, ["openai/gpt-5.4-mini"]); // exactly one call, the primary
});

test("a sensitive story writes with claude-sonnet-5", async () => {
  const r = await orchestrateWriter({
    profile: "safety_alert",
    config: CONFIG,
    call: async () => ({ ok: true, content: "تحذير سلامة" }),
    validate: okValidate,
  });
  assert.equal(r.modelUsed, "anthropic/claude-sonnet-5");
  assert.equal(r.usedFallback, false);
});

test("a technical failure on the primary falls back to gpt-4o-mini once", async () => {
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "quick_news",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      if (model === "openai/gpt-5.4-mini") return { ok: false, httpStatus: 503 };
      return { ok: true, content: "نص احتياطي" };
    },
    validate: okValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.usedFallback, true);
  assert.equal(r.modelUsed, "openai/gpt-4o-mini");
  assert.deepEqual(calls, ["openai/gpt-5.4-mini", "openai/gpt-4o-mini"]);
});

test("a factual-validation failure on the primary does NOT call the fallback", async () => {
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "research_study",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      return { ok: true, content: "المشروب يسبب المرض" };
    },
    validate: () => ({ ok: false, reason: "association_as_causation" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, false);
  assert.equal(r.rejection, "association_as_causation");
  assert.equal(r.validationReason, "association_as_causation");
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5"]); // primary only, no fallback
});

test("a non-technical hard error (HTTP 400) rejects without fallback", async () => {
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "quick_news",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      return { ok: false, httpStatus: 400 };
    },
    validate: okValidate,
  });
  assert.equal(r.ok, false);
  assert.equal(r.rejection, "writer_error");
  assert.equal(r.usedFallback, false);
  assert.deepEqual(calls, ["openai/gpt-5.4-mini"]);
});

test("both primary and fallback failing technically yields writer_unavailable", async () => {
  const r = await orchestrateWriter({
    profile: "standard_news",
    config: CONFIG,
    call: async () => ({ ok: false, timedOut: true }),
    validate: okValidate,
  });
  assert.equal(r.ok, false);
  assert.equal(r.rejection, "writer_unavailable");
  assert.equal(r.usedFallback, true);
  assert.equal(r.modelUsed, "openai/gpt-4o-mini");
});

test("the fallback's output is still validated (bad fallback is rejected)", async () => {
  const r = await orchestrateWriter({
    profile: "quick_news",
    config: CONFIG,
    call: async (model) =>
      model === "openai/gpt-5.4-mini" ? { ok: false, httpStatus: 500 } : { ok: true, content: "نص" },
    validate: () => ({ ok: false, reason: "unsupported_number:9999" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, true);
  assert.equal(r.rejection, "unsupported_number:9999");
  assert.equal(r.validationReason, "unsupported_number:9999");
});

// --- strict parse failure through the real parser (structured-output hardening)
//
// Wires the REAL parseWriterOutput as the validator, exactly as index.ts does,
// to prove a malformed structured response is treated as a validation failure:
// a single primary call, NO cheaper-model fallback, NO retry, ok=false (so
// index.ts creates no content row), and the specific safe parse reason.
const parseValidate = (content: string): WriterValidation => {
  const parsed = parseWriterOutput(content);
  if (!parsed.ok) return { ok: false, reason: parsed.error };
  return { ok: true, article: parsed.article, readMinutes: 1 };
};

test("a malformed (truncated) writer response: one call, no fallback, no insert", async () => {
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "safety_alert",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      // The exact class of failure we hardened for: an unterminated object.
      return { ok: true, content: '{"title":"عنوان","excerpt":"","body":"نص لم يكتمل' };
    },
    validate: parseValidate,
  });
  assert.equal(r.ok, false); // ok=false → index.ts inserts NO content row
  assert.equal(r.usedFallback, false); // parse failure never triggers fallback
  assert.equal(r.rejection, "writer_output_truncated"); // specific safe reason
  assert.equal(r.validationReason, "writer_output_truncated");
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5"]); // primary only, no retry
});

test("a valid strict-JSON response passes orchestration on the sensitive model", async () => {
  const good = JSON.stringify({
    title: "تحذير سلامة واضح للجمهور حول منتج",
    excerpt: "موجز",
    body: "نص عربي كافٍ لهذا الاختبار.",
  });
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "safety_alert",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      return { ok: true, content: good };
    },
    validate: parseValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.usedFallback, false);
  assert.equal(r.modelUsed, "anthropic/claude-sonnet-5");
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5"]);
  // A clean first write records exactly one attempt and no second-attempt type.
  assert.equal(r.writerAttempts, 1);
  assert.equal(r.secondAttemptType, "none");
});

// --- writer JSON-recovery (one strict-JSON reparse retry) -------------------
//
// Mirrors the editor's single formatting recovery. It fires ONLY when the first
// response fails JSON parsing with writer_output_invalid_json, reuses the SAME
// primary model (never Gemini/fallback), and validates the recovered output the
// SAME way. A still-invalid or failed recovery rejects safely as before.
const recoveredJson = JSON.stringify({
  title: "تحذير سلامة واضح للجمهور حول منتج",
  excerpt: "موجز",
  body: "نص عربي كافٍ لهذا الاختبار.",
});

test("invalid-JSON first response → strict-JSON recovery on the SAME model succeeds", async () => {
  const calls: string[] = [];
  const flags: (boolean | undefined)[] = [];
  const r = await orchestrateWriter({
    profile: "safety_alert",
    config: CONFIG,
    call: async (model, opts) => {
      calls.push(model);
      flags.push(opts?.strictJsonRecovery);
      // First call: bare braces that are not valid JSON → writer_output_invalid_json.
      // Second (recovery) call: valid strict JSON.
      return { ok: true, content: opts?.strictJsonRecovery ? recoveredJson : "{ليس JSON صالحًا}" };
    },
    validate: parseValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.usedFallback, false); // recovery is NOT the fallback model
  assert.equal(r.writerAttempts, 2);
  assert.equal(r.secondAttemptType, "json_recovery");
  // Both calls hit the SAME primary (sensitive) model; the 2nd carried the flag.
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5"]);
  assert.deepEqual(flags, [undefined, true]);
});

test("invalid-JSON that stays invalid after recovery rejects safely (no fallback)", async () => {
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "quick_news",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      return { ok: true, content: "{ليس JSON صالحًا}" }; // invalid on both calls
    },
    validate: parseValidate,
  });
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, false);
  assert.equal(r.rejection, "writer_output_invalid_json"); // same safe reason as before
  assert.equal(r.validationReason, "writer_output_invalid_json");
  assert.equal(r.writerAttempts, 2);
  assert.equal(r.secondAttemptType, "json_recovery");
  assert.deepEqual(calls, ["openai/gpt-5.4-mini", "openai/gpt-5.4-mini"]); // primary twice, no fallback
});

test("a recovery call that itself fails transport rejects safely with the original reason", async () => {
  let n = 0;
  const r = await orchestrateWriter({
    profile: "standard_news",
    config: CONFIG,
    call: async () => {
      n += 1;
      return n === 1 ? { ok: true, content: "{ليس JSON صالحًا}" } : { ok: false, timedOut: true };
    },
    validate: parseValidate,
  });
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, false); // the recovery is not a fallback attempt
  assert.equal(r.rejection, "writer_output_invalid_json");
  assert.equal(r.writerAttempts, 2);
  assert.equal(r.secondAttemptType, "json_recovery");
  assert.equal(n, 2); // primary + one recovery, then stop
});

test("a NON-invalid-json parse failure (truncated) does NOT trigger recovery", async () => {
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "safety_alert",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      return { ok: true, content: '{"title":"عنوان","excerpt":"","body":"نص لم يكتمل' };
    },
    validate: parseValidate,
  });
  assert.equal(r.ok, false);
  assert.equal(r.rejection, "writer_output_truncated");
  assert.equal(r.writerAttempts, 1); // no recovery: only invalid_json qualifies
  assert.equal(r.secondAttemptType, "none");
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5"]);
});

test("recovery never fires on the FALLBACK path (technical primary, invalid-json fallback)", async () => {
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "quick_news",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      // Primary technical-fails → fallback runs and returns invalid JSON.
      return model === "openai/gpt-5.4-mini"
        ? { ok: false, httpStatus: 503 }
        : { ok: true, content: "{ليس JSON صالحًا}" };
    },
    validate: parseValidate,
  });
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, true);
  assert.equal(r.rejection, "writer_output_invalid_json");
  assert.equal(r.writerAttempts, 2);
  assert.equal(r.secondAttemptType, "none"); // fallback's invalid json is NOT recovered
  assert.deepEqual(calls, ["openai/gpt-5.4-mini", "openai/gpt-4o-mini"]);
});

// --- OpenRouter completion metadata (finish_reason + content shape) ---------
//
// evaluateWriterCompletion inspects the raw choice BEFORE any parsing. A "stop"
// (or absent) reason with a non-empty string may proceed; a "length" truncation,
// a filtered / tool_calls / error / other unexpected non-null reason, or a
// non-string content shape is a completed-but-invalid response (reject, no
// fallback); an empty string stays a technical (fallback-eligible) failure.

const goodJson = JSON.stringify({ title: "عنوان صحي واضح", excerpt: "موجز", body: "نص كافٍ." });

test("finish_reason='stop' with valid JSON content proceeds (ok)", () => {
  const r = evaluateWriterCompletion({ finish_reason: "stop", message: { content: goodJson } });
  assert.deepEqual(r, { ok: true, content: goodJson });
});

test("an absent/null finish_reason with a valid string still proceeds", () => {
  assert.deepEqual(evaluateWriterCompletion({ message: { content: goodJson } }), { ok: true, content: goodJson });
  assert.deepEqual(evaluateWriterCompletion({ finish_reason: null, message: { content: goodJson } }), { ok: true, content: goodJson });
});

test("finish_reason='length' rejects as writer_output_truncated (before parsing)", () => {
  // Even with parseable-looking content present, a truncation signal wins first.
  const r = evaluateWriterCompletion({ finish_reason: "length", message: { content: goodJson } });
  assert.deepEqual(r, { ok: false, kind: "completed_invalid", reason: "writer_output_truncated" });
});

test("unexpected finish reasons each reject with a specific safe reason", () => {
  const map: Record<string, string> = {
    content_filter: "writer_output_content_filtered",
    tool_calls: "writer_output_tool_calls",
    error: "writer_output_provider_error",
    something_new: "writer_output_unexpected_finish",
    STOP_BUT_WEIRD: "writer_output_unexpected_finish",
  };
  for (const [fr, reason] of Object.entries(map)) {
    const r = evaluateWriterCompletion({ finish_reason: fr, message: { content: goodJson } });
    assert.deepEqual(r, { ok: false, kind: "completed_invalid", reason }, fr);
  }
});

test("finish_reason is matched case-insensitively and trimmed", () => {
  assert.deepEqual(evaluateWriterCompletion({ finish_reason: "  Length  ", message: { content: goodJson } }), {
    ok: false, kind: "completed_invalid", reason: "writer_output_truncated",
  });
  assert.deepEqual(evaluateWriterCompletion({ finish_reason: "  STOP ", message: { content: goodJson } }), {
    ok: true, content: goodJson,
  });
});

test("null/missing/array/object/non-string content rejects as writer_output_content_invalid", () => {
  const bad: unknown[] = [
    { finish_reason: "stop", message: { content: null } },
    { finish_reason: "stop", message: {} }, // missing content
    { finish_reason: "stop", message: { content: ["a", "b"] } }, // array
    { finish_reason: "stop", message: { content: { text: "x" } } }, // object (structured)
    { finish_reason: "stop", message: { content: 123 } }, // number
    { finish_reason: "stop", message: null }, // missing message
    { finish_reason: "stop" }, // missing message entirely
    null, // missing choice entirely
    undefined,
  ];
  for (const choice of bad) {
    assert.deepEqual(
      evaluateWriterCompletion(choice as never),
      { ok: false, kind: "completed_invalid", reason: "writer_output_content_invalid" },
      JSON.stringify(choice ?? null),
    );
  }
});

test("an empty/whitespace string stays a technical (fallback-eligible) 'empty' result", () => {
  assert.deepEqual(evaluateWriterCompletion({ finish_reason: "stop", message: { content: "" } }), { ok: false, kind: "empty" });
  assert.deepEqual(evaluateWriterCompletion({ finish_reason: "stop", message: { content: "   \n " } }), { ok: false, kind: "empty" });
});

// Mirror chatWriter's exact mapping from a raw OpenRouter choice to a
// WriterHttpResult, so orchestration tests reflect index.ts wiring precisely.
const choiceCall = (choice: unknown): WriterHttpResult => {
  const evald = evaluateWriterCompletion(choice as never);
  if (evald.ok) return { ok: true, content: evald.content };
  if (evald.kind === "completed_invalid") return { ok: false, completedInvalid: true, reason: evald.reason };
  return { ok: false, httpStatus: 200, emptyOrMalformed: true };
};

test("a truncated (length) completion: one call, no fallback, no retry, no insert", async () => {
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "safety_alert",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      return choiceCall({ finish_reason: "length", message: { content: goodJson } });
    },
    validate: parseValidate,
  });
  assert.equal(r.ok, false); // ok=false → index.ts inserts NO content row
  assert.equal(r.usedFallback, false); // completed-but-invalid never falls back
  assert.equal(r.rejection, "writer_output_truncated");
  assert.equal(r.validationReason, "writer_output_truncated");
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5"]); // primary only, no retry
});

test("a non-string content shape: rejects writer_output_content_invalid, no fallback", async () => {
  let parserRuns = 0;
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "safety_alert",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      return choiceCall({ finish_reason: "stop", message: { content: { text: "structured" } } });
    },
    validate: (content) => {
      parserRuns++; // must never run — the completion was rejected before parsing
      return parseValidate(content);
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, false);
  assert.equal(r.rejection, "writer_output_content_invalid");
  assert.equal(r.validationReason, "writer_output_content_invalid");
  assert.equal(parserRuns, 0); // no parser runs after a completed-invalid signal
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5"]);
});

test("a completed-invalid response does NOT reach the parser even after a technical fallback", async () => {
  // Primary fails technically (503) → one fallback; the fallback then returns a
  // truncated completion. It must reject with the truncation reason and NOT
  // retry again or run the parser on the incomplete output.
  let parserRuns = 0;
  const calls: string[] = [];
  const r = await orchestrateWriter({
    profile: "quick_news",
    config: CONFIG,
    call: async (model) => {
      calls.push(model);
      if (model === "openai/gpt-5.4-mini") return { ok: false, httpStatus: 503 };
      return choiceCall({ finish_reason: "length", message: { content: goodJson } });
    },
    validate: (content) => {
      parserRuns++;
      return parseValidate(content);
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, true);
  assert.equal(r.modelUsed, "openai/gpt-4o-mini");
  assert.equal(r.rejection, "writer_output_truncated");
  assert.equal(r.validationReason, "writer_output_truncated");
  assert.equal(parserRuns, 0);
  assert.deepEqual(calls, ["openai/gpt-5.4-mini", "openai/gpt-4o-mini"]); // no third call
});

test("gemini stays forbidden regardless of completion-metadata handling", () => {
  // The new completion path never introduces a model choice; the forbidden guard
  // still holds across every role.
  assert.throws(() => assertWriterConfig({ ...CONFIG, defaultModel: "google/gemini-3-flash-preview" }), /forbidden_model/);
  for (const p of ALL_PROFILES) assert.ok(!isForbiddenWriterModel(selectWriterModel(p, CONFIG)));
});
