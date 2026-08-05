// E1.3C — writer-model routing (pure, no Deno/Supabase imports).
//
// Decides WHICH OpenRouter model writes a verified story, based on its writing
// profile, and whether a technical failure of the primary model may fall back
// to the cheaper technical-fallback model. Kept import-free so the routing and
// fallback rules are unit-testable in isolation (see writerRouter.test.ts).
//
// Approved pilot routing (E1.3B benchmark outcome):
//   quick_news · standard_news · regulation_or_service -> default  (gpt-5.4-mini)
//   safety_alert · research_study                       -> sensitive (claude-sonnet-5)
//   technical fallback only                             -> fallback (gpt-4o-mini)
// google/gemini-3-flash-preview must NEVER be selected (fabricates unsourced
// medical specifics the validator does not catch).

import type { WritingProfile } from "./salmaWriter.ts";

export type WriterModelConfig = {
  /** Model for the non-sensitive profiles (default: openai/gpt-5.4-mini). */
  defaultModel: string;
  /** Model for the sensitive profiles (default: anthropic/claude-sonnet-5). */
  sensitiveModel: string;
  /** Technical-failure fallback only (default: openai/gpt-4o-mini). */
  fallbackModel: string;
};

// Profiles that must be written by the higher-caution sensitive model.
export const SENSITIVE_PROFILES: readonly WritingProfile[] = ["safety_alert", "research_study"];

// Models that may never write a Salma article, whatever the configuration says.
export const FORBIDDEN_WRITER_MODELS: readonly string[] = ["google/gemini-3-flash-preview"];

export function isSensitiveProfile(profile: WritingProfile): boolean {
  return SENSITIVE_PROFILES.includes(profile);
}

export function isForbiddenWriterModel(model: string): boolean {
  const m = (model ?? "").trim().toLowerCase();
  return FORBIDDEN_WRITER_MODELS.some((f) => f.toLowerCase() === m);
}

/**
 * Guard the configured models at the system boundary: none of the three roles
 * may be empty or a forbidden model. Throwing here surfaces a misconfiguration
 * before any live call, rather than silently routing to the wrong model.
 */
export function assertWriterConfig(config: WriterModelConfig): void {
  for (const [role, model] of Object.entries(config)) {
    if (!model || !model.trim()) throw new Error(`writer_config_missing_model:${role}`);
    if (isForbiddenWriterModel(model)) throw new Error(`writer_config_forbidden_model:${role}:${model}`);
  }
}

/** The primary model that should write a story of this profile. */
export function selectWriterModel(profile: WritingProfile, config: WriterModelConfig): string {
  return isSensitiveProfile(profile) ? config.sensitiveModel : config.defaultModel;
}

// --- Pilot gate (controlled rollout of the verified-source Salma writer) ----

// The ingestion run mode. "legacy" is the unchanged pre-pilot behavior the
// scheduled cron uses (insert the discovery draft; no source fetch, no Salma
// writer). "pilot" is the E1.3C/D verified-source path (fetch the real source,
// run the Salma writer + factual validation). During the controlled pilot the
// cron must stay on "legacy"; only an explicitly authorized manual request may
// select "pilot".
export type WriterMode = "legacy" | "pilot";

/**
 * Resolve the ingestion run mode from the request. "pilot" is chosen ONLY when
 * the caller is authorized (the existing ingestion secret / admin auth was
 * verified upstream) AND explicitly asked for it (writer_mode:"pilot"). Any
 * unauthorized caller, a missing/other flag, or a non-string value stays on
 * "legacy" — so an unauthenticated request can never activate the new writer,
 * and the default cron path (no body / no flag) is always legacy.
 */
export function resolveWriterMode(input: { authorized: boolean; requestedMode?: unknown }): WriterMode {
  if (!input.authorized) return "legacy";
  const m = typeof input.requestedMode === "string" ? input.requestedMode.trim().toLowerCase() : "";
  return m === "pilot" ? "pilot" : "legacy";
}

// --- Single-article pilot gate (E1.3E) -------------------------------------

