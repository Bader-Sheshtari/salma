// Evidence Intelligence V1 — PURE core + injectable orchestrator.
//
// After the ESL selects a cluster and Primary Source Escalation picks the
// strongest editorial source, this stage answers ONE bounded question about the
// story's evidence: what kind of evidence is this, how strong is it, and what
// can/can't be concluded from it. The result is a compact structured Evidence
// Card used to (a) ground the Writer with conservative wording constraints,
// (b) strengthen the deterministic association→causation safeguard, and
// (c) show the human reviewer a read-only card in the admin editor.
//
// Boundaries (deliberate):
//   - runs ONLY for stories already selected for promotion (≤ daily cap ≈ 8);
//   - ONE structured LLM extraction over the ALREADY-FETCHED verified source
//     text (no web searches, no research agent — Primary Source Escalation owns
//     source discovery; this stage owns source INTERPRETATION);
//   - cached per canonical cluster so the same development is analyzed once;
//   - NEVER invents details: unsupported fields come back null/unknown, and a
//     failed/malformed analysis is stored as analysis_failed — the story stays
//     safe and human review proceeds with the existing safeguards;
//   - it never blocks promotion and never publishes anything.

// ---- Evidence Card types ---------------------------------------------------

export type EvidenceApplicability = "applicable" | "partial" | "not_applicable";

export type EvidenceType =
  | "systematic_review_meta_analysis"
  | "randomized_controlled_trial"
  | "controlled_trial"
  | "cohort"
  | "case_control"
  | "cross_sectional"
  | "observational_other"
  | "case_series"
  | "preclinical_animal"
  | "laboratory_in_vitro"
  | "modeling"
  | "expert_guidance"
  | "regulatory_evidence"
  | "unknown";

export type PeerReviewStatus =
  | "peer_reviewed"
  | "preprint"
  | "conference_only"
  | "institutional_guidance"
  | "regulatory"
  | "unknown";

export type SubjectType =
  | "human_clinical"
  | "animal"
  | "in_vitro"
  | "computational_modeling"
  | "mixed"
  | "not_applicable"
  | "unknown";

export type ClaimRelationship =
  | "causal_supported"
  | "association_only"
  | "descriptive"
  | "mechanistic_preclinical"
  | "recommendation_guidance"
  | "regulatory_fact"
  | "unknown";

export type EvidenceStrength = "high" | "moderate" | "limited" | "very_limited" | "unclear";

export type SourceIndependence = "independent" | "company_only" | "mixed" | "unknown";

export type TriState = "yes" | "no" | "unknown";

export type EvidenceTrial = {
  phase: string | null;          // e.g. "2" | "3" | "2b" — only when clearly stated
  randomized: TriState;
  controlled: TriState;
  blinded: TriState;
};

export type EvidenceReview = {
  included_studies: number | null;
  participants: number | null;
  consistency: "consistent" | "mixed" | "unknown";
};

export type EvidenceCard = {
  applicability: EvidenceApplicability;
  evidence_type: EvidenceType;
  peer_review_status: PeerReviewStatus;
  subject_type: SubjectType;
  population: string | null;      // compact, only when supported by the source
  sample_size: number | null;     // numeric ONLY when clearly supported; never guessed
  intervention: string | null;    // intervention / exposure, compact
  comparator: string | null;
  main_outcome: string | null;
  claim_relationship: ClaimRelationship;
  evidence_strength: EvidenceStrength;
  strength_reasons: string[];     // compact structured basis (≤5) — never a bare grade
  limitations: string[];          // ≤3 concise items
  editorial_caution: string | null; // ONE concise Arabic sentence, when needed
  trial: EvidenceTrial | null;    // only for clinical trials
  review: EvidenceReview | null;  // only for systematic reviews / meta-analyses
  source_independence: SourceIndependence; // company-only claim vs independent evidence
  guidance_issuer: string | null; // issuing institution for guidance/explainers
  regulatory_action: string | null; // the regulatory FACT (authoritative), kept separate
  confidence: "high" | "medium" | "low"; // extraction confidence, not evidence strength
};

