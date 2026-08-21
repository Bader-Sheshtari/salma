// Unit tests for the deterministic editorial-feedback edit measurement.
// Run: node --test --experimental-strip-types scripts/editorial-feedback.test.ts
// (scripts/ is excluded from the Next.js tsconfig, so this never affects the build.)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessBodyEdit,
  assessTitleEdit,
  charEditRatio,
  lightNormalize,
  normalizeRejectReason,
  sampleLabel,
  strongNormalize,
  tokenEditRatio,
  urlHost,
} from "../src/lib/editorial-feedback.ts";

test("lightNormalize strips punctuation and collapses whitespace", () => {
  assert.equal(lightNormalize("  دواء   جديد ، للسكري!  "), "دواء جديد للسكري");
  assert.equal(lightNormalize("«خبر»: (مهم) - جداً…"), "خبر مهم جداً");
});

test("strongNormalize folds Arabic orthography variants", () => {
  assert.equal(strongNormalize("إعلانُ أدويةٍ جديدة"), strongNormalize("اعلان ادويه جديده"));
  assert.equal(strongNormalize("مستوى عالٍ"), strongNormalize("مستوي عال"));
});

test("title: whitespace/punctuation-only change is NOT material", () => {
  const r = assessTitleEdit("دواء جديد للسكري في الكويت", "دواء جديد للسكري، في الكويت.");
  assert.equal(r.material, false);
  assert.equal(r.magnitude, "none");
});

test("title: orthography touch-up (hamza) is NOT material", () => {
  const r = assessTitleEdit("اعلان نتائج دراسة القلب", "إعلان نتائج دراسة القلب");
  assert.equal(r.material, false);
});

test("title: identical is unchanged", () => {
  const r = assessTitleEdit("عنوان ثابت تماماً", "عنوان ثابت تماماً");
  assert.equal(r.changed, false);
  assert.equal(r.ratio, 0);
});

test("title: real rewrite IS material", () => {
  const r = assessTitleEdit(
    "دراسة جديدة تكشف فوائد المشي اليومي",
    "المشي نصف ساعة يومياً يقلل خطر أمراض القلب",
  );
  assert.equal(r.material, true);
  assert.ok(r.ratio >= 0.1);
});

test("title: swapping one word is material, small typo fix is not", () => {
  const word = assessTitleEdit(
    "وزارة الصحة تعلن حملة تطعيم جديدة ضد الانفلونزا",
    "وزارة الصحة تطلق برنامج تطعيم جديد ضد الانفلونزا",
  );
  assert.equal(word.material, true);
  const typo = assessTitleEdit(
    "وزارة الصحة تعلن حملة تطعيم جديدة ضد الانفلونزا",
    "وزارة الصحة تعلن حملة تطعيم جديدة ضد الأنفلونزا",
  );
  assert.equal(typo.material, false);
});

test("body: identical and punctuation-only → none", () => {
  const body = "الفقرة الأولى تشرح الدراسة. الفقرة الثانية تشرح النتائج بالتفصيل الكامل.";
  assert.equal(assessBodyEdit(body, body).magnitude, "none");
  assert.equal(assessBodyEdit(body, body.replaceAll(".", "،")).magnitude, "none");
});

test("body: small tweak → minor, partial rework → moderate, rewrite → major", () => {
  const words = Array.from({ length: 200 }, (_, i) => `كلمة${i}`);
  const original = words.join(" ");
  // ~5% of tokens replaced → minor (0.03..0.15)
  const minor = words.map((w, i) => (i % 20 === 0 ? `بديل${i}` : w)).join(" ");
  assert.equal(assessBodyEdit(original, minor).magnitude, "minor");
  // ~25% replaced → moderate
  const moderate = words.map((w, i) => (i % 4 === 0 ? `بديل${i}` : w)).join(" ");
  assert.equal(assessBodyEdit(original, moderate).magnitude, "moderate");
  // fully different → major
  const major = Array.from({ length: 180 }, (_, i) => `اخرى${i}`).join(" ");
  assert.equal(assessBodyEdit(original, major).magnitude, "major");
});

test("charEditRatio bounds", () => {
  assert.equal(charEditRatio("ابجد", "ابجد"), 0);
  assert.equal(charEditRatio("ابجد", ""), 1);
  const r = charEditRatio("ابجد هوز", "ابجد حوز");
  assert.ok(r > 0 && r < 0.3);
});

test("tokenEditRatio bounds and move-tolerance", () => {
  assert.equal(tokenEditRatio("", ""), 0);
  assert.equal(tokenEditRatio("نص كامل", ""), 1);
  // Deleting one sentence from four leaves most tokens in the LCS.
  const a = "الجملة الاولى هنا. الجملة الثانية هنا. الجملة الثالثة هنا. الجملة الرابعة هنا.";
  const b = "الجملة الاولى هنا. الجملة الثالثة هنا. الجملة الرابعة هنا.";
  const r = tokenEditRatio(a, b);
  assert.ok(r > 0 && r < 0.25, `ratio was ${r}`);
});

test("reject reason taxonomy is clamped", () => {
  assert.equal(normalizeRejectReason("weak_source"), "weak_source");
  assert.equal(normalizeRejectReason("DROP TABLE"), null);
  assert.equal(normalizeRejectReason(undefined), null);
  assert.equal(normalizeRejectReason("other"), "other");
});

test("sample-size labels are deterministic", () => {
  assert.equal(sampleLabel(1), "insufficient_data");
  assert.equal(sampleLabel(4), "insufficient_data");
  assert.equal(sampleLabel(5), "early_signal");
  assert.equal(sampleLabel(19), "early_signal");
  assert.equal(sampleLabel(20), "meaningful_sample");
});

test("urlHost normalizes for source-change comparison", () => {
  assert.equal(urlHost("https://www.fda.gov/news/x"), "fda.gov");
  assert.equal(urlHost("https://science.org/doi/1"), "science.org");
  assert.equal(urlHost(null), "");
  // Same host, different path → NOT a source change.
  assert.equal(urlHost("https://fda.gov/a"), urlHost("https://www.fda.gov/b"));
});
