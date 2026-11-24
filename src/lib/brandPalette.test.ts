// Palette integrity: 12 official families × 10 official tints, transcribed
// from the brand guideline (pages 11–14). Runs on plain Node: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BRAND_FAMILIES, FAMILY_KEYS, TINT_STEPS, contrast } from "./brandPalette.ts";

test("12 families, each with the 10 official steps and well-formed hexes", () => {
  assert.equal(FAMILY_KEYS.length, 12);
  for (const k of FAMILY_KEYS) {
    const f = BRAND_FAMILIES[k];
    assert.equal(f.key, k);
    assert.ok(f.ar && f.en);
    assert.deepEqual(Object.keys(f.tints).map(Number).sort((a, b) => b - a), [...TINT_STEPS]);
    for (const t of TINT_STEPS) assert.match(f.tints[t], /^#[0-9A-F]{6}$/, `${k}-${t}`);
  }
});

test("no duplicate hex across the 120 official values", () => {
  const all = FAMILY_KEYS.flatMap((k) => TINT_STEPS.map((t) => BRAND_FAMILIES[k].tints[t]));
  assert.equal(all.length, 120);
  assert.equal(new Set(all).size, 120);
});

test("guideline anchors: primary/secondary base colours", () => {
  const base = Object.fromEntries(FAMILY_KEYS.map((k) => [k, BRAND_FAMILIES[k].tints[100]]));
  assert.deepEqual(base, {
    amethyst: "#1D0446", mauve: "#C6A9FD", vanilla: "#F5E9A4", seashell: "#F1E5E0",
    golden: "#FBCF50", pumpkin: "#FF7307", frost: "#8AD4DD", pink: "#FC97B9",
    wine: "#662832", coffee: "#2D1318", jet: "#2B3A36", teal: "#8FB8AD",
  });
});

test("every official tint token in globals.css exists verbatim in the palette", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const all = new Set(FAMILY_KEYS.flatMap((k) => TINT_STEPS.map((t) => BRAND_FAMILIES[k].tints[t].toLowerCase())));
  const tokens = [...css.matchAll(/--brand-(amethyst|mauve|vanilla|seashell|golden-pollen|pumpkin|frosted-blue|pink-mist|wine-plum|coffee-bean|jet-black|muted-teal)(-\d+)?:\s*(#[0-9a-f]{6})/g)];
  assert.ok(tokens.length >= 20);
  for (const m of tokens) assert.ok(all.has(m[3]), `${m[0]} not in palette`);
});

test("contrast helper matches known WCAG values", () => {
  assert.equal(contrast("#000000", "#FFFFFF").toFixed(1), "21.0");
  assert.equal(contrast("#1D0446", "#8AD4DD").toFixed(2), "10.83");
});
