// Post-editor source-fidelity repair stage (editorial-policy alignment).
//
// Policy: Salma trusts a registered source as the authority on the facts. It must
// NOT independently re-prove medical truth; its only fidelity duty is to make the
// Arabic article faithful to the extracted source — no invented numbers, quotes,
// claims, causes, actions, or advice. Where the writer/editor added a detail the
// source does not support, a SINGLE constrained repair may remove/correct/rewrite
// it using ONLY the source. This module is pure (no Deno/Node/network APIs, no
// model transport) so it runs under Node TS type-stripping and `deno test`; the
// live repair call and validation are injected by index.ts.
//
// The pipeline this module finalizes (see finalizeWriterDraft):
//   writer draft → Editorial Director → source-fidelity validation →
//   exactly one constrained repair when eligible → final source-fidelity
//   validation → clean | needs_human_review (pending) | reject.
// It NEVER publishes: the only outcomes are clean / needs_human_review / reject,
// and clean/needs_human_review both result in a PENDING draft downstream.

/** The article shape carried through editing/repair (structurally identical to
 *  salmaEditor.EditorArticle). Kept local so this module has no import-time deps. */
export type FidelityArticle = {
  title: string;
  excerpt: string;
  summary: string;
  body: string;
};

/** Result of the injected source-fidelity validator. `errors` are the blocking
 *  codes from salmaWriter.validateArticle (ok === errors.length === 0). The clean
 *  (brand-stripped) title and reading time are carried so the persisted draft
 *  matches the writer path exactly. */
export type FidelityValidation = {
  ok: boolean;
  errors: string[];
  cleanTitle: string;
  readMinutes: number;
};

/** The injected constrained-repair transport. It receives the exact fidelity
 *  issues to fix plus the current draft and returns a repaired draft, or a reason
 *  string on a transport/parse failure. Called AT MOST ONCE per finalization. */
export type FidelityRepairCall = (
  issues: string[],
  draft: FidelityArticle,
) => Promise<{ ok: true; article: FidelityArticle } | { ok: false; reason: string }>;

export type FidelityClass = "repairable" | "omission" | "blocking";

// Repairable fidelity breaches: an ungrounded number/date, an unsupported
// efficacy/approval claim, or an invented direct quotation. Exactly ONE
// constrained repair may delete/correct/rewrite the addition using only the
// source. If the code still appears at final validation, the article is rejected.
export const REPAIRABLE_FIDELITY_PREFIXES = [
  "unsupported_number",
  "unsupported_claim",
  "invented_quotation",
] as const;

// Omission-completeness breaches: the source stated an official action / an
// unaffected-batch statement that the draft dropped. The single repair may
// restore it from the source; if it is STILL absent afterwards the article is NOT
// rejected for the omission alone — it becomes pending with needs_human_review and
// the warning is preserved in the audit.
export const OMISSION_FIDELITY_PREFIXES = [
  "missing_official_action",
  "missing_unaffected_batch_statement",
] as const;

// Hard-blocking breaches: never auto-repaired. If present at final validation the
// article is rejected (no pending draft is created). These protect source
// authenticity / no-invention / essential-entity guarantees.
export const HARD_BLOCKING_FIDELITY_PREFIXES = [
  "malformed_output",
  "invented_official_action",
  "audience_misdirected_action",
  "association_as_causation",
  "missing_essential_entity",
] as const;

const matchesPrefix = (code: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => code === p || code.startsWith(`${p}:`));

/** Classify a single fidelity error code. Unknown codes fail CLOSED (blocking) so
 *  a new validator error can never silently become auto-repairable/pending. */
export function classifyFidelityError(code: string): FidelityClass {
  if (matchesPrefix(code, HARD_BLOCKING_FIDELITY_PREFIXES)) return "blocking";
  if (matchesPrefix(code, REPAIRABLE_FIDELITY_PREFIXES)) return "repairable";
  if (matchesPrefix(code, OMISSION_FIDELITY_PREFIXES)) return "omission";
  return "blocking";
}

export type FidelityAssessment = {
  blocking: string[];
  repairable: string[];
  omission: string[];
};

/** Bucket a validator `errors` array into the three fidelity classes. */
export function assessFidelityErrors(errors: string[]): FidelityAssessment {
  const blocking: string[] = [];
  const repairable: string[] = [];
  const omission: string[] = [];
  for (const code of errors) {
    const cls = classifyFidelityError(code);
    if (cls === "blocking") blocking.push(code);
    else if (cls === "repairable") repairable.push(code);
    else omission.push(code);
  }
  return { blocking, repairable, omission };
}

