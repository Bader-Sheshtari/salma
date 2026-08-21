// ESL authorization + cap safety — unit tests. Run: node --test authz.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedInternal, resolveCap } from "./authz.ts";

test("authz: correct secret is authorized", () => {
  assert.equal(isAuthorizedInternal("s3cret", "s3cret"), true);
});

test("authz: missing header is rejected", () => {
  assert.equal(isAuthorizedInternal(null, "s3cret"), false);
});

test("authz: wrong secret is rejected", () => {
  assert.equal(isAuthorizedInternal("guess", "s3cret"), false);
});

test("authz: empty header is rejected", () => {
  assert.equal(isAuthorizedInternal("", "s3cret"), false);
});

test("authz: unset server secret rejects everyone (fail closed)", () => {
  assert.equal(isAuthorizedInternal("", ""), false);
  assert.equal(isAuthorizedInternal(null, ""), false);
  assert.equal(isAuthorizedInternal("anything", ""), false);
});

test("cap: no override → daily cap", () => {
  assert.equal(resolveCap(undefined, 8), 8);
});

test("cap: caller may lower the cap", () => {
  assert.equal(resolveCap(1, 8), 1);
  assert.equal(resolveCap(7, 8), 7);
});

test("cap: caller can NEVER raise above the server daily cap", () => {
  assert.equal(resolveCap(9, 8), 8);
  assert.equal(resolveCap(9999, 8), 8);
  assert.equal(resolveCap(Number.MAX_SAFE_INTEGER, 8), 8);
});

test("cap: garbage falls back to the daily cap", () => {
  assert.equal(resolveCap(0, 8), 8);
  assert.equal(resolveCap(-5, 8), 8);
  assert.equal(resolveCap(2.5, 8), 8);
  assert.equal(resolveCap("lots", 8), 8);
  assert.equal(resolveCap(null, 8), 8);
  assert.equal(resolveCap(Infinity, 8), 8);
  assert.equal(resolveCap(NaN, 8), 8);
});