export type EvidenceStatus = "complete" | "not_applicable" | "insufficient_source" | "analysis_failed";

export type EvidenceOutcome = {
  status: EvidenceStatus;
  card: EvidenceCard | null; // present only for complete / not_applicable(with card)
  cached: boolean;
  reason: string | null;     // compact gate/failure reason for the audit row
};

// Bumped when the analysis prompt/schema changes; part of the cache identity.
export const EVIDENCE_PROMPT_VERSION = "ev1";

// The verified source text is already capped at 40k chars by fetchSourceText;
// evidence extraction needs the substance, not the tail boilerplate.
export const EVIDENCE_MAX_SOURCE_CHARS = 16_000;

// A source below this size cannot support a real evidence analysis; return
// insufficient_source WITHOUT an LLM call rather than let a model extrapolate.
export const EVIDENCE_MIN_SOURCE_CHARS = 500;

// Story types where evidence analysis is never materially relevant — skipped
// deterministically (no LLM call, no card). Everything else is analyzed and the
// model itself may still return not_applicable.
export const EVIDENCE_SKIP_STORY_TYPES = new Set(["corporate_business"]);

// ---- enum whitelists (server-side validation) ------------------------------

const APPLICABILITY = new Set<string>(["applicable", "partial", "not_applicable"]);
const EVIDENCE_TYPES = new Set<string>([
  "systematic_review_meta_analysis", "randomized_controlled_trial", "controlled_trial",
  "cohort", "case_control", "cross_sectional", "observational_other", "case_series",
  "preclinical_animal", "laboratory_in_vitro", "modeling", "expert_guidance",
  "regulatory_evidence", "unknown",
]);
const PEER_REVIEW = new Set<string>([
  "peer_reviewed", "preprint", "conference_only", "institutional_guidance", "regulatory", "unknown",
]);
const SUBJECTS = new Set<string>([
  "human_clinical", "animal", "in_vitro", "computational_modeling", "mixed", "not_applicable", "unknown",
]);
const CLAIMS = new Set<string>([
  "causal_supported", "association_only", "descriptive", "mechanistic_preclinical",
  "recommendation_guidance", "regulatory_fact", "unknown",
]);
const STRENGTHS = new Set<string>(["high", "moderate", "limited", "very_limited", "unclear"]);
const INDEPENDENCE = new Set<string>(["independent", "company_only", "mixed", "unknown"]);
const TRISTATE = new Set<string>(["yes", "no", "unknown"]);
const CONSISTENCY = new Set<string>(["consistent", "mixed", "unknown"]);
const CONFIDENCE = new Set<string>(["high", "medium", "low"]);

// ---- validation helpers ----------------------------------------------------

function pickEnum<T extends string>(v: unknown, allowed: Set<string>, dflt: T): T {
  const s = String(v ?? "").trim();
  return (allowed.has(s) ? s : dflt) as T;
}

