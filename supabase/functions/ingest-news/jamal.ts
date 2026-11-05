// Jamal (جمال) — Salma's dedicated editorial writing agent (integration layer).
//
// Design: "Jamal integration design — Revision 2" (approved 2026-11-05, steps
// 1–3). Two strictly separated layers:
//
//   1. INTEGRATION CONTRACT (stable): `writeJamalArticle` accepts the same
//      verified-source inputs as `writeArticle` and returns the same
//      WriterOutcome shape, so index.ts routes `writer_mode:"jamal"` through
//      the existing grounded-write → insertRepresentative → audit path with no
//      structural change. Jamal CANNOT publish: this module performs no DB
//      writes at all and its outcomes only ever become PENDING drafts or
//      rejections downstream (same guarantee as the writer pipeline).
//
//   2. EDITORIAL PROGRAM (swappable config): JamalConfig carries the version,
//      the internal technique, the instruction blocks and the approved
//      reference examples. The identity text arrives from the owner's Claude
//      Project ("Jamal - Salma Editorial Writer") and is pasted here under a
//      new version (j1.0, j1.1, …). Changing voice, examples or technique is a
//      config change only. Until the approved identity lands, J0_STUB is the
//      ONLY config: a technical placeholder for integration testing — NOT an
//      approved editorial voice, never to be activated editorially.
//
// Factual checking stays OUTSIDE Jamal: after the model returns, this module
// hands the draft to the existing deterministic validator (validateArticle)
// and fidelity-stage classifier (orchestrateFidelityRepair) over the FULL
// verified source text. Jamal never sees validator output. The single
// constrained repair is DISABLED in v1 (a Jamal draft that carries a
// repairable breach is rejected, never silently rewritten).
//
// Reference-example policy (owner rule): only owner-approved texts may be used
// as stylistic references. The registry below is the complete approved set;
// resolveJamalConfig refuses any config that references anything else. The
// five rejected select-then-write experiment articles are NOT approved and
// must never be added here without the owner's explicit approval.

// NOTE: pipeline.ts is imported TYPE-ONLY (it carries a jsr: specifier and
// top-level Deno.env reads, neither of which the Node test runner resolves).
// The OpenRouter transport is therefore INJECTED by index.ts (which already
// imports pipeline.chatJson); tests inject mocks. This module stays runnable
// under `node --test` like the other validator modules.
import {
  ambiguousNumericFigures,
  lostFigures,
  readingTimeMinutes,
  selectProfile,
  validateArticle,
  type WritingProfile,
} from "./salmaWriter.ts";
import { orchestrateFidelityRepair, type FidelityValidation } from "./fidelityRepair.ts";
import type { SourceText } from "./fetchSourceText.ts";
import type { EditorialAudit } from "./salmaEditor.ts";
import type { LlmUsage, WriterAudit, WriterOutcome } from "./pipeline.ts";

// ---- Model / versions ------------------------------------------------------

// Jamal's model is its OWN env var. OPENROUTER_WRITER_* and
// OPENROUTER_EDITOR_MODEL (which also drives fidelity repair and
// newsletter-curate) are never read here. Resolved lazily through a
// runtime-safe global lookup so the module imports cleanly under node:test
// (no top-level Deno reference).
export function jamalModel(): string {
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  return env?.get("OPENROUTER_JAMAL_MODEL") || "openai/gpt-5.4";
}

// Input-sanitizer version, recorded on every run for replayability.
export const JAMAL_SANITIZER_VERSION = "s1";

// ---- Approved reference registry -------------------------------------------

