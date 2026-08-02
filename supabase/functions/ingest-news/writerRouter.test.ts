// E1.3C — writer-model routing tests (pure, NO live OpenRouter calls).
// Runs under Node's native TS type stripping (`node writerRouter.test.ts`) or
// `deno test`.

import test from "node:test";
import assert from "node:assert/strict";
import type { WritingProfile } from "./salmaWriter.ts";
import { selectProfile } from "./salmaWriter.ts";
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