/** Compact free-text field: trimmed and clamped, else null. Never invented. */
function shortText(v: unknown, max = 220): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** Strictly-supported positive integer, else null (a vague count is NOT a number). */
function supportedInt(v: unknown, max = 100_000_000): number | null {
  const n = typeof v === "number" ? v : (typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  // Only a clean integer count is "clearly supported" — a fractional value is
  // not a participant count and must not be silently floored into one.
  if (!Number.isInteger(n)) return null;
  return n >= 1 && n <= max ? n : null;
}

function shortList(v: unknown, maxItems: number, maxLen = 160): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = shortText(item, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---- strict parse/validation of the model output ---------------------------

export type EvidenceParse =
  | { ok: true; card: EvidenceCard; sourceSufficiency: "sufficient" | "insufficient" }
  | { ok: false; error: string };

/** Parse + normalize the ONE structured extraction. Enums are whitelisted,
 *  numbers must be clearly numeric, free text is clamped. Anything that cannot
 *  be validated safely becomes null/unknown — never a guess. A structurally
 *  malformed response is rejected outright (→ analysis_failed upstream). */
export function parseEvidenceOutput(raw: string): EvidenceParse {
  let parsed: unknown;
  try {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const text = fenced ? fenced[1] : raw;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return { ok: false, error: "evidence_output_no_json" };
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, error: "evidence_output_invalid_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "evidence_output_not_object" };
  }
  const o = parsed as Record<string, unknown>;

  // The three load-bearing enums must be present AND valid — a response missing
  // them is malformed, not "unknown" (rejecting is safer than defaulting).
  const applicability = String(o.applicability ?? "").trim();
  if (!APPLICABILITY.has(applicability)) return { ok: false, error: "evidence_output_bad_applicability" };
  const evidenceType = String(o.evidence_type ?? "").trim();
  if (!EVIDENCE_TYPES.has(evidenceType)) return { ok: false, error: "evidence_output_bad_evidence_type" };
  const claim = String(o.claim_relationship ?? "").trim();
  if (!CLAIMS.has(claim)) return { ok: false, error: "evidence_output_bad_claim_relationship" };

  const trialRaw = (o.trial ?? null) as Record<string, unknown> | null;
  const trial: EvidenceTrial | null = trialRaw && typeof trialRaw === "object" && !Array.isArray(trialRaw)
    ? {
      phase: shortText(trialRaw.phase, 12),
      randomized: pickEnum<TriState>(trialRaw.randomized, TRISTATE, "unknown"),
      controlled: pickEnum<TriState>(trialRaw.controlled, TRISTATE, "unknown"),
      blinded: pickEnum<TriState>(trialRaw.blinded, TRISTATE, "unknown"),
    }
    : null;

  const reviewRaw = (o.review ?? null) as Record<string, unknown> | null;
  const review: EvidenceReview | null = reviewRaw && typeof reviewRaw === "object" && !Array.isArray(reviewRaw)
    ? {
      included_studies: supportedInt(reviewRaw.included_studies, 100_000),
      participants: supportedInt(reviewRaw.participants),
      consistency: pickEnum(reviewRaw.consistency, CONSISTENCY, "unknown"),
    }
    : null;

  const card: EvidenceCard = {
    applicability: applicability as EvidenceApplicability,
    evidence_type: evidenceType as EvidenceType,
    peer_review_status: pickEnum<PeerReviewStatus>(o.peer_review_status, PEER_REVIEW, "unknown"),
    subject_type: pickEnum<SubjectType>(o.subject_type, SUBJECTS, "unknown"),
    population: shortText(o.population),
    sample_size: supportedInt(o.sample_size),
    intervention: shortText(o.intervention),
    comparator: shortText(o.comparator),
    main_outcome: shortText(o.main_outcome),
    claim_relationship: claim as ClaimRelationship,
    evidence_strength: pickEnum<EvidenceStrength>(o.evidence_strength, STRENGTHS, "unclear"),
    strength_reasons: shortList(o.strength_reasons, 5),
    limitations: shortList(o.limitations, 3),
    editorial_caution: shortText(o.editorial_caution, 320),
    trial,
    review,
    source_independence: pickEnum<SourceIndependence>(o.source_independence, INDEPENDENCE, "unknown"),
    guidance_issuer: shortText(o.guidance_issuer, 160),
    regulatory_action: shortText(o.regulatory_action, 220),
    confidence: pickEnum(o.confidence, CONFIDENCE, "low"),
  };
  const sourceSufficiency = String(o.source_sufficiency ?? "") === "insufficient" ? "insufficient" : "sufficient";
  return { ok: true, card, sourceSufficiency };
}

// ---- the ONE structured extraction call (messages + strict schema) ---------

// json_schema strict output, mirroring the Editorial Director's convention.
export const EVIDENCE_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "salma_evidence_card",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "source_sufficiency", "applicability", "evidence_type", "peer_review_status",
        "subject_type", "population", "sample_size", "intervention", "comparator",
        "main_outcome", "claim_relationship", "evidence_strength", "strength_reasons",
        "limitations", "editorial_caution", "trial", "review", "source_independence",
        "guidance_issuer", "regulatory_action", "confidence",
      ],
      properties: {
        source_sufficiency: { type: "string", enum: ["sufficient", "insufficient"] },
        applicability: { type: "string", enum: [...APPLICABILITY] },
        evidence_type: { type: "string", enum: [...EVIDENCE_TYPES] },
        peer_review_status: { type: "string", enum: [...PEER_REVIEW] },
        subject_type: { type: "string", enum: [...SUBJECTS] },
        population: { type: ["string", "null"] },
        sample_size: { type: ["integer", "null"] },
        intervention: { type: ["string", "null"] },
        comparator: { type: ["string", "null"] },
        main_outcome: { type: ["string", "null"] },
        claim_relationship: { type: "string", enum: [...CLAIMS] },
        evidence_strength: { type: "string", enum: [...STRENGTHS] },
        strength_reasons: { type: "array", items: { type: "string" } },
        limitations: { type: "array", items: { type: "string" } },
        editorial_caution: { type: ["string", "null"] },
        trial: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["phase", "randomized", "controlled", "blinded"],
          properties: {
            phase: { type: ["string", "null"] },
            randomized: { type: "string", enum: [...TRISTATE] },
            controlled: { type: "string", enum: [...TRISTATE] },
            blinded: { type: "string", enum: [...TRISTATE] },
          },
        },
        review: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["included_studies", "participants", "consistency"],
          properties: {
            included_studies: { type: ["integer", "null"] },
            participants: { type: ["integer", "null"] },
            consistency: { type: "string", enum: [...CONSISTENCY] },
          },
        },
        source_independence: { type: "string", enum: [...INDEPENDENCE] },
        guidance_issuer: { type: ["string", "null"] },
        regulatory_action: { type: ["string", "null"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
    },
  },
} as const;