export type FidelityDecision = "clean" | "needs_human_review" | "reject";

/** Compact, PII-free fidelity-repair audit. Surfaced in the pilot HTTP report
 *  (like the editorial audit); no raw model text or secrets. Preserves the full
 *  decision trail the policy requires: original error, repair attempt, repair
 *  outcome, final validation, and needs_human_review. */
export type FidelityRepairAudit = {
  original_errors: string[];
  original_blocking: string[];
  original_repairable: string[];
  original_omission: string[];
  repair_eligible: boolean;
  repair_attempted: boolean;
  repair_issues: string[];
  repair_call_succeeded: boolean;
  repair_failure_reason: string | null;
  final_errors: string[];
  final_validation_result: "passed" | "failed" | "needs_human_review";
  needs_human_review: boolean;
  needs_human_review_reason: string[];
  decision: FidelityDecision;
  rejection_reason: string | null;
  draft_source: "original" | "repaired";
};

export type FidelityRepairResult = {
  decision: FidelityDecision;
  article: FidelityArticle;
  readMinutes: number;
  cleanTitle: string;
  rejectionReason: string | null;
  audit: FidelityRepairAudit;
};

/**
 * Run the post-editor source-fidelity stage over an already-edited draft.
 *
 * Guarantees:
 *   - AT MOST ONE call to `repair` (no loops, no fallback expansion).
 *   - Hard-blocking errors are NEVER repaired and always reject.
 *   - A repairable error still present after the single repair rejects.
 *   - An omission still absent after the single repair does NOT reject on its own:
 *     the draft becomes pending with needs_human_review, warning preserved.
 *   - Never returns a "publish" decision — all outcomes are pending or rejected.
 */