// The ONLY texts approved as stylistic references (owner, 2026-10-23). Stored
// verbatim from docs/editorial/benchmarks/ (edge functions cannot read repo
// docs at runtime). Reference for tone/structure only; NOT factual source
// material — the writing prompt must never present these as facts.
export const APPROVED_REFERENCES: Readonly<Record<string, string>> = Object.freeze({
  "benchmark-1-alzheimers": `## دراسة: ضعف تخلّص الدماغ من البروتينات الضارة قد يساهم في ألزهايمر

تشير مراجعة علمية جديدة إلى أن تراكم البروتينات المرتبطة بمرض ألزهايمر قد لا يكون بسبب زيادة إنتاجها فقط، بل أيضاً بسبب ضعف قدرة الدماغ على التخلص منها.

وتركز المراجعة على بروتين يساعد الدماغ على التخلص من هذه المواد، لكن نشاطه قد يتراجع مع التقدم في العمر ولدى بعض مرضى ألزهايمر.

وأظهرت تجارب على الفئران أن الحفاظ على وظيفة هذا البروتين قد يساعد في تقليل تراكم المواد الضارة، لكن هذه النتائج لم تثبت فعاليتها لدى البشر بعد.`,
  "benchmark-2-blues-inflammation": `## جزيئات جديدة قد تساعد في السيطرة على الالتهابات

اكتشف باحثون جزيئات جديدة قد تساعد مستقبلاً في تطوير علاجات للأمراض المرتبطة باضطرابات الالتهاب.

وتعمل هذه الجزيئات، التي أُطلق عليها اسم «BLUEs»، على تعطيل نشاط مجموعة من البروتينات التي تساعد في تنظيم استجابة الجسم للالتهابات.

وأظهرت التجارب المختبرية أن الجزيئات نجحت في تقليل بعض الإشارات المرتبطة بالاستجابة المناعية، لكن فعاليتها في علاج الأمراض لدى البشر لم تُختبر بعد.`,
});

// ---- Editorial program (swappable configuration) ----------------------------

export type JamalTechnique = "single_pass" | "select_then_write";

export type JamalConfig = {
  // Version string recorded on every decision/run ("j0.0-stub", "j1.0", …).
  version: string;
  // Internal technique. An unproven implementation detail, NOT an approved
  // editorial solution — swappable per config version.
  technique: JamalTechnique;
  // System instructions. `selection` is required only for select_then_write.
  instructions: { write: string; selection?: string };
  // Keys into APPROVED_REFERENCES. Nothing else is accepted.
  referenceExamples: string[];
};

/** Validate a config against the approved-reference registry and technique
 *  requirements. Throws on any violation so a bad config can never run. */
export function resolveJamalConfig(config: JamalConfig): JamalConfig {
  if (!config.version || !config.version.trim()) throw new Error("jamal_config_version_required");
  for (const key of config.referenceExamples) {
    if (!(key in APPROVED_REFERENCES)) {
      throw new Error(`jamal_reference_not_approved:${key}`);
    }
  }
  if (config.technique === "select_then_write" && !config.instructions.selection) {
    throw new Error("jamal_selection_instructions_required");
  }
  if (!config.instructions.write || !config.instructions.write.trim()) {
    throw new Error("jamal_write_instructions_required");
  }
  return config;
}

// Technical stub for integration testing ONLY (owner condition 5): minimal,
// deliberately voice-free instructions that exercise transport, schema,
// sanitizer, validation and audit paths. NOT an approved editorial voice; the
// "-stub" suffix is asserted in tests and must never appear in an editorial
// evaluation or activation.
export const J0_STUB: JamalConfig = Object.freeze({
  version: "j0.0-stub",
  technique: "single_pass" as JamalTechnique,
  instructions: {
    write:
      "أنت كاتب أخبار صحية. اكتب خبراً عربياً موجزاً ودقيقاً من النص المصدر أدناه. " +
      "كل رقم أو اسم أو ادعاء يجب أن يكون موجوداً في المصدر نصاً؛ لا تضف شيئاً من عندك، " +
      "واحتفظ بالقيود والتحذيرات الطبية كما هي. " +
      'أعد JSON بالمفاتيح: "title" و"excerpt" و"body" و"source_reference" (اسم المصدر) و"review_notes" (قائمة ملاحظات قصيرة للمحرر البشري عن اختياراتك).',
  },
  referenceExamples: [] as string[],
});

