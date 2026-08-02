// E1.3C/D — controlled pilot-gate tests (pure, NO live calls, NO Deno/Supabase).
// Runs under Node's native TS type stripping (`node pilotGate.test.ts`) or
// `deno test`.
//
// These lock the gating contract that keeps the verified-source Salma writer OFF
// for the scheduled cron and reachable ONLY by an explicitly authorized manual
// pilot request. The gate itself is the pure resolveWriterMode; the pending/ai
// content invariant is asserted against the shared writer/legacy insert payload
// shape (status/origin/type are identical in both modes).

import test from "node:test";
import assert from "node:assert/strict";
import {
  processRepresentativesWithLimit,
  resolvePilotGate,
  resolveWriterMode,
  type CommitOutcome,
  type WriterMode,
} from "./writerRouter.ts";
import { DRAFT_STATUS } from "./registry.ts";

// --- resolveWriterMode: authorization + explicit opt-in --------------------

test("the default cron request (no body, no flag) stays legacy", () => {
  // pg_cron invokes with the ingest secret and no JSON body → requestedMode
  // is undefined → legacy.
  assert.equal(resolveWriterMode({ authorized: true, requestedMode: undefined }), "legacy");
  assert.equal(resolveWriterMode({ authorized: true }), "legacy");
});

test("an authorized request must EXPLICITLY ask for pilot to get it", () => {
  assert.equal(resolveWriterMode({ authorized: true, requestedMode: "pilot" }), "pilot");
  assert.equal(resolveWriterMode({ authorized: true, requestedMode: "legacy" }), "legacy");
  assert.equal(resolveWriterMode({ authorized: true, requestedMode: "anything-else" }), "legacy");
});

test("an UNAUTHORIZED caller can never activate pilot, even asking for it", () => {
  assert.equal(resolveWriterMode({ authorized: false, requestedMode: "pilot" }), "legacy");
  assert.equal(resolveWriterMode({ authorized: false, requestedMode: "PILOT" }), "legacy");
  assert.equal(resolveWriterMode({ authorized: false }), "legacy");
});

test("the pilot flag is matched case-insensitively and trimmed", () => {
  assert.equal(resolveWriterMode({ authorized: true, requestedMode: "  PILOT  " }), "pilot");
  assert.equal(resolveWriterMode({ authorized: true, requestedMode: "Pilot" }), "pilot");
});

test("a non-string writer_mode is ignored (stays legacy)", () => {
  for (const bad of [1, true, null, {}, ["pilot"]] as unknown[]) {
    assert.equal(resolveWriterMode({ authorized: true, requestedMode: bad }), "legacy", String(bad));
  }
});

// --- content invariant: pending/ai/news in BOTH modes ----------------------

// The insert payload shape shared by the legacy and pilot paths in index.ts:
// whatever the body provenance, a created draft is ALWAYS pending / ai / news.
// This mirrors the exact literals index.ts writes so a regression there (e.g. a
// pilot draft published automatically) would break this test.
function insertPayload(mode: WriterMode, article: { title: string; excerpt: string; body: string }) {
  return {
    title: article.title,
    type: "news" as const,
    status: DRAFT_STATUS,
    origin: "ai" as const,
    excerpt: article.excerpt || null,
    body: article.body || null,
    _mode: mode, // provenance marker only; not persisted
  };
}

test("legacy and pilot drafts are both pending / ai / news (never auto-published)", () => {
  const legacy = insertPayload("legacy", { title: "خبر", excerpt: "م", body: "نص الاكتشاف" });
  const pilot = insertPayload("pilot", { title: "خبر", excerpt: "م", body: "نص مُتحقَّق منه" });
  for (const p of [legacy, pilot]) {
    assert.equal(p.status, DRAFT_STATUS);
    assert.equal(p.status, "pending");
    assert.equal(p.origin, "ai");
    assert.equal(p.type, "news");
  }
});

// --- E1.3E single-article pilot gate: resolvePilotGate ---------------------

