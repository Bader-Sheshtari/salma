// Evidence Intelligence V1 — pure-core tests (no network, no Deno APIs).
// Runs under Node's native TS type stripping:
//   node --test --experimental-strip-types evidenceIntelligence.test.ts
// or `deno test`.

import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeEvidence,
  associationGuardApplies,
  buildEvidenceMessages,
  type EvidenceCard,
  type EvidenceDeps,
  type EvidenceInput,
  EVIDENCE_MAX_SOURCE_CHARS,
  evidenceWriterGuidance,
  parseEvidenceOutput,
  renderEvidenceGuidanceBlock,
} from "./evidenceIntelligence.ts";
import { causationAsserted } from "./salmaWriter.ts";

// ---- fixtures --------------------------------------------------------------

/** A fully-valid model response for a randomized controlled trial. */
function rctResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source_sufficiency: "sufficient",
    applicability: "applicable",
    evidence_type: "randomized_controlled_trial",
    peer_review_status: "peer_reviewed",
    subject_type: "human_clinical",
    population: "بالغون مصابون بالسكري من النوع الثاني",
    sample_size: 1240,
    intervention: "إنسولين أسبوعي (icodec)",
    comparator: "إنسولين يومي (glargine)",
    main_outcome: "خفض HbA1c خلال 26 أسبوعًا",
    claim_relationship: "causal_supported",
    evidence_strength: "high",
    strength_reasons: ["تجربة معشاة منضبطة (RCT)", "عينة كافية", "مراجعة أقران"],
    limitations: ["متابعة قصيرة نسبيًا"],
    editorial_caution: "النتائج على مدى 26 أسبوعًا؛ الأمان طويل الأمد غير معروف بعد.",
    trial: { phase: "3", randomized: "yes", controlled: "yes", blinded: "unknown" },
    review: null,
    source_independence: "independent",
    guidance_issuer: null,
    regulatory_action: null,
    confidence: "high",
    ...overrides,
  });
}

function cardOf(raw: string): EvidenceCard {
  const p = parseEvidenceOutput(raw);
  assert.equal(p.ok, true, `expected parse ok, got ${JSON.stringify(p)}`);
  return (p as { ok: true; card: EvidenceCard }).card;
}

const BASE_INPUT: EvidenceInput = {
  clusterKey: "er-123",
  storyType: "scientific_study",
  sourceUrl: "https://www.nature.com/articles/x",
  sourceDomain: "nature.com",
  sourceTitle: "Some study",
  sourceText: "A ".repeat(600), // > EVIDENCE_MIN_SOURCE_CHARS
};

function depsWith(overrides: Partial<EvidenceDeps> = {}): EvidenceDeps & { calls: { chat: number; put: unknown[] } } {
  const calls = { chat: 0, put: [] as unknown[] };
  const deps: EvidenceDeps = {
    cacheGet: async () => null,
    cachePut: async (o) => { calls.put.push(o); },
    chat: async () => { calls.chat++; return { ok: true, content: rctResponse() }; },
    ...overrides,
  };
  return { ...deps, calls };
}

// ---- parse/validation ------------------------------------------------------

test("RCT response parses into the correct study class", () => {
  const card = cardOf(rctResponse());
  assert.equal(card.evidence_type, "randomized_controlled_trial");
  assert.equal(card.peer_review_status, "peer_reviewed");
  assert.equal(card.subject_type, "human_clinical");
  assert.equal(card.sample_size, 1240);
  assert.equal(card.trial?.phase, "3");
  assert.equal(card.trial?.randomized, "yes");
  assert.equal(card.evidence_strength, "high");
  assert.ok(card.strength_reasons.length >= 1);
});

test("observational study stays association_only", () => {
  const card = cardOf(rctResponse({
    evidence_type: "cohort",
    claim_relationship: "association_only",
    evidence_strength: "limited",
    trial: null,
  }));
  assert.equal(card.evidence_type, "cohort");
  assert.equal(card.claim_relationship, "association_only");
  assert.equal(associationGuardApplies(card), true);
});

test("meta-analysis is recognized with its review block", () => {
  const card = cardOf(rctResponse({
    evidence_type: "systematic_review_meta_analysis",
    trial: null,
    review: { included_studies: 24, participants: 85000, consistency: "mixed" },
  }));
  assert.equal(card.evidence_type, "systematic_review_meta_analysis");
  assert.equal(card.review?.included_studies, 24);
  assert.equal(card.review?.participants, 85000);
  assert.equal(card.review?.consistency, "mixed");
});

test("missing/vague sample size becomes null, never guessed", () => {
  for (const v of [null, undefined, "several hundred", "n/a", -5, 0, 2.7, "12abc"]) {
    const card = cardOf(rctResponse({ sample_size: v }));
    assert.equal(card.sample_size, null, `sample_size ${String(v)} must coerce to null`);
  }
  // A clean numeric string IS clearly supported.
  assert.equal(cardOf(rctResponse({ sample_size: "473" })).sample_size, 473);
});