// ---- Input sanitizer (footer contamination; narrow, Jamal-input-only) -------

// Conservative trailing-footer markers seen on registered sources (the
// جاسكايد leak came from an SFDA «محتوى ذو علاقة» block). The cut applies ONLY
// when a marker appears in the LATTER part of the text (never the headline or
// lead), and only the earliest such marker onward is dropped. Shared
// fetchSourceText is NOT modified (owner condition 7): validation still runs
// on the FULL verified text; this narrows what Jamal reads, never what the
// validator checks against.
const FOOTER_MARKERS = [
  "محتوى ذو علاقة",
  "مواضيع ذات صلة",
  "التعليقات والاقتراحات",
  "اقرأ أيضاً",
  "اقرأ أيضا",
  "Related Articles",
  "Related Content",
  "Related News",
  "Watch latest videos",
];

export function sanitizeJamalInput(text: string): {
  text: string;
  applied: boolean;
  version: string;
} {
  const floor = Math.floor(text.length * 0.4);
  let cut = -1;
  for (const marker of FOOTER_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx >= floor && (cut === -1 || idx < cut)) cut = idx;
  }
  if (cut === -1) return { text, applied: false, version: JAMAL_SANITIZER_VERSION };
  return { text: text.slice(0, cut).trimEnd(), applied: true, version: JAMAL_SANITIZER_VERSION };
}

// ---- Structured output schemas ----------------------------------------------

const JAMAL_ARTICLE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "jamal_article",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        excerpt: { type: "string" },
        body: { type: "string" },
        source_reference: { type: "string" },
        review_notes: { type: "array", items: { type: "string" } },
      },
      required: ["title", "excerpt", "body", "source_reference", "review_notes"],
    },
  },
};

const JAMAL_SELECTION_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "jamal_selection",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        central_fact: { type: "string" },
        why_it_matters: { type: ["string", "null"] },
        essential_facts: { type: "array", items: { type: "string" } },
        must_keep_caveats: { type: "array", items: { type: "string" } },
      },
      required: ["central_fact", "why_it_matters", "essential_facts", "must_keep_caveats"],
    },
  },
};

// ---- Jamal invocation (model side only; no validation in here) --------------

export type JamalChat = (
  messages: { role: string; content: string }[],
  responseFormat: unknown,
) => Promise<{ ok: true; content: string } | { ok: false; reason: string }>;

export type JamalDraft = {
  article: { title: string; excerpt: string; body: string };
  sourceReference: string;
  reviewNotes: string[];
  // Technique trace for the audit sidecar (selection JSON for select_then_write).
  trace: { selection?: unknown };
};

type JamalRunResult = { ok: true; draft: JamalDraft } | { ok: false; reason: string };

function referencesBlock(config: JamalConfig): string {
  if (!config.referenceExamples.length) return "";
  const texts = config.referenceExamples.map((k) => APPROVED_REFERENCES[k]).join("\n\n");
  return `\n\n### أمثلة معتمدة على الأسلوب المطلوب (مرجع للأسلوب والبنية فقط — ليست مصدراً لأي حقيقة):\n\n${texts}`;
}

function parseJamalArticle(content: string): JamalRunResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: "jamal_output_invalid_json" };
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const excerpt = typeof o.excerpt === "string" ? o.excerpt.trim() : "";
  const body = typeof o.body === "string" ? o.body.trim() : "";
  const sourceReference = typeof o.source_reference === "string" ? o.source_reference.trim() : "";
  const reviewNotes = Array.isArray(o.review_notes)
    ? o.review_notes.filter((n): n is string => typeof n === "string")
    : null;
  if (!title || !body || !excerpt || reviewNotes === null) {
    return { ok: false, reason: "jamal_output_schema_invalid" };
  }
  return {
    ok: true,
    draft: { article: { title, excerpt, body }, sourceReference, reviewNotes, trace: {} },
  };
}

