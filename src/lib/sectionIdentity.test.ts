// Unit tests for the DF identity map, anatomy selection and the §LBL rule.
// Runs on plain Node (type stripping): `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_KEYS, anatomyFor, identityFor, identityKey, showCategoryTag } from "./sectionIdentity.ts";

test("unknown / empty / legacy-hex accents fall back to paper", () => {
  for (const v of [null, undefined, "", "  ", "#449785", "Teal-ish"]) {
    assert.equal(identityKey(v), "paper");
  }
  assert.equal(identityKey(" Frost "), "frost");
  assert.equal(identityFor("#5496CF").key, "paper");
});

test("every identity is complete (surface, devices and text rules together)", () => {
  for (const k of IDENTITY_KEYS) {
    const id = identityFor(k);
    assert.equal(id.key, k);
    for (const f of ["rule", "ruleLine", "hairline", "headline", "body", "pill", "mark", "tile", "fieldTile", "ground"] as const) {
      assert.ok(id[f].length > 0, `${k}.${f}`);
    }
    assert.equal(id.field, id.surface.length > 0, `${k}: field ⇔ surface`);
  }
});

test("text on frost-100 is amethyst/amethyst-800 only; coloured type limited to amethyst/wine/jet (DG)", () => {
  assert.equal(identityFor("frost").body, "text-amethyst-800");
  for (const k of IDENTITY_KEYS) {
    const id = identityFor(k);
    assert.match(id.headline, /^text-(amethyst|wine-plum|jet-black)$/);
    assert.match(id.body, /^text-amethyst-(600|800)$/);
  }
});

test("anatomy = display_style × identity", () => {
  assert.equal(anatomyFor("carousel", identityFor("frost")), "rail");
  assert.equal(anatomyFor("grid", identityFor("teal")), "columns");
  assert.equal(anatomyFor("list", identityFor("pink")), "numbered");
  assert.equal(anatomyFor("list", identityFor("wine")), "text-led");
  assert.equal(anatomyFor("list", identityFor("paper")), "rows");
  assert.equal(anatomyFor("featured", identityFor("jet")), "open21");
  assert.equal(anatomyFor("featured", identityFor("mauve")), "feature-side");
  assert.equal(anatomyFor("featured", identityFor("pink")), "lead-numbered");
  assert.equal(anatomyFor("featured", identityFor("frost-rule")), "lead-standfirst");
  assert.equal(anatomyFor("unknown-style", identityFor("paper")), "columns");
});

test("§LBL: tag only when the story's category differs from the collection's", () => {
  assert.equal(showCategoryTag("kuwait", null), true); // mixed (lead board)
  assert.equal(showCategoryTag("kuwait", "kuwait"), false); // unified section
  assert.equal(showCategoryTag("gulf", "kuwait"), true);
  assert.equal(showCategoryTag(null, null), false);
});

// ------------------------------------------------- family × tint grammar (Color Picker)
import { readFileSync } from "node:fs";
import {
  FAMILY_DEFAULTS,
  accentFor,
  legacyRecipe,
  offeredTints,
  parseAccent,
  recipeTextPairs,
} from "./sectionIdentity.ts";
import { BRAND_FAMILIES, FAMILY_KEYS, TINT_STEPS, contrast } from "./brandPalette.ts";

const LEGACY_FIXTURE = JSON.parse(
  readFileSync(new URL("./sectionIdentity.legacy.fixture.json", import.meta.url), "utf8"),
) as Record<string, Record<string, unknown>>;

test("parser: valid family / family-tint / family-rule, case + whitespace insensitive", () => {
  assert.deepEqual(parseAccent("golden-30"), { kind: "family", family: "golden", tint: 30 });
  assert.deepEqual(parseAccent(" JET-RULE "), { kind: "family", family: "jet", tint: "rule" });
  assert.deepEqual(parseAccent("Pumpkin"), { kind: "family", family: "pumpkin", tint: 10 });
  assert.deepEqual(parseAccent("teal-20"), { kind: "family", family: "teal", tint: 20 });
  assert.deepEqual(parseAccent("Frost"), { kind: "legacy", key: "frost" });
  assert.deepEqual(parseAccent("frost-rule"), { kind: "legacy", key: "frost-rule" });
});