test("unknown enum values normalize to unknown/defaults, never pass through", () => {
  const card = cardOf(rctResponse({
    peer_review_status: "totally_new_status",
    subject_type: "alien",
    evidence_strength: "amazing",
    source_independence: "sponsored?",
    confidence: "extreme",
  }));
  assert.equal(card.peer_review_status, "unknown");
  assert.equal(card.subject_type, "unknown");
  assert.equal(card.evidence_strength, "unclear");
  assert.equal(card.source_independence, "unknown");
  assert.equal(card.confidence, "low");
});

test("core enums are load-bearing: invalid values reject the whole output", () => {
  for (const overrides of [
    { applicability: "sort_of" },
    { evidence_type: "vibes" },
    { claim_relationship: "definitely_causal" },
  ]) {
    const p = parseEvidenceOutput(rctResponse(overrides));
    assert.equal(p.ok, false);
  }
});

test("malformed model output is safely rejected", () => {
  for (const raw of ["", "not json at all", "[1,2,3]", "{\"broken\": ", "null"]) {
    const p = parseEvidenceOutput(raw);
    assert.equal(p.ok, false);
  }
});

test("limitations and strength_reasons are clamped", () => {
  const card = cardOf(rctResponse({
    limitations: ["a", "b", "c", "d", "e"],
    strength_reasons: ["1", "2", "3", "4", "5", "6", "7"],
  }));
  assert.equal(card.limitations.length, 3);
  assert.equal(card.strength_reasons.length, 5);
});

test("fenced JSON output still parses", () => {
  const p = parseEvidenceOutput("```json\n" + rctResponse() + "\n```");
  assert.equal(p.ok, true);
});

// ---- writer guidance -------------------------------------------------------

test("association_only produces the causal-language ban", () => {
  const card = cardOf(rctResponse({ evidence_type: "cohort", claim_relationship: "association_only", trial: null }));
  const g = evidenceWriterGuidance(card).join("\n");
  assert.ok(g.includes("ارتباطًا فقط"));
  assert.ok(g.includes("يسبب"));
});

test("preprint is flagged in guidance", () => {
  const card = cardOf(rctResponse({ peer_review_status: "preprint" }));
  const g = evidenceWriterGuidance(card).join("\n");
  assert.ok(g.includes("Preprint"));
  assert.ok(g.includes("مراجعة الأقران"));
});

test("animal study yields the preclinical no-human-benefit directive", () => {
  const card = cardOf(rctResponse({
    evidence_type: "preclinical_animal",
    subject_type: "animal",
    claim_relationship: "mechanistic_preclinical",
    trial: null,
  }));
  const g = evidenceWriterGuidance(card).join("\n");
  assert.ok(g.includes("لم تثبت في البشر"));
});

test("company-only claim yields the attribution directive", () => {
  const card = cardOf(rctResponse({ source_independence: "company_only" }));
  const g = evidenceWriterGuidance(card).join("\n");
  assert.ok(g.includes("الشركة"));
  assert.ok(g.includes("انسب"));
});

test("regulatory fact is separated from clinical efficacy in guidance", () => {
  const card = cardOf(rctResponse({
    evidence_type: "regulatory_evidence",
    claim_relationship: "regulatory_fact",
    regulatory_action: "سحب المنتج (FDA recall)",
    trial: null,
  }));
  const g = evidenceWriterGuidance(card).join("\n");
  assert.ok(g.includes("القرار التنظيمي"));
  assert.ok(g.includes("فعالية"));
});

test("guidance/explainer is recognized as guidance with an issuer, not a trial", () => {
  const card = cardOf(rctResponse({
    evidence_type: "expert_guidance",
    peer_review_status: "institutional_guidance",
    claim_relationship: "recommendation_guidance",
    guidance_issuer: "Mayo Clinic",
    trial: null,
    sample_size: null,
  }));
  assert.equal(card.evidence_type, "expert_guidance");
  assert.equal(card.guidance_issuer, "Mayo Clinic");
  const g = evidenceWriterGuidance(card).join("\n");
  assert.ok(g.includes("إرشادات مؤسسية"));
});

test("no card / not_applicable card → no guidance block", () => {
  assert.equal(renderEvidenceGuidanceBlock(null), "");
  assert.equal(renderEvidenceGuidanceBlock(undefined), "");
  const na = cardOf(rctResponse({ applicability: "not_applicable" }));
  assert.equal(renderEvidenceGuidanceBlock(na), "");
});

test("guidance block renders as the labeled constraint list", () => {
  const card = cardOf(rctResponse({ evidence_type: "cohort", claim_relationship: "association_only", trial: null }));
  const block = renderEvidenceGuidanceBlock(card);
  assert.ok(block.startsWith("قيود صياغة إلزامية"));
  assert.ok(block.includes("- "));
});

// ---- association→causation guard (with the real writer detector) -----------

test("guard applies only for association_only cards", () => {
  assert.equal(associationGuardApplies(null), false);
  assert.equal(associationGuardApplies(cardOf(rctResponse())), false);
  const assoc = cardOf(rctResponse({ claim_relationship: "association_only" }));
  assert.equal(associationGuardApplies(assoc), true);
});