const EVIDENCE_SYSTEM = `You are the evidence analyst for "Salma", an Arabic health-news platform. You are given the FULL TEXT of the strongest available editorial source for one selected health story. Produce a single conservative structured Evidence Card describing WHAT KIND of evidence this is, HOW STRONG it is, and what can/cannot be concluded.

ABSOLUTE RULES — this is a safety layer, not a summary:
1. NEVER invent details. If the source does not clearly state a sample size, trial phase, comparator, population, or peer-review status, return null/"unknown". Do not infer precise values from vague wording.
2. Association is NOT causation. "associated with" / "linked to" / observational designs → claim_relationship "association_only". Only a design that supports causal inference (e.g. an adequate randomized trial) with a causal result may be "causal_supported".
3. Animal / in-vitro / computational findings are PRECLINICAL. They must never be presented as demonstrated human benefit: subject_type accordingly, and claim_relationship "mechanistic_preclinical" when the claim rests on preclinical work.
4. A company's own announcement about its product, with no independent evidence in the source, is source_independence "company_only" — an ANNOUNCED CLAIM, not independently supported evidence. Do not call it false; just make the dependence visible.
5. A regulator's decision (approval/recall/warning) is authoritative evidence OF THE REGULATORY ACTION — put the action in regulatory_action. It is NOT by itself evidence of clinical efficacy: keep evidence_strength about the underlying clinical evidence actually described in the source.
6. Guidance/explainers from institutions are evidence_type "expert_guidance" (or peer_review_status "institutional_guidance") with guidance_issuer set — never classify guidance as a clinical trial or a single study.
7. Ignore headline hype entirely. Judge only the underlying evidence described in the source text.
8. Be conservative on evidence_strength and justify it in strength_reasons with compact structured points (e.g. "randomized controlled trial", "human population", "observational only — residual confounding possible", "small sample"). Never claim methodological quality the source does not verify.
9. applicability: "not_applicable" for stories where evidence analysis is not meaningful (pure business/administrative news); "partial" when only part of the story rests on analyzable evidence (e.g. a regulatory decision citing trials).
10. If the text is too thin/garbled to analyze honestly, set source_sufficiency "insufficient" and leave fields unknown/null.

Language: write free-text fields (population, intervention, comparator, main_outcome, strength_reasons, limitations, editorial_caution, regulatory_action) in concise ARABIC; technical terms may include English in parentheses. guidance_issuer keeps the institution's own name. editorial_caution is ONE sentence that prevents the most likely over-claim (e.g. "ارتباط رصدي فقط — لا يمكن إثبات أن القهوة سبب انخفاض الخطر."). No essays.`;

