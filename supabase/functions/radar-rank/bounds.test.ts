// radar-rank bounded-work helpers — unit tests. Run: node --test bounds.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveRowCap } from "./bounds.ts";

test("bounds: no caller limit → server max", () => {
  assert.equal(resolveRowCap(undefined, 120), 120);
  assert.equal(resolveRowCap(null, 120), 120);
});

test("bounds: caller may lower the cap", () => {
  assert.equal(resolveRowCap(30, 120), 30);
  assert.equal(resolveRowCap(1, 120), 1);
  assert.equal(resolveRowCap(119, 120), 119);
});

test("bounds: caller can NEVER exceed the server max (I: oversized request)", () => {
  assert.equal(resolveRowCap(121, 120), 120);
  assert.equal(resolveRowCap(9999, 120), 120);
  assert.equal(resolveRowCap(Number.MAX_SAFE_INTEGER, 120), 120);
});

test("bounds: garbage falls back to the server max", () => {
  assert.equal(resolveRowCap(0, 120), 120);
  assert.equal(resolveRowCap(-5, 120), 120);
  assert.equal(resolveRowCap(2.5, 120), 120);
  assert.equal(resolveRowCap("lots", 120), 120);
  assert.equal(resolveRowCap(Infinity, 120), 120);
  assert.equal(resolveRowCap(NaN, 120), 120);
});
