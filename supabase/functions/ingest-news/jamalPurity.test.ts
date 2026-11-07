// Article-body purity checks (c2, owner-approved 2026-11-07) — review-only
// backstops for accidental English connectors in Arabic prose and source-gap
// meta-commentary in the article body. Conservative by owner mandate:
// legitimate medical terminology, drug names, abbreviations and proper names
// must pass regardless of capitalization, and a hit may only route to human
// review — these tests pin both directions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { latinLeakWords, sourceMetaCommentary, J1_0 } from "./jamal.ts";

// The exact offending sentence from the Foundayo supervised article
// (content 18e7c221, 2026-11-07).
const FOUNDAYO_LEAK_SENTENCE =
  "ولم يذكر الخبر المنشور تفاصيل عن نتائج الدراسات التي استندت إليها الموافقة، ولا الفئة الدقيقة من المرضى المؤهلين beyond كونهم بالغين مصابين بالسكري من النوع الثاني، كما لم يورد تحذيرات السلامة أو الآثار الجانبية أو ما إذا كانت الموافقة مشروطة بقيود إضافية.";

test("regression (Foundayo): the English connector 'beyond' in Arabic prose is flagged", () => {
  assert.deepEqual(latinLeakWords(FOUNDAYO_LEAK_SENTENCE), ["beyond"]);
});

test("regression (Foundayo): the source-gap meta-commentary sentence is flagged as a whole", () => {
  const hits = sourceMetaCommentary(FOUNDAYO_LEAK_SENTENCE);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].includes("لم يذكر الخبر المنشور"));
});

test("latin leaks: conservative — terminology, drug names, acronyms and proper names pass", () => {
  const legit =
    "ووصف المصدر الدواء بأنه من فئة ناهضات مستقبل GLP-1 الفموية، والمادة الفعالة orforglipron " +
    "المعروفة تجارياً باسم Foundayo، وفق ما نشرته The Lancet وأقرته FDA، والمعرف الرقمي DOI متاح، " +
    "إضافة إلى بيانات semaglutide ولقاح COVID-19 وفحص mRNA.";
  assert.deepEqual(latinLeakWords(legit), []);
});

test("latin leaks: other connectors are caught, case-conservatively (lowercase only)", () => {
  assert.deepEqual(latinLeakWords("هذا النص however يحتوي على خطأ").sort(), ["however"]);
  assert.deepEqual(latinLeakWords("النتائج despite القيود كانت واضحة"), ["despite"]);
  // Capitalized words are proper-noun shaped and deliberately pass.
  assert.deepEqual(latinLeakWords("نشرت صحيفة The National تقريراً"), []);
  assert.deepEqual(latinLeakWords(""), []);
});

test("meta-commentary: reader-facing uncertainty about the FACTS passes", () => {
  // Subject is the study/eligibility — not الخبر/المصدر — so these stay legal
  // in articles (genuinely essential uncertainty, c2 third bullet).
  assert.deepEqual(sourceMetaCommentary("لم تُنشر نتائج الدراسة التفصيلية بعد."), []);
  assert.deepEqual(sourceMetaCommentary("لم تُحدَّد بعد الفئات المؤهلة بدقة."), []);
  assert.deepEqual(sourceMetaCommentary("وقالت الجهة المنظمة إن العلاج يصرف بوصفة طبية."), []);
});

test("meta-commentary: shop-talk about الخبر/المصدر/التقرير is flagged; attribution alone is not", () => {
  assert.equal(sourceMetaCommentary("ولا يذكر المصدر تفاصيل الجرعات المعتمدة.").length, 1);
  assert.equal(sourceMetaCommentary("لم يوضح التقرير المنشور آلية عمل الدواء.").length, 1);
  // Plain attribution is legitimate journalism and passes.
  assert.deepEqual(sourceMetaCommentary("وفق ما أورده الخبر، بدأ تطبيق القرار فوراً."), []);
});

test("c2: active config is j1.0-c2 with the purity addendum after c1, before the envelope", () => {
  const w = J1_0.instructions.write;
  assert.equal(J1_0.version, "j1.0-c2");
  const c2At = w.indexOf("Editorial clarification c2");
  assert.ok(c2At > w.indexOf("Editorial clarification c1"));
  assert.ok(c2At < w.indexOf("Integration transport envelope"));
  assert.ok(w.includes("Article-body purity"));
});