// The first production pilot must touch production paths for at most ONE
// candidate. The gate therefore requires an EXPLICIT pilot_limit and, for this
// first pilot, allows ONLY 1 — any missing/other/>1 value is rejected (the run
// does not start) rather than silently clamped, so a fat-fingered "process 50"
// cannot run. An unauthorized caller can never reach "pilot" (stays legacy).
export type PilotGateDecision =
  | { mode: "legacy" }
  // `sourceUrl` is present ONLY for a targeted single-article pilot (E1.3F): an
  // authorized pilot that supplied a usable http/https pilot_source_url. It is
  // omitted for an ordinary (discovery) pilot so the existing gate contract —
  // { mode: "pilot", limit: 1 } — is unchanged for non-targeted callers.
  | { mode: "pilot"; limit: 1; sourceUrl?: string }
  | { mode: "rejected"; reason: string };

// The only pilot_limit the first controlled pilot accepts.
export const FIRST_PILOT_LIMIT = 1;

/** Parse an explicit pilot_limit: the number 1 or the string "1" → 1; else null. */
function parsePilotLimit(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

// Sentinel: pilot_source_url was supplied but is not a usable http/https URL.
const TARGETED_URL_INVALID = Symbol("targeted_url_invalid");

/**
 * Parse the optional pilot_source_url. Returns `undefined` when it is absent
 * (an ordinary pilot with no targeting), the canonical URL string when it is a
 * syntactically valid http/https URL, or the INVALID sentinel when it was
 * supplied but is not a usable http/https URL string (→ the gate rejects the
 * run). This is shape-only validation; the registry hostname match happens in
 * index.ts against the freshly-loaded registry.
 */
function parseTargetedSourceUrl(raw: unknown): string | undefined | typeof TARGETED_URL_INVALID {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return TARGETED_URL_INVALID;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return TARGETED_URL_INVALID;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return TARGETED_URL_INVALID;
  return url.href;
}

/**
 * Resolve the full pilot gate: mode AND the single-article limit. Legacy stays
 * legacy. A pilot request must be authorized (checked upstream), explicitly ask
 * for pilot, AND carry an explicit pilot_limit of exactly 1; anything else is a
 * hard rejection (`pilot_limit_must_be_1`) so the run never starts with an
 * unbounded or absent limit.
 */
export function resolvePilotGate(input: {
  authorized: boolean;
  requestedMode?: unknown;
  requestedLimit?: unknown;
  // Optional targeted single-article pilot URL (E1.3F). Honored ONLY on an
  // authorized pilot with limit=1; a legacy/cron/default request never reaches
  // this branch, so pilot_source_url is ignored there (never activates targeting).
  requestedSourceUrl?: unknown;
}): PilotGateDecision {
  if (resolveWriterMode({ authorized: input.authorized, requestedMode: input.requestedMode }) !== "pilot") {
    return { mode: "legacy" };
  }
  const limit = parsePilotLimit(input.requestedLimit);
  if (limit !== FIRST_PILOT_LIMIT) return { mode: "rejected", reason: "pilot_limit_must_be_1" };
  const targeted = parseTargetedSourceUrl(input.requestedSourceUrl);
  if (targeted === TARGETED_URL_INVALID) return { mode: "rejected", reason: "pilot_source_url_invalid" };
  return targeted
    ? { mode: "pilot", limit: FIRST_PILOT_LIMIT, sourceUrl: targeted }
    : { mode: "pilot", limit: FIRST_PILOT_LIMIT };
}

// --- Bounded representative processing (E1.3E, pure/injectable) -------------

// Outcome of committing one representative, reported back to the bounded loop so
// it can decide whether the single pilot slot has been consumed. `reachedFetchStage`
// MUST be set true the moment a representative reaches the source-fetch stage —
// BEFORE the fetch is attempted — so the pilot stops after the first candidate
// that reaches that stage even if extraction/writing then fails.
export type CommitOutcome<R> = { reachedFetchStage: boolean; result: R };

/**
 * Process representatives in order, but once `limit` of them have REACHED the
 * source-fetch stage, stop starting new ones. With limit=1 (the first pilot)
 * this guarantees at most one source fetch / writer call / insert, and that
 * processing halts after the first fetch-stage candidate even when it fails.
 * When `limit` is null (legacy/cron) every representative is processed — the
 * pre-pilot behavior is unchanged. Pure apart from the injected `commit`.
 */
export async function processRepresentativesWithLimit<T, R>(args: {
  representatives: T[];
  limit: number | null;
  commit: (rep: T) => Promise<CommitOutcome<R>>;
  onSkipped?: (rep: T) => void;
}): Promise<{ processed: number; fetchStageCount: number }> {
  let fetchStageCount = 0;
  let processed = 0;
  for (const rep of args.representatives) {
    if (args.limit != null && fetchStageCount >= args.limit) {
      args.onSkipped?.(rep);
      continue;
    }
    const outcome = await args.commit(rep);
    processed++;
    if (outcome.reachedFetchStage) fetchStageCount++;
  }
  return { processed, fetchStageCount };
}

// --- Failure classification / fallback decision ----------------------------

// Why a primary attempt failed. Only `technical_failure` may fall back to the
// cheaper model; a `validation_failure` (the model produced a complete article
// that failed factual validation) must reject the draft — never silently ask a
// cheaper model to rewrite an ungrounded story.
export type TechnicalFailureReason =
  | "network_error"
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  | "empty_or_malformed_response";

export type WriterAttemptOutcome =
  | { kind: "ok" }
  | { kind: "technical_failure"; reason: TechnicalFailureReason }
  | { kind: "validation_failure"; rejectionReason: string };

/**
 * Classify a raw call result as a technical failure (fallback-eligible) or not.
 * Fallback-eligible: network error, timeout, HTTP 429/408, any HTTP 5xx, or an
 * empty/malformed API response. Everything else (e.g. HTTP 400/401/403 — a
 * configuration/auth problem) is NOT a technical failure and must not silently
 * route to the fallback model. Returns null when there is no technical failure.
 */
export function classifyTechnicalFailure(input: {
  networkError?: boolean;
  timedOut?: boolean;
  httpStatus?: number | null;
  emptyOrMalformed?: boolean;
}): TechnicalFailureReason | null {
  if (input.networkError) return "network_error";
  if (input.timedOut) return "timeout";
  const status = input.httpStatus ?? null;
  if (status === 0) return "network_error";
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status != null && status >= 500) return "provider_unavailable";
  if (input.emptyOrMalformed) return "empty_or_malformed_response";
  return null;
}

