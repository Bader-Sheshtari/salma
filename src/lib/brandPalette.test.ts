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

// ------------------------------------------------------------------ DAWI
import { DAWI_COLORS, DAWI_KEYS, DAWI_SHADES } from "./brandPalette.ts";

test("DAWI collection: 6 documented pairs, verbatim hexes, no invented scale", () => {
  assert.equal(DAWI_KEYS.length, 6);
  assert.deepEqual([...DAWI_SHADES], ["primary", "light"]);
  for (const k of DAWI_KEYS) {
    const c = DAWI_COLORS[k];
    assert.equal(c.key, k);
    assert.ok(c.ar && c.en);
    for (const s of DAWI_SHADES) assert.match(c.shades[s], /^#[0-9A-F]{6}$/, `dawi-${k} ${s}`);
  }
  // Exact owner-supplied values (cross-checked against the official image).
  assert.deepEqual(
    Object.fromEntries(DAWI_KEYS.map((k) => [k, [DAWI_COLORS[k].shades.primary, DAWI_COLORS[k].shades.light]])),
    {
      teal: ["#009984", "#CCE9E4"],
      grey: ["#606261", "#E8E8E8"],
      white: ["#FFFFFF", "#F7F7F5"],
      coral: ["#F6988A", "#F8AEA5"],
      darkteal: ["#117E6B", "#99D6CC"],
      blue: ["#389BD4", "#43BDCC"],
    },
  );
});

test("DAWI: Bandage (logo-only) is absent; no collision with the SALMA palette", () => {
  const dawi = DAWI_KEYS.flatMap((k) => DAWI_SHADES.map((s) => DAWI_COLORS[k].shades[s]));
  assert.equal(new Set(dawi).size, 12); // no duplicate within DAWI
  assert.ok(!dawi.includes("#D9AF85") && !dawi.includes("#ECCDB1"), "Bandage is logo-only");
  const salma = new Set(FAMILY_KEYS.flatMap((k) => TINT_STEPS.map((t) => BRAND_FAMILIES[k].tints[t])));
  for (const h of dawi) assert.ok(!salma.has(h), `${h} duplicates a SALMA tint`);
});

test("contrast helper matches known WCAG values", () => {
  assert.equal(contrast("#000000", "#FFFFFF").toFixed(1), "21.0");
  assert.equal(contrast("#1D0446", "#8AD4DD").toFixed(2), "10.83");
});