export async function orchestrateFidelityRepair(args: {
  draft: FidelityArticle;
  readMinutes: number;
  validate: (a: FidelityArticle) => FidelityValidation;
  repair: FidelityRepairCall;
}): Promise<FidelityRepairResult> {
  const { draft, validate, repair } = args;

  const v0 = validate(draft);
  const a0 = assessFidelityErrors(v0.errors);
  const base = {
    original_errors: v0.errors,
    original_blocking: a0.blocking,
    original_repairable: a0.repairable,
    original_omission: a0.omission,
  };

  // Clean on first validation — nothing to repair.
  if (v0.ok) {
    return {
      decision: "clean",
      article: draft,
      readMinutes: v0.readMinutes || args.readMinutes,
      cleanTitle: v0.cleanTitle || draft.title,
      rejectionReason: null,
      audit: {
        ...base,
        repair_eligible: false,
        repair_attempted: false,
        repair_issues: [],
        repair_call_succeeded: false,
        repair_failure_reason: null,
        final_errors: [],
        final_validation_result: "passed",
        needs_human_review: false,
        needs_human_review_reason: [],
        decision: "clean",
        rejection_reason: null,
        draft_source: "original",
      },
    };
  }

  // Any hard-blocking error → reject immediately (no repair spent).
  if (a0.blocking.length) {
    return {
      decision: "reject",
      article: draft,
      readMinutes: v0.readMinutes || args.readMinutes,
      cleanTitle: v0.cleanTitle || draft.title,
      rejectionReason: a0.blocking[0],
      audit: {
        ...base,
        repair_eligible: false,
        repair_attempted: false,
        repair_issues: [],
        repair_call_succeeded: false,
        repair_failure_reason: null,
        final_errors: v0.errors,
        final_validation_result: "failed",
        needs_human_review: false,
        needs_human_review_reason: [],
        decision: "reject",
        rejection_reason: a0.blocking[0],
        draft_source: "original",
      },
    };
  }

  // Only repairable and/or omission errors → exactly ONE constrained repair.
  const issues = [...a0.repairable, ...a0.omission];
  const rep = await repair(issues, draft);

  // The repair transport failed (call/parse). Decide from the ORIGINAL errors:
  // a repairable breach that could not be fixed rejects; an omission alone
  // becomes needs_human_review (pending).
  if (!rep.ok) {
    if (a0.repairable.length) {
      return {
        decision: "reject",
        article: draft,
        readMinutes: v0.readMinutes || args.readMinutes,
        cleanTitle: v0.cleanTitle || draft.title,
        rejectionReason: a0.repairable[0],
        audit: {
          ...base,
          repair_eligible: true,
          repair_attempted: true,
          repair_issues: issues,
          repair_call_succeeded: false,
          repair_failure_reason: rep.reason,
          final_errors: v0.errors,
          final_validation_result: "failed",
          needs_human_review: false,
          needs_human_review_reason: [],
          decision: "reject",
          rejection_reason: a0.repairable[0],
          draft_source: "original",
        },
      };
    }
    return {
      decision: "needs_human_review",
      article: draft,
      readMinutes: v0.readMinutes || args.readMinutes,
      cleanTitle: v0.cleanTitle || draft.title,
      rejectionReason: null,
      audit: {
        ...base,
        repair_eligible: true,
        repair_attempted: true,
        repair_issues: issues,
        repair_call_succeeded: false,
        repair_failure_reason: rep.reason,
        final_errors: a0.omission,
        final_validation_result: "needs_human_review",
        needs_human_review: true,
        needs_human_review_reason: a0.omission,
        decision: "needs_human_review",
        rejection_reason: null,
        draft_source: "original",
      },
    };
  }

  // Repair produced a draft — run the FULL fidelity validation again over it.
  const v1 = validate(rep.article);
  const a1 = assessFidelityErrors(v1.errors);

  if (v1.ok) {
    return {
      decision: "clean",
      article: rep.article,
      readMinutes: v1.readMinutes || args.readMinutes,
      cleanTitle: v1.cleanTitle || rep.article.title,
      rejectionReason: null,
      audit: {
        ...base,
        repair_eligible: true,
        repair_attempted: true,
        repair_issues: issues,
        repair_call_succeeded: true,
        repair_failure_reason: null,
        final_errors: [],
        final_validation_result: "passed",
        needs_human_review: false,
        needs_human_review_reason: [],
        decision: "clean",
        rejection_reason: null,
        draft_source: "repaired",
      },
    };
  }

  // A hard-blocking or still-present repairable error after the single repair →
  // reject (no second repair, no loop).
  if (a1.blocking.length || a1.repairable.length) {
    const reason = a1.blocking[0] ?? a1.repairable[0];
    return {
      decision: "reject",
      article: rep.article,
      readMinutes: v1.readMinutes || args.readMinutes,
      cleanTitle: v1.cleanTitle || rep.article.title,
      rejectionReason: reason,
      audit: {
        ...base,
        repair_eligible: true,
        repair_attempted: true,
        repair_issues: issues,
        repair_call_succeeded: true,
        repair_failure_reason: null,
        final_errors: v1.errors,
        final_validation_result: "failed",
        needs_human_review: false,
        needs_human_review_reason: [],
        decision: "reject",
        rejection_reason: reason,
        draft_source: "repaired",
      },
    };
  }

  // Only omission errors remain after the single repair → pending with
  // needs_human_review; the omission warning is preserved (never a rejection).
  return {
    decision: "needs_human_review",
    article: rep.article,
    readMinutes: v1.readMinutes || args.readMinutes,
    cleanTitle: v1.cleanTitle || rep.article.title,
    rejectionReason: null,
    audit: {
      ...base,
      repair_eligible: true,
      repair_attempted: true,
      repair_issues: issues,
      repair_call_succeeded: true,
      repair_failure_reason: null,
      final_errors: a1.omission,
      final_validation_result: "needs_human_review",
      needs_human_review: true,
      needs_human_review_reason: a1.omission,
      decision: "needs_human_review",
      rejection_reason: null,
      draft_source: "repaired",
    },
  };
}

/**
 * Finalize a writer draft in the approved order: run the Editorial Director
 * FIRST (so it improves headline/lead/compression/Arabic style/attribution and
 * removes unnecessary additions BEFORE any fidelity rejection), then run the
 * source-fidelity stage (validate → one constrained repair → final validate).
 *
 * Generic over the editor audit type `E` so this module stays free of editorial
 * specifics. index.ts injects the real Editorial Director + validator + repair;
 * tests inject spies to assert ordering and the one-repair-call guarantee.
 */
export async function finalizeWriterDraft<E>(args: {
  runEditor: () => Promise<{ article: FidelityArticle; readMinutes: number; audit: E }>;
  validate: (a: FidelityArticle) => FidelityValidation;
  repair: FidelityRepairCall;
}): Promise<{ editorial: E; fidelity: FidelityRepairResult }> {
  const editor = await args.runEditor();
  const fidelity = await orchestrateFidelityRepair({
    draft: editor.article,
    readMinutes: editor.readMinutes,
    validate: args.validate,
    repair: args.repair,
  });
  return { editorial: editor.audit, fidelity };
}