/** Fallback runs ONLY when the primary attempt failed for a technical reason. */
export function fallbackAllowed(outcome: WriterAttemptOutcome): boolean {
  return outcome.kind === "technical_failure";
}

/**
 * Resolve the model to actually use for a single story: the primary for the
 * profile, unless the primary attempt suffered a technical failure, in which
 * case the technical-fallback model. A validation failure never falls back;
 * `null` there means "reject the draft, do not retry with a cheaper model".
 */
export function resolveWriterModel(
  profile: WritingProfile,
  config: WriterModelConfig,
  primaryOutcome: WriterAttemptOutcome,
): { model: string; usedFallback: boolean } | { model: null; usedFallback: false } {
  const primary = selectWriterModel(profile, config);
  if (primaryOutcome.kind === "ok") return { model: primary, usedFallback: false };
  if (fallbackAllowed(primaryOutcome)) return { model: config.fallbackModel, usedFallback: true };
  return { model: null, usedFallback: false };
}

// --- End-to-end orchestration (pure, injectable) ---------------------------

// A response that COMPLETED at the transport layer (HTTP 200) but is unusable
// BEFORE any parsing: the model stopped for a non-"stop" reason (e.g. truncated
// at max_tokens, content-filtered, tool_calls) or returned a non-string content
// shape. These are NOT technical failures — they must reject the draft with
// their specific safe reason and must NOT fall back or retry to a cheaper model:
// the call already completed, so a retry would not fix a truncated/filtered
// completion, and a cheaper model must never silently rewrite the story.
export type WriterCompletionReject =
  | "writer_output_truncated"
  | "writer_output_content_filtered"
  | "writer_output_tool_calls"
  | "writer_output_provider_error"
  | "writer_output_unexpected_finish"
  | "writer_output_content_invalid";