export function buildEvidenceMessages(input: {
  storyType: string;
  sourceUrl: string;
  sourceDomain: string;
  sourceTitle: string | null;
  sourceText: string;
}): { role: string; content: string }[] {
  const user = [
    `story_type: ${input.storyType}`,
    `source_domain: ${input.sourceDomain}`,
    `source_url: ${input.sourceUrl}`,
    input.sourceTitle ? `source_title: ${input.sourceTitle}` : "",
    "",
    "SOURCE TEXT:",
    input.sourceText.slice(0, EVIDENCE_MAX_SOURCE_CHARS),
  ].filter((s) => s !== "").join("\n");
  return [
    { role: "system", content: EVIDENCE_SYSTEM },
    { role: "user", content: user },
  ];
}

// ---- deterministic Writer guidance -----------------------------------------
// Compact Arabic wording CONSTRAINTS derived from the validated card. These are
// restrictions only — they add no facts and no numbers (a card number extracted
// by the model must never enter the article through guidance; the fidelity
// validator grounds numbers against the source text alone).

export function evidenceWriterGuidance(card: EvidenceCard | null | undefined): string[] {
  if (!card || card.applicability === "not_applicable") return [];
  const out: string[] = [];
  if (card.claim_relationship === "association_only") {
    out.push(
      "الدليل رصدي يُظهر ارتباطًا فقط: لا تستخدم أي صياغة سببية مثل «يسبب» أو «يؤدي إلى» أو «يقي من» أو «يمنع»؛ استخدم «ارتبط بـ» أو «لوحظ لدى» وما شابه.",
    );
  }
  if (
    card.claim_relationship === "mechanistic_preclinical" ||
    card.subject_type === "animal" || card.subject_type === "in_vitro" ||
    card.subject_type === "computational_modeling"
  ) {
    out.push(
      "النتائج ما قبل سريرية (حيوانات/مختبر/نمذجة): صرّح بوضوح أن الفائدة لم تثبت في البشر، ولا توحِ بأي تطبيق علاجي بشري قائم.",
    );
  }
  if (card.peer_review_status === "preprint") {
    out.push("الدراسة مسودة بحثية (Preprint) لم تخضع بعد لمراجعة الأقران: اذكر ذلك صراحة في المقال.");
  }
  if (card.source_independence === "company_only") {
    out.push(
      "الادّعاء صادر عن الشركة وحدها دون تحقق مستقل في المصدر: انسب كل نتيجة صراحة إلى إعلان الشركة، ولا تقدّمها كحقيقة علمية مثبتة.",
    );
  }
  if (card.evidence_type === "regulatory_evidence" || card.regulatory_action) {
    out.push(
      "القرار التنظيمي حقيقة موثوقة، لكن لا تستنتج منه فعالية أو أمانًا سريريًا يتجاوز ما ذكره المصدر نصًا.",
    );
  }
  if (card.evidence_type === "expert_guidance") {
    out.push("المحتوى إرشادات مؤسسية وليس دراسة واحدة: انسب التوصيات إلى الجهة المصدرة بوضوح.");
  }
  if (
    (card.evidence_strength === "limited" || card.evidence_strength === "very_limited" || card.evidence_strength === "unclear") &&
    out.length < 4
  ) {
    out.push("قوة الدليل محدودة: تجنّب صيغ الجزم والتعميم («يثبت»، «مؤكد»)، وقيّد النتائج بحدود الدراسة كما وردت في المصدر.");
  }
  return out.slice(0, 4);
}