test("writer cannot turn association into causation: detector fires on causal draft", () => {
  // The draft asserts causation; an association-only card must make this a breach.
  const causalDraft = "أظهرت الدراسة أن شرب القهوة يؤدي إلى انخفاض خطر الخرف لدى كبار السن.";
  const associativeDraft = "ارتبط شرب القهوة بانخفاض خطر الخرف، ولا يمكن الجزم بأن أحدهما يسبب الآخر.";
  const observationalSource = "The prospective cohort study found coffee consumption was associated with lower dementia risk.";
  assert.equal(causationAsserted(causalDraft), true);
  assert.equal(causationAsserted(associativeDraft), false); // negated causal wording passes
  assert.equal(causationAsserted(observationalSource), false);
});

// ---- orchestrator ----------------------------------------------------------

test("cache prevents repeat analysis (no LLM call on hit)", async () => {
  const cachedCard = cardOf(rctResponse());
  const deps = depsWith({
    cacheGet: async () => ({ status: "complete", card: cachedCard }),
  });
  const out = await analyzeEvidence(BASE_INPUT, deps);
  assert.equal(out.cached, true);
  assert.equal(out.status, "complete");
  assert.equal(out.card?.evidence_type, "randomized_controlled_trial");
  assert.equal(deps.calls.chat, 0);
  assert.equal(deps.calls.put.length, 0);
});

test("corporate_business is skipped deterministically as not_applicable", async () => {
  const deps = depsWith();
  const out = await analyzeEvidence({ ...BASE_INPUT, storyType: "corporate_business" }, deps);
  assert.equal(out.status, "not_applicable");
  assert.equal(out.card, null);
  assert.equal(deps.calls.chat, 0);
  assert.equal(deps.calls.put.length, 1); // gate outcome IS persisted (cached)
});

test("too-short source text → insufficient_source without an LLM call", async () => {
  const deps = depsWith();
  const out = await analyzeEvidence({ ...BASE_INPUT, sourceText: "short" }, deps);
  assert.equal(out.status, "insufficient_source");
  assert.equal(deps.calls.chat, 0);
});

test("successful analysis persists and returns the complete card", async () => {
  const deps = depsWith();
  const out = await analyzeEvidence(BASE_INPUT, deps);
  assert.equal(out.status, "complete");
  assert.equal(out.cached, false);
  assert.equal(out.card?.evidence_type, "randomized_controlled_trial");
  assert.equal(deps.calls.chat, 1);
  assert.equal(deps.calls.put.length, 1);
});

test("malformed LLM output → analysis_failed, no fabricated card", async () => {
  const deps = depsWith({ chat: async () => ({ ok: true, content: "sorry, here is prose" }) });
  const out = await analyzeEvidence(BASE_INPUT, deps);
  assert.equal(out.status, "analysis_failed");
  assert.equal(out.card, null);
  const put = deps.calls.put[0] as { status: string; card: unknown };
  assert.equal(put.status, "analysis_failed");
  assert.equal(put.card, null);
});

test("LLM transport failure → analysis_failed with the reason", async () => {
  const deps = depsWith({ chat: async () => ({ ok: false, reason: "evidence_http_500" }) });
  const out = await analyzeEvidence(BASE_INPUT, deps);
  assert.equal(out.status, "analysis_failed");
  assert.equal(out.reason, "evidence_http_500");
});

test("model-reported insufficient source → insufficient_source, no card kept", async () => {
  const deps = depsWith({ chat: async () => ({ ok: true, content: rctResponse({ source_sufficiency: "insufficient" }) }) });
  const out = await analyzeEvidence(BASE_INPUT, deps);
  assert.equal(out.status, "insufficient_source");
  assert.equal(out.card, null);
});

test("model not_applicable verdict → not_applicable status with the card retained", async () => {
  const deps = depsWith({ chat: async () => ({ ok: true, content: rctResponse({ applicability: "not_applicable" }) }) });
  const out = await analyzeEvidence(BASE_INPUT, deps);
  assert.equal(out.status, "not_applicable");
  assert.equal(out.card?.applicability, "not_applicable");
});

test("a throwing dependency never escapes: analysis_failed outcome", async () => {
  const deps = depsWith({ chat: async () => { throw new Error("boom"); } });
  const out = await analyzeEvidence(BASE_INPUT, deps);
  assert.equal(out.status, "analysis_failed");
});

test("cachePut failures are swallowed (audit is best-effort)", async () => {
  const deps = depsWith({ cachePut: async () => { throw new Error("db down"); } });
  const out = await analyzeEvidence(BASE_INPUT, deps);
  assert.equal(out.status, "complete");
  assert.equal(out.card?.evidence_type, "randomized_controlled_trial");
});

test("source text is capped in the extraction messages", () => {
  const long = "x".repeat(EVIDENCE_MAX_SOURCE_CHARS + 5000);
  const messages = buildEvidenceMessages({ ...BASE_INPUT, sourceText: long });
  const user = messages[1].content;
  assert.ok(user.length < EVIDENCE_MAX_SOURCE_CHARS + 1000);
});