/**
 * Inspect the OpenRouter completion metadata (`finish_reason` + `message.content`)
 * BEFORE parsing. Only a "stop" (or an absent/null) finish reason with a
 * non-empty string content may proceed. A "length" truncation, a filtered /
 * tool_calls / error / any other unexpected non-null finish reason, or a
 * non-string content shape is a completed-but-invalid response (reject, no
 * fallback). An empty/whitespace string is an empty completion, which stays a
 * technical (fallback-eligible) failure — unchanged from the prior behavior.
 * Pure: it neither parses, repairs, nor infers text from unknown structures.
 */
export function evaluateWriterCompletion(
  choice: { finish_reason?: unknown; message?: { content?: unknown } | null } | null | undefined,
):
  | { ok: true; content: string }
  | { ok: false; kind: "completed_invalid"; reason: WriterCompletionReject }
  | { ok: false; kind: "empty" } {
  // 1. Finish-reason: reject any completed-but-invalid stop condition first, so
  //    truncated/filtered output is never parsed or repaired.
  const fr = choice?.finish_reason;
  if (typeof fr === "string") {
    const f = fr.trim().toLowerCase();
    if (f === "length") return { ok: false, kind: "completed_invalid", reason: "writer_output_truncated" };
    if (f === "content_filter") return { ok: false, kind: "completed_invalid", reason: "writer_output_content_filtered" };
    if (f === "tool_calls") return { ok: false, kind: "completed_invalid", reason: "writer_output_tool_calls" };
    if (f === "error") return { ok: false, kind: "completed_invalid", reason: "writer_output_provider_error" };
    if (f !== "stop" && f !== "") return { ok: false, kind: "completed_invalid", reason: "writer_output_unexpected_finish" };
  }
  // 2. Content shape: a null/missing/array/object/any non-string value is invalid.
  const content = choice?.message?.content;
  if (typeof content !== "string") return { ok: false, kind: "completed_invalid", reason: "writer_output_content_invalid" };
  // An empty/whitespace completion stays a technical (fallback-eligible) failure.
  if (content.trim().length === 0) return { ok: false, kind: "empty" };
  return { ok: true, content };
}

// Raw result of a single writer HTTP call, shaped so the technical-failure
// classifier can decide fallback eligibility. The actual fetch lives in
// index.ts; this module stays import-free and unit-testable with a fake call.
export type WriterHttpResult =
  | { ok: true; content: string }
  // Completed (HTTP 200) but invalid before parsing (see evaluateWriterCompletion):
  // reject with this specific reason — never fall back or retry.
  | { ok: false; completedInvalid: true; reason: WriterCompletionReject }
  | {
      ok: false;
      networkError?: boolean;
      timedOut?: boolean;
      httpStatus?: number | null;
      emptyOrMalformed?: boolean;
    };

// Result of parsing + factually validating one writer output. `reason` is the
// blocking rejection (parse error or the validator's rejectionReason).
export type WriterValidation =
  | { ok: true; article: { title: string; excerpt: string; body: string; summary?: string }; readMinutes: number }
  | { ok: false; reason: string };

export type WriterOrchestrationResult = {
  ok: boolean;
  profile: WritingProfile;
  primaryModel: string;
  // The model whose output was validated (primary, or fallback on a technical
  // failure). Null only when the primary failed non-technically before any call
  // to a fallback was warranted.
  modelUsed: string | null;
  usedFallback: boolean;
  article?: { title: string; excerpt: string; body: string; summary?: string };
  readMinutes?: number;
  // Decision `rejection_reason` when ok=false.
  rejection?: string;
  // Audit `writer_validation_reason`: set only on a factual/parse validation
  // failure (never on a technical/transport failure).
  validationReason: string | null;
  // Writer JSON-recovery observability (mirrors the editor's one formatting
  // recovery). `writerAttempts` is the number of writer model calls made for
  // THIS result: 1 normally, or 2 when either the technical-failure fallback
  // fired OR the single strict-JSON recovery fired. `secondAttemptType` marks
  // the kind of the second call when there was one — `json_recovery` only when
  // it was the strict-JSON reparse retry, otherwise `none`.
  writerAttempts: number;
  secondAttemptType: "none" | "json_recovery";
};