test("resolvePilotGate: the default cron request (no mode/limit) stays legacy", () => {
  assert.deepEqual(resolvePilotGate({ authorized: true }), { mode: "legacy" });
  assert.deepEqual(resolvePilotGate({ authorized: true, requestedMode: "legacy" }), { mode: "legacy" });
});

test("resolvePilotGate: an authorized pilot request with pilot_limit=1 runs the pilot", () => {
  assert.deepEqual(resolvePilotGate({ authorized: true, requestedMode: "pilot", requestedLimit: 1 }), { mode: "pilot", limit: 1 });
  // the string "1" is also accepted (query/JSON coercion)
  assert.deepEqual(resolvePilotGate({ authorized: true, requestedMode: "pilot", requestedLimit: "1" }), { mode: "pilot", limit: 1 });
});

test("resolvePilotGate: a pilot request with a missing or >1 limit is REJECTED, never clamped", () => {
  for (const bad of [undefined, 0, 2, 5, 50, "2", 1.5, -1, null, {}, true] as unknown[]) {
    assert.deepEqual(
      resolvePilotGate({ authorized: true, requestedMode: "pilot", requestedLimit: bad }),
      { mode: "rejected", reason: "pilot_limit_must_be_1" },
      String(bad),
    );
  }
});

test("resolvePilotGate: an UNAUTHORIZED caller can never reach pilot, even with limit=1", () => {
  assert.deepEqual(resolvePilotGate({ authorized: false, requestedMode: "pilot", requestedLimit: 1 }), { mode: "legacy" });
});

// --- E1.3E bounded processing: processRepresentativesWithLimit -------------

// A minimal representative whose commit reports whether it reached the fetch stage.
type Rep = { id: number; reaches: boolean };
function commitOf(log: number[]): (rep: Rep) => Promise<CommitOutcome<number>> {
  return (rep) => {
    log.push(rep.id);
    return Promise.resolve({ reachedFetchStage: rep.reaches, result: rep.id });
  };
}

test("limit=1 stops after the FIRST representative that reaches the fetch stage", async () => {
  const log: number[] = [];
  const skipped: number[] = [];
  const reps: Rep[] = [{ id: 1, reaches: true }, { id: 2, reaches: true }, { id: 3, reaches: true }];
  const r = await processRepresentativesWithLimit<Rep, number>({
    representatives: reps,
    limit: 1,
    commit: commitOf(log),
    onSkipped: (rep) => skipped.push(rep.id),
  });
  assert.deepEqual(log, [1]); // only the first was processed
  assert.deepEqual(skipped, [2, 3]); // the rest were deferred, not silently dropped
  assert.deepEqual(r, { processed: 1, fetchStageCount: 1 });
});

test("limit=1 keeps looking past pre-fetch rejections until one reaches the fetch stage", async () => {
  // Reps 1 and 2 are rejected BEFORE the fetch stage (e.g. duplicates); rep 3 is
  // the real pilot candidate. The single slot is consumed by rep 3, not rep 1.
  const log: number[] = [];
  const skipped: number[] = [];
  const reps: Rep[] = [{ id: 1, reaches: false }, { id: 2, reaches: false }, { id: 3, reaches: true }, { id: 4, reaches: true }];
  const r = await processRepresentativesWithLimit<Rep, number>({
    representatives: reps,
    limit: 1,
    commit: commitOf(log),
    onSkipped: (rep) => skipped.push(rep.id),
  });
  assert.deepEqual(log, [1, 2, 3]); // processed until the first fetch-stage candidate
  assert.deepEqual(skipped, [4]);
  assert.deepEqual(r, { processed: 3, fetchStageCount: 1 });
});

test("limit=null (legacy/cron) processes every representative, unchanged", async () => {
  const log: number[] = [];
  const reps: Rep[] = [{ id: 1, reaches: false }, { id: 2, reaches: false }, { id: 3, reaches: false }];
  const r = await processRepresentativesWithLimit<Rep, number>({
    representatives: reps,
    limit: null,
    commit: commitOf(log),
  });
  assert.deepEqual(log, [1, 2, 3]);
  assert.deepEqual(r, { processed: 3, fetchStageCount: 0 });
});