/** Render the guidance as the packet block appended to the Writer's user
 *  message. Empty string when the card yields no constraints. */
export function renderEvidenceGuidanceBlock(card: EvidenceCard | null | undefined): string {
  const items = evidenceWriterGuidance(card);
  if (!items.length) return "";
  return [
    "قيود صياغة إلزامية مستندة إلى تحليل الأدلة (لا تضيف هذه القيود أي معلومة جديدة؛ هي حدود صياغة فقط):",
    ...items.map((s) => `- ${s}`),
  ].join("\n");
}

/** Should the deterministic association→causation fidelity guard apply
 *  regardless of the writing profile's own marker detection? */
export function associationGuardApplies(card: EvidenceCard | null | undefined): boolean {
  return !!card && card.claim_relationship === "association_only";
}

// ---- injectable orchestrator ----------------------------------------------

export type EvidenceInput = {
  clusterKey: string;
  storyType: string;
  sourceUrl: string;
  sourceDomain: string;
  sourceTitle: string | null;
  sourceText: string;
};

export type EvidenceDeps = {
  /** Cached outcome for this canonical cluster, or null. */
  cacheGet: (clusterKey: string) => Promise<{ status: EvidenceStatus; card: EvidenceCard | null } | null>;
  /** Persist the outcome (audit + cache). Best-effort upstream; may throw here. */
  cachePut: (outcome: { status: EvidenceStatus; card: EvidenceCard | null; reason: string | null }, input: EvidenceInput) => Promise<void>;
  /** The ONE bounded structured extraction call. */
  chat: (messages: { role: string; content: string }[]) => Promise<{ ok: true; content: string } | { ok: false; reason: string }>;
};

/** Run Evidence Intelligence for one selected cluster. Deterministic gates →
 *  cache → ONE LLM extraction → strict validation. Never throws; every failure
 *  becomes a safe analysis_failed outcome (no fallback conclusions). */
export async function analyzeEvidence(input: EvidenceInput, deps: EvidenceDeps): Promise<EvidenceOutcome> {
  try {
    const cached = await deps.cacheGet(input.clusterKey).catch(() => null);
    if (cached) return { status: cached.status, card: cached.card, cached: true, reason: null };

    const persist = async (o: { status: EvidenceStatus; card: EvidenceCard | null; reason: string | null }): Promise<EvidenceOutcome> => {
      try { await deps.cachePut(o, input); } catch { /* audit best-effort */ }
      return { ...o, cached: false };
    };

    // Deterministic gate 1 — story types where evidence analysis never applies.
    if (EVIDENCE_SKIP_STORY_TYPES.has(input.storyType)) {
      return await persist({ status: "not_applicable", card: null, reason: `story_type:${input.storyType}` });
    }
    // Deterministic gate 2 — source too thin to analyze honestly.
    if ((input.sourceText ?? "").trim().length < EVIDENCE_MIN_SOURCE_CHARS) {
      return await persist({ status: "insufficient_source", card: null, reason: "source_text_too_short" });
    }

    const r = await deps.chat(buildEvidenceMessages(input));
    if (!r.ok) return await persist({ status: "analysis_failed", card: null, reason: r.reason });

    const parsed = parseEvidenceOutput(r.content);
    if (!parsed.ok) return await persist({ status: "analysis_failed", card: null, reason: parsed.error });
    if (parsed.sourceSufficiency === "insufficient") {
      return await persist({ status: "insufficient_source", card: null, reason: "model_reported_insufficient_source" });
    }
    if (parsed.card.applicability === "not_applicable") {
      return await persist({ status: "not_applicable", card: parsed.card, reason: "model_not_applicable" });
    }
    return await persist({ status: "complete", card: parsed.card, reason: null });
  } catch (e) {
    return {
      status: "analysis_failed",
      card: null,
      cached: false,
      reason: e instanceof Error ? `unexpected:${e.message.slice(0, 120)}` : "unexpected_error",
    };
  }
}