/** Run Jamal's editorial program over the (sanitized) source input. Pure with
 *  respect to the injected chat transport: no env, no DB, no validation. */
export async function runJamal(
  config: JamalConfig,
  input: { sourceText: string; sourceName: string | null; sourceUrl: string },
  deps: { chat: JamalChat },
): Promise<JamalRunResult> {
  const resolved = resolveJamalConfig(config);
  const sourceBlock = [
    input.sourceName ? `المصدر: ${input.sourceName}` : "",
    `الرابط: ${input.sourceUrl}`,
    "",
    input.sourceText,
  ].filter(Boolean).join("\n");

  if (resolved.technique === "single_pass") {
    const res = await deps.chat(
      [
        { role: "system", content: resolved.instructions.write + referencesBlock(resolved) },
        { role: "user", content: `نص الخبر المصدر:\n\n${sourceBlock}` },
      ],
      JAMAL_ARTICLE_SCHEMA,
    );
    if (!res.ok) return { ok: false, reason: `jamal_transport:${res.reason}` };
    return parseJamalArticle(res.content);
  }

  // select_then_write: call 1 extracts the editorial selection from the source;
  // call 2 writes ONLY from that selection (the writer never sees the source
  // text — a structural guard against source-order paraphrase).
  const sel = await deps.chat(
    [
      { role: "system", content: resolved.instructions.selection! },
      { role: "user", content: `نص الخبر المصدر:\n\n${sourceBlock}` },
    ],
    JAMAL_SELECTION_SCHEMA,
  );
  if (!sel.ok) return { ok: false, reason: `jamal_transport:${sel.reason}` };
  let selection: unknown;
  try {
    selection = JSON.parse(sel.content);
  } catch {
    return { ok: false, reason: "jamal_selection_invalid_json" };
  }
  const wr = await deps.chat(
    [
      { role: "system", content: resolved.instructions.write + referencesBlock(resolved) },
      {
        role: "user",
        content: `الخلاصة التحريرية المنتقاة (مصدرك الوحيد للحقائق):\n\n${JSON.stringify(selection, null, 1)}\n\nالمصدر: ${input.sourceName ?? ""}`,
      },
    ],
    JAMAL_ARTICLE_SCHEMA,
  );
  if (!wr.ok) return { ok: false, reason: `jamal_transport:${wr.reason}` };
  const parsed = parseJamalArticle(wr.content);
  if (!parsed.ok) return parsed;
  parsed.draft.trace.selection = selection;
  return parsed;
}

// ---- Audit sidecar record (inserted by index.ts; this module stays DB-free) --

