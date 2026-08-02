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
  | { mode: "pilot"; limit: 1 }
  | { mode: "rejected"; reason: string };

// The only pilot_limit the first controlled pilot accepts.
export const FIRST_PILOT_LIMIT = 1;

/** Parse an explicit pilot_limit: the number 1 or the string "1" → 1; else null. */
function parsePilotLimit(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
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
}): PilotGateDecision {
  if (resolveWriterMode({ authorized: input.authorized, requestedMode: input.requestedMode }) !== "pilot") {
    return { mode: "legacy" };
  }
  const limit = parsePilotLimit(input.requestedLimit);
  if (limit !== FIRST_PILOT_LIMIT) return { mode: "rejected", reason: "pilot_limit_must_be_1" };
  return { mode: "pilot", limit: FIRST_PILOT_LIMIT };
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

// Raw result of a single writer HTTP call, shaped so the technical-failure
// classifier can decide fallback eligibility. The actual fetch lives in
// index.ts; this module stays import-free and unit-testable with a fake call.
export type WriterHttpResult =
  | { ok: true; content: string }
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
  | { ok: true; article: { title: string; excerpt: string; body: string }; readMinutes: number }
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
  article?: { title: string; excerpt: string; body: string };
  readMinutes?: number;
  // Decision `rejection_reason` when ok=false.
  rejection?: string;
  // Audit `writer_validation_reason`: set only on a factual/parse validation
  // failure (never on a technical/transport failure).
  validationReason: string | null;
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
  call: (model: string) => Promise<WriterHttpResult>;
  validate: (content: string) => WriterValidation;
}): Promise<WriterOrchestrationResult> {
  const { profile, config, call, validate } = args;
  const primaryModel = selectWriterModel(profile, config);

  const finish = (
    modelUsed: string,
    usedFallback: boolean,
    content: string,
  ): WriterOrchestrationResult => {
    const v = validate(content);
    if (!v.ok) {
      return { ok: false, profile, primaryModel, modelUsed, usedFallback, rejection: v.reason, validationReason: v.reason };
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
    };
  };

  const primary = await call(primaryModel);
  if (primary.ok) return finish(primaryModel, false, primary.content);

  const tech = classifyTechnicalFailure({
    networkError: primary.networkError,
    timedOut: primary.timedOut,
    httpStatus: primary.httpStatus,
    emptyOrMalformed: primary.emptyOrMalformed,
  });
  // Non-technical hard failure (e.g. HTTP 400/401): do NOT fall back.
  if (!tech) {
    return { ok: false, profile, primaryModel, modelUsed: primaryModel, usedFallback: false, rejection: "writer_error", validationReason: null };
  }

  // Technical failure: one attempt on the fallback model.
  const fallbackModel = config.fallbackModel;
  const fb = await call(fallbackModel);
  if (!fb.ok) {
    return { ok: false, profile, primaryModel, modelUsed: fallbackModel, usedFallback: true, rejection: "writer_unavailable", validationReason: null };
  }
  return finish(fallbackModel, true, fb.content);
}
