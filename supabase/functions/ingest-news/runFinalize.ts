// E1.2 — run finalization & audit-integrity logic (pure, no Deno/Supabase).
//
// The ingestion audit trail (ingestion_decisions) is MANDATORY, not best-effort:
// a run that could not persist its decisions must NOT report success. This module
// holds the deterministic decision logic so it can be unit-tested in isolation
// (index.ts only wires in the real Supabase side effects).

export type PersistResult = { ok: boolean; error?: string };
export type CleanupResult = { ok: boolean; error?: string };

export type RunFinalUpdate = {
  status: "success" | "error";
  // Human-readable detail written to ingestion_runs.error on failure.
  error?: string;
  // What to write to ingestion_runs.created_ids: empty once rolled back, or the
  // still-orphaned ids preserved for manual recovery.
  createdIds: string[];
  // When set, the caller must throw so a failure is returned to the invoker.
  // (For a phase error the caller re-throws the original error instead.)
  throwMessage?: string;
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Decide the terminal state of a run. `persist` is ALWAYS attempted (audit is
// recorded on both the success and error paths). If the phases already failed,
// the original error dominates and created ids are preserved. Otherwise a failed
// mandatory audit forces an error status: the run first tries to roll back the
// content it created this run, and only preserves those ids if cleanup fails.
export async function finalizeRun(input: {
  phaseError: unknown;
  createdIds: string[];
  persist: () => Promise<PersistResult>;
  cleanupCreated: () => Promise<CleanupResult>;
}): Promise<RunFinalUpdate> {
  const persist = await input.persist();

  if (input.phaseError != null) {
    // A phase already failed; audit is still attempted but best-effort here.
    const auditNote = persist.ok ? "" : `; audit_log_failed: ${persist.error}`;
    return {
      status: "error",
      error: messageOf(input.phaseError) + auditNote,
      createdIds: input.createdIds, // preserve for admin recovery
      // caller re-throws the original phase error
    };
  }

  if (!persist.ok) {
    // Mandatory audit failed on an otherwise-successful run: do not report a
    // misleading success. Try to remove the pending drafts this run created.
    const cleanup = await input.cleanupCreated();
    if (cleanup.ok) {
      return {
        status: "error",
        error: `audit_log_failed: ${persist.error}; rolled back ${input.createdIds.length} created draft(s)`,
        createdIds: [], // successfully removed
        throwMessage: `audit_log_failed: ${persist.error}`,
      };
    }
    return {
      status: "error",
      error:
        `audit_log_failed: ${persist.error}; cleanup_failed: ${cleanup.error}; ` +
        `created_ids preserved for manual recovery`,
      createdIds: input.createdIds, // preserve for admin recovery
      throwMessage: `audit_log_failed: ${persist.error}`,
    };
  }

  return { status: "success", createdIds: input.createdIds };
}

// Single source of truth for WHICH content rows a rollback may delete. Only rows
// that (a) were created during THIS run, (b) are AI-origin, and (c) are still the
// pending draft status qualify. This guarantees previously-existing content and
// anything an editor has since published is never touched. index.ts fetches the
// createdIds rows and deletes exactly the ids this returns.
export function selectRollbackTargets(
  rows: { id: string; origin: string | null; status: string | null }[],
  createdIds: string[],
  draftStatus: string,
): string[] {
  const created = new Set(createdIds);
  return rows
    .filter((r) => created.has(r.id) && r.origin === "ai" && r.status === draftStatus)
    .map((r) => r.id);
}