export type JamalRunRecord = {
  config_version: string;
  technique: JamalTechnique;
  model: string;
  source_url: string;
  source_snapshot: string;
  source_sha256: string;
  jamal_input_sha256: string;
  sanitizer_version: string;
  sanitizer_applied: boolean;
  selection: unknown | null;
  review_notes: string[];
  source_reference: string | null;
  accepted: boolean;
  validation_result: string;
  usage: LlmUsage | null;
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A fully-populated, honest "the Editorial Director did not run" audit so the
// Jamal outcome satisfies the WriterOutcome contract the pilot report and
// decision logging already consume. decision:"kept_original" is the closest
// EditorDecision value (the final draft IS the unedited Jamal draft); the
// DB-level outcome is recorded distinctly as editor_outcome:"jamal_no_editor"
// on WriterAudit, so decisions remain distinguishable from real editor runs.
function jamalEditorialAudit(verdict: "needs_human_review" | "ready"): EditorialAudit {
  return {
    editor_attempted: false,
    editor_model_requested: null,
    editor_model_used: null,
    editor_output_parsed: false,
    edited_draft_accepted: false,
    final_draft_source: "original",
    editorial_verdict: verdict,
    model_editorial_verdict: null,
    issues_found: [],
    changes_made: [],
    factual_revalidation_result: "not_run",
    editor_rejection_reason: null,
    editorial_blocking: [],
    editorial_review: [],
    editorial_advisory: [],
    editor_attempts: 0,
    first_attempt_failure_reason: null,
    recovery_attempted: false,
    recovery_succeeded: false,
    final_editor_failure_reason: null,
    second_attempt_type: "none",
    repair_issues: [],
    repair_succeeded: false,
    first_valid_edited_draft_available: false,
    final_editorial_verdict: verdict,
    final_rejection_reason: null,
    decision: "kept_original",
    reasons: ["jamal_mode_no_editor"],
    repair_attempted: false,
    repair_restored: [],
  } as EditorialAudit;
}

// ---- The integration contract -----------------------------------------------

/** Verified-source Jamal write: sanitize input → run the editorial program →
 *  validate OUTSIDE Jamal with the existing deterministic validator → classify
 *  via the existing fidelity stage (repair DISABLED) → return the standard
 *  WriterOutcome plus the audit-sidecar record. No DB access, no publishing,
 *  no status fields — downstream, outcomes become pending drafts or rejections
 *  exactly like writer-pipeline outcomes. */
export async function writeJamalArticle(input: {
  verified: SourceText;
  discovery: { originalTitle: string; body: string; excerpt: string };
  sourceName: string | null;
  registeredDomain: string | null;
  sourceUrl: string;
  config?: JamalConfig;
  usage?: LlmUsage;
  // The OpenRouter transport, injected by index.ts (pipeline.chatJson bound to
  // Jamal's model) or by tests (mock). Required: this module never builds it.
  chat: JamalChat;
}): Promise<WriterOutcome & { jamalRun: JamalRunRecord }> {
  const config = resolveJamalConfig(input.config ?? J0_STUB);
  const originalTitle = input.discovery.originalTitle ?? "";

  // GROUNDING text for validation — constructed EXACTLY as writeArticle builds
  // verifiedFactText (pipeline.ts) so Jamal drafts face the identical factual
  // bar. Kept in sync by the jamalWiring test.
  const verifiedFactText = [
    input.verified.title,
    input.verified.text,
    input.verified.publishedDate ? `تاريخ النشر: ${input.verified.publishedDate}` : "",
    input.sourceName ? `المصدر: ${input.sourceName}` : "",
    input.registeredDomain ? `النطاق: ${input.registeredDomain}` : "",
    input.verified.finalUrl,
  ].map((s) => (s ?? "").trim()).filter(Boolean).join("\n");
  const mustPreserve = input.verified.mustPreserve;

  // Routing profile: same inputs as production routing (orientation text may
  // use discovery; it only selects which VALIDATION profile applies — Jamal's
  // writing itself never sees the discovery draft).
  const routingText = [
    originalTitle,
    input.discovery.excerpt,
    input.discovery.body,
    input.verified.title,
  ].map((s) => (s ?? "").trim()).filter(Boolean).join("\n");
  const profile: WritingProfile = selectProfile({ sourceText: routingText });

  // Jamal reads the SANITIZED source (footer/related-links stripped); the
  // validator below always checks against the FULL verified text.
  const rawInput = [input.verified.title, input.verified.text].filter(Boolean).join("\n\n");
  const sanitized = sanitizeJamalInput(rawInput);

  const chat: JamalChat = input.chat;

  const audit: WriterAudit = {
    writing_profile: profile,
    writer_primary_model: jamalModel(),
    writer_model_used: jamalModel(),
    writer_fallback_used: false,
    writer_prompt_version: config.version,
    writer_validation_reason: null,
    source_extraction_method: input.verified.method,
    source_char_count: input.verified.charCount,
    source_word_count: input.verified.wordCount,
    editor_outcome: "jamal_no_editor",
    editor_prompt_version: config.version,
  };

  const runBase = {
    config_version: config.version,
    technique: config.technique,
    model: jamalModel(),
    source_url: input.sourceUrl,
    source_snapshot: verifiedFactText,
    source_sha256: await sha256Hex(verifiedFactText),
    jamal_input_sha256: await sha256Hex(sanitized.text),
    sanitizer_version: sanitized.version,
    sanitizer_applied: sanitized.applied,
    usage: input.usage ?? null,
  };

  const ran = await runJamal(
    config,
    { sourceText: sanitized.text, sourceName: input.sourceName, sourceUrl: input.sourceUrl },
    { chat },
  );
  if (!ran.ok) {
    audit.writer_validation_reason = ran.reason;
    return {
      ok: false,
      rejection: ran.reason,
      audit,
      editorial: null,
      fidelity: null,
      writerAttempts: 1,
      writerSecondAttempt: "none",
      jamalRun: {
        ...runBase,
        selection: null,
        review_notes: [],
        source_reference: null,
        accepted: false,
        validation_result: ran.reason,
      },
    };
  }

  // FACTUAL VALIDATION — outside Jamal, identical bar to the writer pipeline.
  const validateFidelity = (a: { title: string; excerpt: string; body: string; summary?: string }): FidelityValidation => {
    const v = validateArticle({
      article: { title: a.title, excerpt: a.excerpt, body: a.body, summary: a.summary ?? "", profile },
      source: { sourceText: verifiedFactText, originalTitle, brand: input.sourceName ?? null, mustPreserve, sourceLang: null },
    });
    return { ok: v.errors.length === 0, errors: [...v.errors], cleanTitle: v.cleanTitle, readMinutes: v.readMinutes };
  };
  const draft = { title: ran.draft.article.title, excerpt: ran.draft.article.excerpt, summary: "", body: ran.draft.article.body };
  const fidelity = await orchestrateFidelityRepair({
    draft,
    readMinutes: readingTimeMinutes(draft.body),
    validate: validateFidelity,
    // v1: the constrained repair is DISABLED for Jamal drafts — a repairable
    // breach rejects (safe), it is never silently rewritten.
    repair: async () => ({ ok: false, reason: "jamal_repair_disabled" }),
    figuresLost: (before, after) => lostFigures(before, after, verifiedFactText),
  });

  const jamalRun: JamalRunRecord = {
    ...runBase,
    selection: ran.draft.trace.selection ?? null,
    review_notes: ran.draft.reviewNotes,
    source_reference: ran.draft.sourceReference || null,
    accepted: fidelity.decision !== "reject",
    validation_result: fidelity.decision === "reject" ? (fidelity.rejectionReason ?? "validation_failed") : fidelity.decision,
  };

  if (fidelity.decision === "reject") {
    audit.writer_validation_reason = fidelity.rejectionReason ?? "validation_failed";
    return {
      ok: false,
      rejection: fidelity.rejectionReason ?? "validation_failed",
      audit,
      editorial: jamalEditorialAudit("needs_human_review"),
      fidelity: fidelity.audit,
      writerAttempts: 1,
      writerSecondAttempt: "none",
      jamalRun,
    };
  }

  const finalArticle = {
    title: fidelity.cleanTitle || fidelity.article.title,
    excerpt: fidelity.article.excerpt,
    body: fidelity.article.body,
  };
  const needsHumanReview = fidelity.decision === "needs_human_review" ||
    ambiguousNumericFigures(
      [finalArticle.title, finalArticle.excerpt, finalArticle.body].join("\n"),
      verifiedFactText,
      null,
    ).length > 0;

  return {
    ok: true,
    article: finalArticle,
    readMinutes: fidelity.readMinutes,
    audit,
    editorial: jamalEditorialAudit(needsHumanReview ? "needs_human_review" : "ready"),
    fidelity: fidelity.audit,
    needsHumanReview,
    writerAttempts: 1,
    writerSecondAttempt: "none",
    jamalRun,
  };
}
