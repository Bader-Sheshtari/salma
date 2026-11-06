// Jamal (جمال) integration — wiring assertions over the SOURCE of index.ts /
// writerRouter.ts / jamal.ts / radar-editorial-select (Rev 2, acceptance 5A:
// routing, draft safety, fallback, no-Radar/ESL-change). Source-text checks,
// same pattern as the existing pipeline wiring tests: they pin the seams that
// module-level tests cannot reach without a Deno runtime.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolvePilotGate, resolveWriterMode } from "./writerRouter.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const indexSrc = read("./index.ts");
const jamalSrc = read("./jamal.ts");
const eslSrc = read("../radar-editorial-select/index.ts");

// ---- Gate (routing + fallback) ----------------------------------------------

test("gate: jamal requires authorization AND the explicit mode; everything else stays exactly legacy", () => {
  assert.equal(resolveWriterMode({ authorized: true, requestedMode: "jamal" }), "jamal");
  assert.equal(resolveWriterMode({ authorized: false, requestedMode: "jamal" }), "legacy");
  assert.equal(resolveWriterMode({ authorized: true, requestedMode: "JAMAL " }), "jamal");
  assert.equal(resolveWriterMode({ authorized: true }), "legacy");
  assert.equal(resolveWriterMode({ authorized: true, requestedMode: "pilot" }), "pilot");
});

test("gate: jamal is single-article bounded exactly like pilot (explicit limit of 1, optional target)", () => {
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedMode: "jamal", requestedLimit: 1 }),
    { mode: "jamal", limit: 1 },
  );
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedMode: "jamal" }),
    { mode: "rejected", reason: "pilot_limit_must_be_1" },
  );
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedMode: "jamal", requestedLimit: 7 }),
    { mode: "rejected", reason: "pilot_limit_must_be_1" },
  );
  assert.deepEqual(
    resolvePilotGate({
      authorized: true,
      requestedMode: "jamal",
      requestedLimit: 1,
      requestedSourceUrl: "https://example.test/a",
    }),
    { mode: "jamal", limit: 1, sourceUrl: "https://example.test/a" },
  );
  // Pilot contract unchanged (fallback path intact).
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedMode: "pilot", requestedLimit: 1 }),
    { mode: "pilot", limit: 1 },
  );
});

// ---- index.ts wiring ----------------------------------------------------------

test("index wiring: jamal mode dispatches to writeJamalArticle with the injected chatJson transport", () => {
  assert.ok(indexSrc.includes('if (writerMode === "jamal") {'));
  assert.ok(indexSrc.includes("writeJamalArticle({"));
  assert.ok(indexSrc.includes("model: jamalModel(),"));
  assert.ok(indexSrc.includes("config: JAMAL_ACTIVE_CONFIG,"));
  // Entry mapping accepts the jamal gate outcome.
  assert.ok(indexSrc.includes('gate.mode === "pilot" || gate.mode === "jamal"'));
  // Sidecar inserts on BOTH outcomes (success with content id, rejection with null).
  assert.ok(indexSrc.includes("await insertJamalRun(jamalRun, insertedId)"));
  assert.ok(indexSrc.includes("await insertJamalRun(jamalRun, null)"));
});

test("index wiring: the legacy branch gate is untouched and jamal-mode runs assert Jamal's model config", () => {
  assert.ok(indexSrc.includes('if (writerMode === "legacy") {'));
  assert.ok(indexSrc.includes('if (writerMode === "jamal") assertEditorConfig(jamalModel());'));
});

// ---- Draft safety: Jamal's module is DB-free and publish-free ------------------

test("draft safety: jamal.ts performs no DB access and contains no status/publish writes", () => {
  assert.ok(!jamalSrc.includes(".from("), "jamal.ts must not touch the database");
  assert.ok(!jamalSrc.includes("createClient"), "jamal.ts must not create a DB client");
  assert.ok(!jamalSrc.includes('"published"'), "jamal.ts must not reference the published status");
  assert.ok(!jamalSrc.includes("status:"), "jamal.ts must not set any status field");
  // Isolated env surface: the ONLY env variable Jamal reads is its own model
  // var (comments may MENTION the shared vars; reading them is what is barred).
  assert.ok(jamalSrc.includes('get("OPENROUTER_JAMAL_MODEL")'));
  assert.ok(!jamalSrc.includes('get("OPENROUTER_EDITOR_MODEL")'));
  assert.ok(!jamalSrc.includes('get("OPENROUTER_WRITER'));
});

// ---- No Radar/ESL change --------------------------------------------------------

test("ESL untouched: radar-editorial-select still promotes with writer_mode pilot and never jamal", () => {
  assert.ok(eslSrc.includes('writer_mode: "pilot"'));
  assert.ok(!eslSrc.toLowerCase().includes("jamal"));
});
