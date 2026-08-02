// Controlled checks for the E1.2 audit-integrity finalization (mandatory audit +
// safe rollback). Pure module (no Deno/Supabase), runnable under `deno test` or
// node:test.

import test from "node:test";
import assert from "node:assert/strict";
import { finalizeRun, selectRollbackTargets } from "./runFinalize.ts";
import { DRAFT_STATUS } from "./registry.ts";

// --- finalizeRun ----------------------------------------------------------

test("a decision-log insert failure cannot produce a successful run", async () => {
  let cleaned = false;
  const out = await finalizeRun({
    phaseError: null,
    createdIds: ["c1", "c2"],
    persist: async () => ({ ok: false, error: "insert timeout" }),
    cleanupCreated: async () => {
      cleaned = true;
      return { ok: true };
    },
  });
  assert.equal(out.status, "error"); // never "success"
  assert.ok(out.throwMessage); // caller is forced to throw -> error returned
  assert.ok(out.throwMessage!.includes("audit_log_failed"));
  assert.equal(cleaned, true); // it attempted to protect created content
});

test("when audit fails and cleanup succeeds, created ids are cleared (rolled back)", async () => {
  const out = await finalizeRun({
    phaseError: null,
    createdIds: ["c1", "c2"],
    persist: async () => ({ ok: false, error: "boom" }),
    cleanupCreated: async () => ({ ok: true }),
  });
  assert.equal(out.status, "error");
  assert.deepEqual(out.createdIds, []); // rows removed -> nothing left to recover
  assert.ok(out.error!.includes("rolled back 2 created draft(s)"));
});

test("when audit fails and cleanup ALSO fails, created ids are preserved for recovery", async () => {
  const out = await finalizeRun({
    phaseError: null,
    createdIds: ["c1", "c2", "c3"],
    persist: async () => ({ ok: false, error: "boom" }),
    cleanupCreated: async () => ({ ok: false, error: "delete denied" }),
  });
  assert.equal(out.status, "error");
  assert.deepEqual(out.createdIds, ["c1", "c2", "c3"]); // preserved for the admin
  assert.ok(out.error!.includes("cleanup_failed"));
  assert.ok(out.error!.includes("preserved for manual recovery"));
});

test("a normal successful run is unchanged (success, audit written, ids kept, no throw)", async () => {
  let cleaned = false;
  const out = await finalizeRun({
    phaseError: null,
    createdIds: ["c1", "c2"],
    persist: async () => ({ ok: true }),
    cleanupCreated: async () => {
      cleaned = true;
      return { ok: true };
    },
  });
  assert.equal(out.status, "success");
  assert.deepEqual(out.createdIds, ["c1", "c2"]); // created drafts retained
  assert.equal(out.throwMessage, undefined); // caller does not throw
  assert.equal(cleaned, false); // rollback never runs on a healthy run
});

test("a phase failure stays an error, preserves ids, and never triggers rollback", async () => {
  let cleaned = false;
  const out = await finalizeRun({
    phaseError: new Error("network down"),
    createdIds: ["c1"],
    persist: async () => ({ ok: true }),
    cleanupCreated: async () => {
      cleaned = true;
      return { ok: true };
    },
  });
  assert.equal(out.status, "error");
  assert.equal(out.error, "network down");
  assert.deepEqual(out.createdIds, ["c1"]); // preserved; caller re-throws original
  assert.equal(out.throwMessage, undefined); // index.ts re-throws phaseError itself
  assert.equal(cleaned, false);
});

test("audit is still attempted (and noted) when a phase already failed", async () => {
  const out = await finalizeRun({
    phaseError: new Error("network down"),
    createdIds: [],
    persist: async () => ({ ok: false, error: "audit db gone" }),
    cleanupCreated: async () => ({ ok: true }),
  });
  assert.equal(out.status, "error");
  assert.ok(out.error!.includes("network down"));
  assert.ok(out.error!.includes("audit_log_failed: audit db gone"));
});

// --- selectRollbackTargets (rollback guard) -------------------------------

test("rollback targets only THIS run's pending AI drafts", () => {
  const rows = [
    { id: "new1", origin: "ai", status: DRAFT_STATUS }, // created this run, pending
    { id: "new2", origin: "ai", status: DRAFT_STATUS }, // created this run, pending
  ];
  const targets = selectRollbackTargets(rows, ["new1", "new2"], DRAFT_STATUS);
  assert.deepEqual(targets.sort(), ["new1", "new2"]);
});

test("existing and published content is never deleted by a rollback", () => {
  const rows = [
    { id: "new1", origin: "ai", status: DRAFT_STATUS }, // eligible
    { id: "pub1", origin: "ai", status: "published" }, // published since insert -> keep
    { id: "old1", origin: "ai", status: DRAFT_STATUS }, // pre-existing (not in createdIds)
    { id: "man1", origin: "manual", status: DRAFT_STATUS }, // editor-written -> keep
  ];
  // createdIds only contains the drafts this run inserted.
  const targets = selectRollbackTargets(rows, ["new1", "pub1"], DRAFT_STATUS);
  // pub1 excluded (published), old1 excluded (not created this run), man1 excluded
  // (not AI + not created this run). Only new1 remains.
  assert.deepEqual(targets, ["new1"]);
});

test("accepted content is the pending draft status, so rollback keys off DRAFT_STATUS", () => {
  // Accepted/created content is always written as DRAFT_STATUS (pending); the
  // rollback guard therefore protects anything that has moved off that status.
  assert.equal(DRAFT_STATUS, "pending");
  const rows = [{ id: "x", origin: "ai", status: "pending" }];
  assert.deepEqual(selectRollbackTargets(rows, ["x"], DRAFT_STATUS), ["x"]);
});