test("parser: invalid, unknown and legacy-hex values → paper", () => {
  for (const v of ["golden-35", "foo-30", "golden-", "-30", "#449785", "teal_20", "amethyst-50", "golden-30-rule", "paper"]) {
    assert.deepEqual(parseAccent(v), { kind: "paper" }, v);
  }
});

test("backward compatibility: every legacy key resolves to its exact pre-generalisation recipe", () => {
  for (const k of IDENTITY_KEYS) {
    assert.deepEqual(legacyRecipe(k), LEGACY_FIXTURE[k], k);
    const id = identityFor(k) as unknown as Record<string, unknown>;
    for (const [field, v] of Object.entries(LEGACY_FIXTURE[k])) assert.deepEqual(id[field], v, `${k}.${field}`);
    // Legacy recipes never carry palette vars/inline styles (byte-identical render).
    assert.equal(id.vars, undefined);
    assert.equal(id.markStyle, undefined);
    assert.equal(id.tileStyle, undefined);
    assert.equal(id.ink, "text-amethyst");
    assert.equal(id.pillText, "text-amethyst");
  }
});

test("EXHAUSTIVE contrast: every family × offered tint (+rule) emits only ≥4.5:1 text pairs", () => {
  let checked = 0;
  for (const f of FAMILY_KEYS) {
    const tints = [...offeredTints(f), "rule" as const];
    assert.ok(tints.length >= 2, `${f} offers at least one surface tint`);
    for (const t of tints) {
      for (const [label, text, surface] of recipeTextPairs(f, t)) {
        const r = contrast(text, surface);
        assert.ok(r >= 4.5, `${f}-${t} ${label}: ${text} on ${surface} = ${r.toFixed(2)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 400);
});

test("non-hostable tints are rule-only (never offered as a surface)", () => {
  for (const f of FAMILY_KEYS) {
    for (const t of TINT_STEPS) {
      if (!offeredTints(f).includes(t)) {
        assert.deepEqual(parseAccent(`${f}-${t}`), { kind: "paper" }, `${f}-${t}`);
      }
    }
  }
});

test("graphic-only devices are documented (rule/devices vs surface ≥1.5:1 on light surfaces)", () => {
  for (const f of FAMILY_KEYS) {
    for (const t of offeredTints(f)) {
      const id = identityFor(`${f}-${t}`);
      if (id.dark) continue;
      const v = id.vars!;
      assert.ok(contrast(v["--id-dev"], v["--id-surface"]) >= 1.5, `${f}-${t} device visible`);
    }
  }
});

test("picker writes: defaults → bare key, frost+rule → legacy key, else family-tint", () => {
  for (const f of FAMILY_KEYS) assert.equal(accentFor(f, FAMILY_DEFAULTS[f]), f);
  assert.equal(accentFor("frost", "rule"), "frost-rule");
  assert.equal(accentFor("golden", 30), "golden-30");
  assert.equal(accentFor("teal", 10), "teal-10");
  for (const f of FAMILY_KEYS) for (const t of offeredTints(f)) assert.notEqual(identityKey(accentFor(f, t)), "paper");
});

// ------------------------------------------------- DAWI brand colors (separate collection)
import { dawiAccent, dawiTextPairs, offeredDawiShades } from "./sectionIdentity.ts";
import { DAWI_COLORS, DAWI_KEYS, DAWI_SHADES, hostsText } from "./brandPalette.ts";

test("DAWI parser: dawi-<color>[-light|-rule], namespaced away from SALMA families", () => {
  assert.deepEqual(parseAccent("dawi-teal-light"), { kind: "dawi", color: "teal", shade: "light" });
  assert.deepEqual(parseAccent(" DAWI-BLUE "), { kind: "dawi", color: "blue", shade: "primary" });
  assert.deepEqual(parseAccent("dawi-grey-rule"), { kind: "dawi", color: "grey", shade: "rule" });
  // `teal` stays the SALMA legacy key; `dawi-teal` is a different namespace.
  assert.deepEqual(parseAccent("teal"), { kind: "legacy", key: "teal" });
  for (const v of ["dawi", "dawi-", "dawi-bandage", "dawi-teal-20", "dawi-teal-light-rule", "dawi-gold"]) {
    assert.deepEqual(parseAccent(v), { kind: "paper" }, v);
  }
});

test("DAWI: non-hostable shades are rule-only (teal/darkteal primaries)", () => {
  for (const k of DAWI_KEYS) {
    for (const s of DAWI_SHADES) {
      if (!offeredDawiShades(k).includes(s)) {
        assert.deepEqual(parseAccent(dawiAccent(k, s)), { kind: "paper" }, `dawi-${k} ${s}`);
      }
    }
    assert.ok(offeredDawiShades(k).length >= 1, `dawi-${k} offers at least one surface`);
  }
  // The computed outcome, pinned: both deep DAWI greens fail the 4.5:1 host
  // standard for surfaces and are offered as rule/device colours instead.
  assert.equal(hostsText(DAWI_COLORS.teal.shades.primary), false);
  assert.equal(hostsText(DAWI_COLORS.darkteal.shades.primary), false);
});

test("DAWI: every offered shade (+rule) emits only ≥4.5:1 text pairs, same Identity shape", () => {
  let checked = 0;
  for (const k of DAWI_KEYS) {
    for (const s of [...offeredDawiShades(k), "rule" as const]) {
      const id = identityFor(dawiAccent(k, s));
      assert.equal(id.key, dawiAccent(k, s));
      assert.equal(id.family, null);
      assert.equal(id.field, s !== "rule");
      for (const [label, text, surface] of dawiTextPairs(k, s)) {
        const r = contrast(text, surface);
        assert.ok(r >= 4.5, `dawi-${k}-${s} ${label}: ${text} on ${surface} = ${r.toFixed(2)}`);
        checked++;
      }
      if (!id.dark) {
        const v = id.vars!;
        assert.ok(contrast(v["--id-dev"], v["--id-surface"]) >= 1.5, `dawi-${k}-${s} device visible`);
      }
    }
  }
  assert.ok(checked >= 80);
  assert.equal(identityFor("dawi-grey").dark, true); // white text on DAWI grey
  assert.equal(identityFor("dawi-coral").dark, false); // amethyst text on coral
});

test("DAWI: never applied automatically — defaults and legacy recipes untouched", () => {
  assert.equal(identityKey(""), "paper");
  for (const k of IDENTITY_KEYS) assert.deepEqual(legacyRecipe(k), LEGACY_FIXTURE[k], k);
  assert.equal(anatomyFor("featured", identityFor("dawi-coral")), "lead-standfirst");
  assert.equal(anatomyFor("list", identityFor("dawi-teal-light")), "rows");
});

test("new-family defaults: golden/seashell light, pumpkin warm-10, amethyst/coffee dark with light text", () => {
  assert.equal(identityFor("golden").vars!["--id-surface"], BRAND_FAMILIES.golden.tints[20]);
  assert.equal(identityFor("seashell").vars!["--id-surface"], BRAND_FAMILIES.seashell.tints[60]);
  assert.equal(identityFor("pumpkin").vars!["--id-surface"], BRAND_FAMILIES.pumpkin.tints[10]);
  for (const f of ["amethyst", "coffee"]) {
    const id = identityFor(f);
    assert.equal(id.dark, true);
    assert.equal(id.headline, "text-white");
  }
});
