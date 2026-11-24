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