/**
 * Orchestrate writing one already-selected, deduped story:
 *   1. pick the primary model for the profile and call it;
 *   2. on a TECHNICAL failure only, call the fallback model once;
 *   3. validate whichever completed output we got — a factual/parse failure is
 *      a rejection, never a silent retry on a cheaper model.
 *
 * Pure and side-effect-free apart from the injected `call`; `validate` wraps
 * salmaWriter's parse + validateArticle. This is the unit-tested seam (the live
 * fetch and the real validator are supplied by index.ts).
 */
export async function orchestrateWriter(args: {
  profile: WritingProfile;
  config: WriterModelConfig;
  call: (model: string, opts?: { strictJsonRecovery?: boolean }) => Promise<WriterHttpResult>;
  validate: (content: string) => WriterValidation;
}): Promise<WriterOrchestrationResult> {
  const { profile, config, call, validate } = args;
  const primaryModel = selectWriterModel(profile, config);

  const finish = (
    modelUsed: string,
    usedFallback: boolean,
    content: string,
    writerAttempts: number,
    secondAttemptType: "none" | "json_recovery",
  ): WriterOrchestrationResult => {
    const v = validate(content);
    if (!v.ok) {
      return { ok: false, profile, primaryModel, modelUsed, usedFallback, rejection: v.reason, validationReason: v.reason, writerAttempts, secondAttemptType };
    }
    return {
      ok: true,
      profile,
      primaryModel,
      modelUsed,
      usedFallback,
      article: v.article,
      readMinutes: v.readMinutes,
      validationReason: null,
      writerAttempts,
      secondAttemptType,
    };
  };

  const primary = await call(primaryModel);
  if (primary.ok) {
    const first = finish(primaryModel, false, primary.content, 1, "none");
    // Writer JSON-recovery: ONLY when the sole failure is unparseable JSON, make
    // exactly one more call to the SAME primary model with a strict-JSON
    // directive — no fallback/Gemini, no editor attempt consumed. The recovered
    // output is validated the SAME way; a still-invalid or failed recovery
    // rejects safely exactly as before (with the original invalid-JSON reason).
    if (!first.ok && first.validationReason === "writer_output_invalid_json") {
      const recovery = await call(primaryModel, { strictJsonRecovery: true });
      return recovery.ok
        ? finish(primaryModel, false, recovery.content, 2, "json_recovery")
        : { ...first, writerAttempts: 2, secondAttemptType: "json_recovery" };
    }
    return first;
  }

  // Completed-but-invalid (truncated / filtered / non-string content): reject
  // with its specific reason. This is NOT a technical failure — do not fall back.
  if ("completedInvalid" in primary) {
    return { ok: false, profile, primaryModel, modelUsed: primaryModel, usedFallback: false, rejection: primary.reason, validationReason: primary.reason, writerAttempts: 1, secondAttemptType: "none" };
  }

  const tech = classifyTechnicalFailure({
    networkError: primary.networkError,
    timedOut: primary.timedOut,
    httpStatus: primary.httpStatus,
    emptyOrMalformed: primary.emptyOrMalformed,
  });
  // Non-technical hard failure (e.g. HTTP 400/401): do NOT fall back.
  if (!tech) {
    return { ok: false, profile, primaryModel, modelUsed: primaryModel, usedFallback: false, rejection: "writer_error", validationReason: null, writerAttempts: 1, secondAttemptType: "none" };
  }

  // Technical failure: one attempt on the fallback model.
  const fallbackModel = config.fallbackModel;
  const fb = await call(fallbackModel);
  if (!fb.ok) {
    // A completed-but-invalid fallback response rejects with its specific reason;
    // never retry again. A transport failure stays writer_unavailable.
    if ("completedInvalid" in fb) {
      return { ok: false, profile, primaryModel, modelUsed: fallbackModel, usedFallback: true, rejection: fb.reason, validationReason: fb.reason, writerAttempts: 2, secondAttemptType: "none" };
    }
    return { ok: false, profile, primaryModel, modelUsed: fallbackModel, usedFallback: true, rejection: "writer_unavailable", validationReason: null, writerAttempts: 2, secondAttemptType: "none" };
  }
  return finish(fallbackModel, true, fb.content, 2, "none");
}
