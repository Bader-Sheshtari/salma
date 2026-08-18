// Controlled-example checks for the Salma editorial writing engine (E1.3A).
//
// Fixtures only — NO live OpenRouter calls. Arabic examples exercise profile
// selection, style/headline validation, fact grounding, deterministic reading
// time, and malformed-output handling. Runs under Node's native TS type
// stripping (`node salmaWriter.test.ts`) or `deno test`.

import test from "node:test";
import assert from "node:assert/strict";
import {
  WRITER_PROMPT_VERSION,
  selectProfile,
  sensitiveProfileHint,
  countWords,
  readingTimeMinutes,
  stripSourceBrand,
  detectPromoPhrases,
  validateHeadline,
  extractNumbers,
  extractQuotes,
  checkFactGrounding,
  numberLocaleForLang,
  parseNumberToken,
  extractNumberEntries,
  extractOfficialActions,
  officialActionsByAudience,
  hasUnaffectedBatchStatement,
  parseWriterOutput,
  validateArticle,
  buildWritingInstructions,
  PROFILE_WORD_BANDS,
  isCodeLikeEntity,
  classifyEntityVisibility,
  safetyIdentifierNeeded,
  editorialQualityWarnings,
  stripFormalSuffixes,
  foreignEssentialNameStatus,
} from "./salmaWriter.ts";

// --- profile selection -----------------------------------------------------

test("prompt version is the dedicated writer version", () => {
  assert.equal(WRITER_PROMPT_VERSION, "e1.3a-salma-writer");
});

test("a medicine safety alert selects the safety_alert profile", () => {
  const p = selectProfile({
    sourceText: "تحذير من الهيئة: سحب دفعة من دواء بسبب تلوث محتمل.",
  });
  assert.equal(p, "safety_alert");
});

test("a ministry decision selects the regulation_or_service profile", () => {
  const p = selectProfile({
    sourceText: "أصدرت وزارة الصحة قراراً بلائحة جديدة تنظّم الأهلية للخدمة.",
  });
  assert.equal(p, "regulation_or_service");
});

test("a peer-reviewed study selects the research_study profile", () => {
  const p = selectProfile({
    sourceText: "دراسة محكّمة نشرتها دورية علمية شملت عيّنة من 1200 مشارك.",
  });
  assert.equal(p, "research_study");
});

test("a short generic announcement falls back to quick_news by length", () => {
  const p = selectProfile({ sourceText: "إعلان صحي عام قصير.", targetWords: 130 });
  assert.equal(p, "quick_news");
});

test("an explicit profile always wins over keyword inference", () => {
  const p = selectProfile({ explicit: "quick_news", sourceText: "دراسة محكّمة عن دواء وتحذير." });
  assert.equal(p, "quick_news");
});

// --- reading time (deterministic, Step 8) ----------------------------------

test("read minutes come from the final body, not a model estimate", () => {
  const short = Array.from({ length: 120 }, () => "كلمة").join(" ");
  assert.equal(countWords(short), 120);
  assert.equal(readingTimeMinutes(short), 1); // ~120 words -> 1 min, never 3
});

test("a longer body scales to more realistic minutes", () => {
  const long = Array.from({ length: 540 }, () => "كلمة").join(" ");
  assert.equal(readingTimeMinutes(long), 3);
});

test("an empty body still yields a floor of one minute", () => {
  assert.equal(readingTimeMinutes(""), 1);
});

// --- headline rules (Step 5) -----------------------------------------------

test("a source-brand suffix is removed from the headline", () => {
  const { title, stripped } = stripSourceBrand("لقاح جديد يصل مراكز الكويت - رويترز", "رويترز");
  assert.equal(stripped, true);
  assert.ok(!title.includes("رويترز"));
});

test("a headline copied from the original is flagged", () => {
  const original = "وزارة الصحة تطلق خدمة الحجز الإلكتروني الجديدة للمراجعين";
  const { warnings } = validateHeadline(original, { originalTitle: original });
  assert.ok(warnings.includes("headline_duplicates_original"));
});

test("a promotional headline is flagged as a warning", () => {
  const { warnings } = validateHeadline("اكتشاف مذهل يغيّر الطب في الكويت", {});
  assert.ok(warnings.includes("headline_promotional"));
});

test("promotional phrase detection finds banned ceremonial wording", () => {
  const found = detectPromoPhrases("في إطار حرصها على الصحة أعلنت الوزارة عن ثورة طبية");
  assert.ok(found.includes("في إطار حرصها"));
  assert.ok(found.includes("ثورة طبية"));
});

// --- fact grounding (Step 7, blocking) -------------------------------------

test("a number absent from the source material is rejected", () => {
  const { errors } = checkFactGrounding(
    { title: "ارتفاع الإصابات", excerpt: "", body: "سجّلت الوزارة 5000 إصابة جديدة هذا الأسبوع." },
    { sourceText: "أعلنت الوزارة عن ارتفاع في الإصابات دون رقم محدد." },
    "standard_news",
  );
  assert.ok(errors.some((e) => e.startsWith("unsupported_number")));
});

test("a number present in the source material passes", () => {
  const { errors } = checkFactGrounding(
    { title: "تطعيم", excerpt: "", body: "شمل البرنامج 1500 طفل في الكويت." },
    { sourceText: "غطّى البرنامج 1500 طفل في مدارس الكويت." },
    "standard_news",
  );
  assert.ok(!errors.some((e) => e.startsWith("unsupported_number")));
});

test("an invented quotation is rejected", () => {
  const { errors } = checkFactGrounding(
    { title: "تصريح", excerpt: "", body: "قال المسؤول «سنقضي على المرض نهائياً هذا العام»." },
    { sourceText: "أشار المسؤول إلى استمرار جهود مكافحة المرض." },
    "standard_news",
  );
  assert.ok(errors.includes("invented_quotation"));
});

test("an unsupported efficacy claim is rejected", () => {
  const { errors } = checkFactGrounding(
    { title: "دواء", excerpt: "", body: "الدواء مثبت وآمن تماماً ويشفي المرض." },
    { sourceText: "لا يزال الدواء قيد الدراسة السريرية." },
    "standard_news",
  );
  assert.ok(errors.some((e) => e.startsWith("unsupported_claim")));
});

test("an observational study must not be written as causation", () => {
  const { errors } = checkFactGrounding(
    { title: "دراسة", excerpt: "", body: "أظهرت الدراسة أن المشروب يسبب المرض بشكل مباشر." },
    { sourceText: "دراسة رصدية وجدت أن المشروب ارتبط بزيادة الخطر دون إثبات السببية." },
    "research_study",
  );
  assert.ok(errors.includes("association_as_causation"));
});

test("a faithful research summary using association wording passes", () => {
  const { errors } = checkFactGrounding(
    { title: "دراسة", excerpt: "", body: "وجدت الدراسة أن المشروب مرتبط بزيادة الخطر، دون إثبات السبب." },
    { sourceText: "دراسة رصدية: المشروب ارتبط بزيادة الخطر، والعلاقة ليست سببية." },
    "research_study",
  );
  assert.ok(!errors.includes("association_as_causation"));
});

test("complex medical terminology in the source is not itself a violation", () => {
  const src =
    "أظهر تحليل المناعة الكيميائي النسيجي (immunohistochemistry) استجابة لدى 40% من المرضى.";
  const { errors } = checkFactGrounding(
    { title: "علاج مناعي", excerpt: "", body: "استجاب 40% من المرضى للعلاج المناعي وفق التحليل النسيجي." },
    { sourceText: src },
    "research_study",
  );
  assert.deepEqual(errors, []);
});

test("numbers fold Arabic-Indic digits when comparing to the source", () => {
  assert.deepEqual(extractNumbers("سجّلت ١٢٣٤ حالة"), ["1234"]);
  const { errors } = checkFactGrounding(
    { title: "حالات", excerpt: "", body: "سجّلت الوزارة 1234 حالة." },
    { sourceText: "بلغ العدد ١٢٣٤ حالة." },
    "quick_news",
  );
  assert.ok(!errors.some((e) => e.startsWith("unsupported_number")));
});

test("quote extraction handles Arabic and ASCII quotation marks", () => {
  assert.deepEqual(extractQuotes("قال «مرحباً» ثم \"وداعاً\""), ["مرحباً", "وداعاً"]);
});

// --- E1.3C regression: validator false-positives from the E1.3B benchmark ---

// Fixture B (regulation_or_service): the source carries the ISO date
// `2026-09-01`; models faithfully rendered it as "1 سبتمبر 2026". The day "1"
// must NOT be flagged as an unsupported number just because the source padded
// it to "01".
test("an ISO source date matches an unpadded Arabic-worded day (benchmark B)", () => {
  const { errors } = checkFactGrounding(
    { title: "الصحة تُلزم الصيدليات بالربط مع منصة شفاء", excerpt: "", body: "يبدأ تطبيق القرار في 1 سبتمبر 2026 على الصيدليات الخاصة في الكويت." },
    { sourceText: "يبدأ تطبيق القرار في 2026-09-01. الصيدليات غير الملتزمة تُعرَّض لغرامة قدرها 500 دينار." },
    "regulation_or_service",
  );
  assert.ok(!errors.some((e) => e.startsWith("unsupported_number")), errors.join(","));
});

test("a zero-padded Arabic day also matches the ISO source date", () => {
  const { errors } = checkFactGrounding(
    { title: "قرار جديد", excerpt: "", body: "يبدأ التطبيق في 01 سبتمبر 2026 وفق القرار." },
    { sourceText: "يبدأ تطبيق القرار في 2026-09-01." },
    "regulation_or_service",
  );
  assert.ok(!errors.some((e) => e.startsWith("unsupported_number")), errors.join(","));
});

test("the worded Arabic ordinal date introduces no unsupported number", () => {
  const { errors } = checkFactGrounding(
    { title: "قرار جديد", excerpt: "", body: "يبدأ التطبيق في الأول من سبتمبر 2026 وفق القرار." },
    { sourceText: "يبدأ تطبيق القرار في 2026-09-01." },
    "regulation_or_service",
  );
  assert.ok(!errors.some((e) => e.startsWith("unsupported_number")), errors.join(","));
});

test("leading-zero normalization still rejects a genuinely invented number", () => {
  const { errors } = checkFactGrounding(
    { title: "قرار جديد", excerpt: "", body: "يبدأ التطبيق في 1 سبتمبر 2026 ويشمل 300 صيدلية." },
    { sourceText: "يبدأ تطبيق القرار في 2026-09-01." },
    "regulation_or_service",
  );
  assert.ok(errors.includes("unsupported_number:300"), errors.join(","));
});

// Fixture E (research_study): claude-sonnet-5 explicitly DENIED causation with
// "لا يسمح بالجزم بأن أحدهما يسبّب الآخر" and "لا تثبت أن المشروبات ... هي
// السبب". The negated causal verb must pass, not trip association_as_causation.
test("explicitly negated causation passes (benchmark E, sonnet output)", () => {
  const { errors } = checkFactGrounding(
    {
      title: "دراسة تربط المشروبات المحلّاة بارتفاع خطر السكري",
      excerpt: "",
      body:
        "وجدت الدراسة الرصدية أن تناول المشروبات المحلّاة يومياً ارتبط بزيادة خطر الإصابة بالسكري من النوع الثاني بنسبة 18%. " +
        "وأكّد الباحثون أنها رصدية ولا يسمح بالجزم بأن أحدهما يسبّب الآخر، وأنها لا تثبت أن المشروبات المحلّاة هي السبب.",
    },
    {
      sourceText:
        "دراسة رصدية شملت 8400 بالغ وجدت أن المشروبات المحلّاة ارتبطت بزيادة خطر السكري من النوع الثاني بنسبة 18%. " +
        "أكّد الباحثون أن الدراسة رصدية ولا تثبت وجود علاقة سببية.",
    },
    "research_study",
  );
  assert.ok(!errors.includes("association_as_causation"), errors.join(","));
});

test("a short 'لا يسبّب' denial is not treated as a causal assertion", () => {
  const { errors } = checkFactGrounding(
    { title: "دراسة", excerpt: "", body: "المشروب المحلّى ارتبط بالخطر لكنه لا يسبّب المرض بحسب الباحثين." },
    { sourceText: "دراسة رصدية: المشروب ارتبط بزيادة الخطر دون إثبات السببية." },
    "research_study",
  );
  assert.ok(!errors.includes("association_as_causation"), errors.join(","));
});

test("a genuine association→causation upgrade is still blocked (un-negated)", () => {
  const { errors } = checkFactGrounding(
    { title: "دراسة", excerpt: "", body: "خلصت الدراسة إلى أن استهلاك المشروبات المحلّاة يؤدي إلى الإصابة بالسكري من النوع الثاني." },
    { sourceText: "دراسة رصدية شملت 8400 بالغ وجدت أن المشروبات المحلّاة ارتبطت بزيادة خطر السكري دون إثبات السببية." },
    "research_study",
  );
  assert.ok(errors.includes("association_as_causation"), errors.join(","));
});

test("word-boundary negation: 'علاج' does not count as the particle 'لا'", () => {
  // "العلاج" contains the letters ل+ا but is not a negation; an un-negated
  // causal claim in the same clause must still be blocked.
  const { errors } = checkFactGrounding(
    { title: "دراسة", excerpt: "", body: "رغم توفّر العلاج، فإن المشروب المحلّى يؤدي إلى المرض مباشرة." },
    { sourceText: "دراسة رصدية: المشروب ارتبط بزيادة الخطر دون إثبات السببية." },
    "research_study",
  );
  assert.ok(errors.includes("association_as_causation"), errors.join(","));
});

// Guards the Gemini-style fabrication (E1.3B): a safety alert that invents an
// unsourced medical specific (a drug indication with a dosage not in the
// source) must still be blocked by the number-grounding check.
test("an invented unsourced medical detail in a safety alert is still blocked", () => {
  const { errors } = checkFactGrounding(
    {
      title: "سحب دفعة من دواء بسبب خطأ في التركيز",
      excerpt: "",
      body: "سحبت الهيئة دفعة الدواء. يُستخدم الدواء بجرعة 250 ملغ لعلاج التهاب الأذن الوسطى.",
    },
    { sourceText: "أصدرت الهيئة قرار سحب لدفعة من الدواء بسبب خطأ في تركيز المادة الفعّالة. رقم الدفعة L2291." },
    "safety_alert",
  );
  assert.ok(errors.includes("unsupported_number:250"), errors.join(","));
});

// End-to-end: the ISO-vs-worded-date fix must also hold through validateArticle,
// not just checkFactGrounding, so a faithful regulation story is creatable.
test("validateArticle accepts a worded Arabic date grounded in an ISO source", () => {
  const bodyCore =
    "أصدرت وزارة الصحة قراراً يلزم الصيدليات الخاصة بالربط مع منصة شفاء. يبدأ تطبيق القرار في 1 سبتمبر 2026. " +
    "الصيدليات غير الملتزمة تُعرَّض لغرامة قدرها 500 دينار.";
  const filler = Array.from({ length: 150 }, () => "يوضّح القرار آلية الربط والالتزام للصيدليات في الكويت").join(" ");
  const v = validateArticle({
    article: { title: "الصحة تُلزم الصيدليات الخاصة بالربط مع منصة شفاء", excerpt: "قرار جديد", body: bodyCore + " " + filler, profile: "regulation_or_service" },
    source: {
      sourceText: "يلزم القرار الصيدليات الخاصة بالربط مع منصة شفاء. يبدأ تطبيقه في 2026-09-01. الغرامة 500 دينار.",
      brand: "وزارة الصحة",
    },
  });
  assert.equal(v.ok, true, v.errors.join(","));
  assert.ok(!v.errors.some((e) => e.startsWith("unsupported_number")), v.errors.join(","));
});

// --- locale- and scale-aware numeric grounding -----------------------------
//
// A figure is supported when its VALUE appears in the source across formatting
// conventions (thousands/decimal separators + Arabic/English scale words). A
// genuinely absent value, or an ambiguous token, still rejects (fail closed).
// `fg(draft, source, lang?)` returns the unsupported_number codes only.
function numErrors(bodyDraft: string, sourceText: string, sourceLang?: string | null): string[] {
  const { errors } = checkFactGrounding(
    { title: "عنوان اختباري مناسب الطول", excerpt: "", body: bodyDraft },
    { sourceText, sourceLang: sourceLang ?? null },
    "standard_news",
  );
  return errors.filter((e) => e.startsWith("unsupported_number"));
}

// ---- Should MATCH (no unsupported_number) ----
test("num: EN 330,000 source ↔ Arabic draft 330 ألف", () => {
  assert.deepEqual(numErrors("خصّت الدراسة نحو 330 ألف حالة.", "The study covered around 330,000 cases.", "eng"), []);
});
test("num: ES 15.000 (period-thousands) ↔ Arabic draft 15 ألف", () => {
  assert.deepEqual(numErrors("شخّصت نحو 15 ألف حالة.", "diagnosticó unas 15.000 enfermedades.", "spa"), []);
});
test("num: EN 1,000,000 ↔ Arabic draft 1 مليون", () => {
  assert.deepEqual(numErrors("أُصيب نحو 1 مليون شخص.", "About 1,000,000 people were affected.", "eng"), []);
});
test("num: EN 2,500,000 ↔ Arabic draft 2.5 مليون", () => {
  assert.deepEqual(numErrors("بلغ العدد 2.5 مليون.", "The figure reached 2,500,000.", "eng"), []);
});
test("num: EN decimal 1.5 ↔ draft 1.5", () => {
  assert.deepEqual(numErrors("ارتفاع بنسبة 1.5 نقطة.", "a rise of 1.5 points.", "eng"), []);
});
test("num: ES decimal 1,5 ↔ draft 1.5 (no 1,5→15 corruption)", () => {
  assert.deepEqual(numErrors("بنسبة 1.5 بالمئة.", "en un 1,5 por ciento.", "spa"), []);
});
test("num: Arabic-Indic digits in draft match Western source", () => {
  assert.deepEqual(numErrors("سجّلت ١٥٠٠ إصابة.", "recorded 1500 infections.", "eng"), []);
});
test("num: exactly-supported percentage passes", () => {
  assert.deepEqual(numErrors("شُخّص 23% من الحالات.", "23% of the studied cases were diagnosed.", "eng"), []);
});
test("num: billion scale word — 3 billion ↔ 3 مليار", () => {
  assert.deepEqual(numErrors("نحو 3 مليار نسمة.", "around 3 billion people.", "eng"), []);
});

// ---- Should FAIL (unsupported_number) ----
test("num: draft 330 ألف with no 330,000-equivalent in source rejects", () => {
  assert.ok(numErrors("نحو 330 ألف حالة.", "The study covered many thousands of cases.", "eng").length > 0);
});
test("num: source 330,000 but draft 350 ألف rejects", () => {
  const e = numErrors("نحو 350 ألف حالة.", "around 330,000 cases.", "eng");
  assert.ok(e.includes("unsupported_number:350"), e.join(","));
});
test("num: source 15,000 but draft 15 مليون rejects (wrong scale)", () => {
  const e = numErrors("نحو 15 مليون حالة.", "around 15,000 cases.", "eng");
  assert.ok(e.includes("unsupported_number:15"), e.join(","));
});
test("num: genuinely invented decimal rejects", () => {
  assert.ok(numErrors("ارتفاع بنسبة 7.3 نقطة.", "a modest rise was reported.", "eng").length > 0);
});
test("num: ambiguous token that cannot be safely interpreted fails closed", () => {
  // EN convention: "1,50" is neither a valid thousands group nor an EN decimal → null → rejected.
  const e = numErrors("قيمة 1,50 وحدة.", "the value was exactly 1.5 units.", "eng");
  assert.ok(e.length > 0, e.join(","));
});

// ---- Locale/scale unit helpers ----
test("num: numberLocaleForLang maps languages then defaults to en", () => {
  assert.equal(numberLocaleForLang("spa"), "eu");
  assert.equal(numberLocaleForLang("deu"), "eu");
  assert.equal(numberLocaleForLang("eng"), "en");
  assert.equal(numberLocaleForLang("ara"), "en");
  assert.equal(numberLocaleForLang(null), "en");
  assert.equal(numberLocaleForLang("xx"), "en");
});
test("num: parseNumberToken respects locale and fails closed on ambiguity", () => {
  assert.equal(parseNumberToken("330,000", "en"), "330000");
  assert.equal(parseNumberToken("330,000", "eu"), "330"); // 330.0 in EU
  assert.equal(parseNumberToken("15.000", "eu"), "15000");
  assert.equal(parseNumberToken("15.000", "en"), "15"); // 15.000 == 15 in EN
  assert.equal(parseNumberToken("1,5", "eu"), "1.5");
  assert.equal(parseNumberToken("1,5", "en"), null); // invalid grouping → fail closed
  assert.equal(parseNumberToken("2.500.000,50", "eu"), "2500000.5");
});
test("num: extractNumberEntries folds an adjacent scale word into the value", () => {
  const e = extractNumberEntries("نحو 2.5 مليون شخص و330 ألف حالة", "en");
  const values = e.map((x) => x.value);
  assert.ok(values.includes("2500000"), JSON.stringify(e));
  assert.ok(values.includes("330000"), JSON.stringify(e));
});

// --- strict structured-output parsing (Step 10) ----------------------------

test("valid plain JSON passes the strict parser", () => {
  const r = parseWriterOutput('{"title":"عنوان مقبول للخبر الصحي","excerpt":"موجز","body":"نص كافٍ للخبر."}');
  assert.ok(r.ok);
  assert.equal(r.ok && r.article.title, "عنوان مقبول للخبر الصحي");
  assert.equal(r.ok && r.article.excerpt, "موجز");
  assert.equal(r.ok && r.article.body, "نص كافٍ للخبر.");
});

test("valid JSON inside a single ```json fence passes", () => {
  const raw = '```json\n{"title":"عنوان مقبول للخبر الصحي","excerpt":"موجز","body":"نص"}\n```';
  const r = parseWriterOutput(raw);
  assert.ok(r.ok);
  assert.equal(r.ok && r.article.title, "عنوان مقبول للخبر الصحي");
});

test("leading prose before the object is rejected as extra_text", () => {
  const r = parseWriterOutput('إليك الناتج:\n{"title":"عنوان","excerpt":"","body":"نص"}');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_extra_text");
});

test("trailing prose after the object is rejected as extra_text", () => {
  const r = parseWriterOutput('{"title":"عنوان","excerpt":"","body":"نص"}\nشكراً لكم');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_extra_text");
});

test("multiple JSON objects are rejected", () => {
  const r = parseWriterOutput('{"title":"أ","excerpt":"","body":"نص"}{"title":"ب","excerpt":"","body":"نص"}');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_multiple_objects");
});

test("truncated / unterminated JSON is rejected as truncated", () => {
  const r = parseWriterOutput('{"title":"عنوان","excerpt":"","body":"نص لم يكتمل');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_truncated");
});

test("invalid escaped content is rejected as invalid_json", () => {
  // A bad JSON escape (\q): quotes/braces balance, but JSON.parse rejects it.
  const r = parseWriterOutput('{"title":"عنوان","excerpt":"","body":"نص\\qمكسور"}');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_invalid_json");
});

test("a bare non-JSON response is rejected as invalid_json", () => {
  const r = parseWriterOutput("عذراً لا يوجد JSON هنا");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_invalid_json");
});

test("a malformed / non-json code fence is rejected", () => {
  const r = parseWriterOutput('```python\n{"title":"عنوان","excerpt":"","body":"نص"}\n```');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_code_fence_invalid");
});

test("a missing required field is a schema violation", () => {
  const r = parseWriterOutput('{"excerpt":"موجز فقط"}');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_schema_invalid");
});

test("an extra unexpected field is a schema violation", () => {
  const r = parseWriterOutput('{"title":"عنوان","excerpt":"","body":"نص","profile":"quick_news"}');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_schema_invalid");
});

test("an empty required value is a schema violation", () => {
  const r = parseWriterOutput('{"title":"","excerpt":"","body":"نص"}');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_schema_invalid");
});

test("a wrong-type field is a schema violation", () => {
  const r = parseWriterOutput('{"title":123,"excerpt":"","body":"نص"}');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_schema_invalid");
});

test("an oversized field is an unsafe schema violation", () => {
  const huge = "ا".repeat(20001);
  const r = parseWriterOutput(`{"title":"عنوان","excerpt":"","body":"${huge}"}`);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_schema_invalid");
});

test("read_minutes is computed locally from the body, not from model output", () => {
  // 360 body words at 180 wpm → 2 minutes, regardless of any model claim.
  const body = repeatTo(360, "تتابع الوزارة الوضع الصحي في البلاد عن كثب اليوم");
  const raw = JSON.stringify({ title: "عنوان صحي واضح ومناسب للطول", excerpt: "موجز", body });
  const parsed = parseWriterOutput(raw);
  assert.ok(parsed.ok);
  const v = validateArticle({
    article: parsed.ok ? parsed.article : { title: "", excerpt: "", body: "" },
    source: { sourceText: body },
  });
  assert.equal(v.readMinutes, Math.max(1, Math.round(360 / 180)));
});

// --- end-to-end validation (Steps 2, 7, 9) ---------------------------------

const KUWAIT_SERVICE_SOURCE =
  "أعلنت وزارة الصحة الكويتية إطلاق خدمة حجز إلكتروني في 15 مركزاً صحياً، تبدأ في 2026-03-01، " +
  "ومتاحة لجميع المواطنين والمقيمين عبر تطبيق الوزارة دون رسوم.";

function repeatTo(words: number, seed: string): string {
  const base = seed.trim().split(/\s+/);
  const out: string[] = [];
  while (out.length < words) out.push(...base);
  return out.slice(0, words).join(" ");
}

test("a clean Kuwait health-service story validates and stays creatable", () => {
  const bodyCore =
    "أطلقت وزارة الصحة خدمة حجز إلكتروني في 15 مركزاً صحياً. تبدأ الخدمة في 2026-03-01 " +
    "وتتاح للمواطنين والمقيمين عبر تطبيق الوزارة دون رسوم. يمكن للمراجعين اختيار المركز والموعد المناسب.";
  const body = bodyCore + " " + repeatTo(170, "تتيح الخدمة حجز المواعيد إلكترونياً للمراجعين في الكويت");
  const v = validateArticle({
    article: { title: "الكويت تطلق حجز المواعيد الصحية إلكترونياً في 15 مركزاً", excerpt: "خدمة جديدة", body, profile: "regulation_or_service" },
    source: { sourceText: KUWAIT_SERVICE_SOURCE, mustPreserve: ["وزارة الصحة"] },
  });
  assert.equal(v.ok, true);
  assert.equal(v.rejectionReason, undefined);
  assert.equal(v.profile, "regulation_or_service");
  assert.ok(v.readMinutes >= 1);
});

test("a ministry story dressed in promotional language still flags the promo", () => {
  const body =
    "في إطار حرصها على الصحة، أصدرت وزارة الصحة قراراً بلائحة جديدة تبدأ في 2026-03-01 " +
    "وتشمل جميع المراجعين. " + repeatTo(160, "توضّح اللائحة الجديدة شروط الأهلية والوصول للخدمة الصحية");
  const v = validateArticle({
    article: { title: "لائحة صحية جديدة تبدأ مطلع مارس وتشمل جميع المراجعين", excerpt: "", body, profile: "regulation_or_service" },
    source: { sourceText: "أصدرت وزارة الصحة لائحة تبدأ في 2026-03-01 وتشمل جميع المراجعين." },
  });
  assert.ok(v.warnings.includes("body_promotional")); // detected, not silently kept
  assert.equal(v.ok, true); // promo is a style warning, not a hard block
});

test("an unsupported number prevents a pending draft (ok=false with a reason)", () => {
  const body =
    "أعلنت الوزارة عن 9999 إصابة جديدة. " + repeatTo(120, "تتابع الوزارة الوضع الصحي في البلاد عن كثب");
  const v = validateArticle({
    article: { title: "ارتفاع في الإصابات يستدعي المتابعة الصحية", excerpt: "", body, profile: "quick_news" },
    source: { sourceText: "أعلنت الوزارة عن ارتفاع في الإصابات دون رقم." },
  });
  assert.equal(v.ok, false);
  assert.ok(v.rejectionReason!.startsWith("unsupported_number"));
});

test("degenerate/too-short output is malformed and blocked", () => {
  const v = validateArticle({
    article: { title: "خبر", excerpt: "", body: "نص قصير جداً." },
    source: { sourceText: "مصدر." },
  });
  assert.equal(v.ok, false);
  assert.ok(v.rejectionReason!.startsWith("malformed_output"));
});

test("every profile has a sane word band", () => {
  for (const [name, band] of Object.entries(PROFILE_WORD_BANDS)) {
    assert.ok(band.min > 0 && band.max > band.min, `band for ${name}`);
  }
});

// --- writing instructions (Steps 2-6) --------------------------------------

test("writing instructions carry the writer version, ban list and JSON shape", () => {
  const instr = buildWritingInstructions("safety_alert");
  assert.ok(instr.includes(WRITER_PROMPT_VERSION));
  assert.ok(instr.includes("ثورة طبية")); // banned-phrase list is present
  // Strict 3-field schema only — no profile field is requested anymore.
  assert.ok(instr.includes("\"title\""));
  assert.ok(instr.includes("\"excerpt\""));
  assert.ok(instr.includes("\"body\""));
  assert.ok(!instr.includes("\"profile\""));
  assert.ok(instr.includes("تحذير سلامة")); // profile-specific guidance
});

// --- E1.3C final review: conservative sensitive-routing (Req 3) ------------

test("an ambiguous Arabic medicine warning routes to the sensitive safety profile", () => {
  // No strong recall/withdrawal keyword — only a medicine subject + a concern
  // term. It must still resolve to safety_alert (sensitive model), not default.
  const p = selectProfile({ sourceText: "قلق متزايد بشأن دواء شائع قد يكون له آثار غير متوقعة على القلب" });
  assert.equal(p, "safety_alert");
});

test("an ambiguous English medicine warning routes to the sensitive safety profile", () => {
  const p = selectProfile({ sourceText: "Regulators raise concerns over a widely used medicine" });
  assert.equal(p, "safety_alert");
});

test("an ambiguous Arabic observational study routes to research_study (sensitive)", () => {
  const p = selectProfile({ sourceText: "دراسة رصدية تربط بين مشروب شائع وتغيّر في الوزن لدى المشاركين" });
  assert.equal(p, "research_study");
});

test("an ambiguous English observational study routes to research_study (sensitive)", () => {
  const p = selectProfile({ sourceText: "Observational study links a common drink to lower risk" });
  assert.equal(p, "research_study");
});

test("sensitiveProfileHint favors safety over research and returns null when benign", () => {
  assert.equal(sensitiveProfileHint("سحب دفعة من دواء بسبب تلوث"), "safety_alert");
  assert.equal(sensitiveProfileHint("دراسة محكّمة على عيّنة كبيرة"), "research_study");
  // A medicine merely being available is NOT a safety alert (no risk term).
  assert.equal(sensitiveProfileHint("دواء جديد متوفر الآن في صيدليات الكويت"), null);
  assert.equal(sensitiveProfileHint("وزارة الصحة تفتتح مركزاً صحياً جديداً"), null);
});

test("a plausible safety story never routes to the cheaper default profile", () => {
  // regulation-ish wording ("وزارة") PLUS a genuine recall must stay safety_alert.
  const p = selectProfile({ sourceText: "وزارة الصحة: سحب دفعة دواء ملوّثة وتحذير المرضى من استخدامها" });
  assert.equal(p, "safety_alert");
});

// --- E1.3C final review: grounding excludes the discovery draft (Req 1/5) --

// Simulates the production split: the fabricated statement lives ONLY in the
// discovery draft; the VERIFIED fact packet is the citation title + source name.
const DISCOVERY_FABRICATION =
  "كشفت دراسة أن المشروب يسبب المرض وأصاب 4823 شخصاً خلال أسبوع واحد فقط."; // invented number + causation
const VERIFIED_FACTS = [
  "دراسة رصدية تربط بين مشروب شائع وتغيّر في الوزن", // provider citation title
  "الجمعية الطبية", // verified source/org name
].join("\n");

test("(a) a fabricated discovery-only statement is NOT part of the verified fact set", () => {
  // The fabrication (invented number + causal claim) lives only in the discovery
  // draft; the verified packet contains neither.
  assert.ok(DISCOVERY_FABRICATION.includes("4823"));
  assert.ok(!VERIFIED_FACTS.includes("4823"));
  assert.ok(!VERIFIED_FACTS.includes("يسبب"));
  // A body echoing the discovery fabrication is blocked when grounded on verified facts.
  const v = validateArticle({
    article: {
      title: "دراسة تحذّر من مشروب شائع وأثره على الصحة",
      excerpt: "",
      body:
        DISCOVERY_FABRICATION + " " +
        repeatTo(200, "يتابع الباحثون العلاقة بين المشروب وتغيّر الوزن لدى المشاركين"),
      profile: "research_study",
    },
    source: { sourceText: VERIFIED_FACTS },
  });
  assert.equal(v.ok, false);
  // The invented number, which exists only in the discovery draft, is caught
  // because grounding compares against the verified facts, not the draft.
  assert.ok(v.errors.some((e) => e.startsWith("unsupported_number")));
});

test("(b) the writer repeating the fabricated discovery number is blocked", () => {
  const { errors } = checkFactGrounding(
    { title: "خبر صحي", excerpt: "", body: "أصاب المرض 4823 شخصاً هذا الأسبوع." },
    { sourceText: VERIFIED_FACTS },
    "standard_news",
  );
  assert.ok(errors.some((e) => e === "unsupported_number:4823"));
});

test("(c) a genuine fact present in the verified citation packet passes", () => {
  // "1200" and the org name ARE in the verified packet, so grounding accepts them.
  const verified = ["دراسة محكّمة شملت 1200 مشارك", "جامعة الكويت"].join("\n");
  const { errors } = checkFactGrounding(
    { title: "دراسة", excerpt: "", body: "شملت الدراسة 1200 مشارك من جامعة الكويت." },
    { sourceText: verified },
    "research_study",
  );
  assert.deepEqual(errors, []);
});

// --- E1.3C final review: safety-alert essential entity is blocking (Req 4) -

test("a safety alert dropping a verified essential entity is BLOCKING", () => {
  const body =
    "أصدرت الجهة تحذيراً بشأن سحب دفعة من أحد المنتجات الطبية ونصحت بالتوقف عن استخدامها. " +
    repeatTo(130, "تتابع الجهة المختصة الوضع وتدعو المرضى إلى الحيطة وسحب المنتج المتأثّر");
  const v = validateArticle({
    article: { title: "تحذير من سحب منتج طبي واسع الانتشار", excerpt: "", body, profile: "safety_alert" },
    // Verified org name that the article failed to mention.
    source: { sourceText: "تحذير: سحب دفعة من منتج طبي.", mustPreserve: ["هيئة الغذاء والدواء"] },
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e === "missing_essential_entity:هيئة الغذاء والدواء"));
});

test("ordinary news keeps a missing essential entity as a non-blocking warning", () => {
  const body =
    "أطلقت الجهة خدمة جديدة للحجز الإلكتروني تتيح للمراجعين تحديد المواعيد بسهولة. " +
    repeatTo(180, "توضّح الخدمة الجديدة خطوات الحجز والوصول للمراجعين في مختلف المراكز");
  const v = validateArticle({
    article: { title: "خدمة حجز إلكتروني جديدة تسهّل المواعيد للمراجعين", excerpt: "", body, profile: "standard_news" },
    source: { sourceText: "خدمة حجز إلكتروني جديدة.", mustPreserve: ["مركز المعلومات الصحية"] },
  });
  assert.equal(v.ok, true); // not blocked
  assert.ok(v.warnings.some((w) => w === "missing_essential_entity:مركز المعلومات الصحية"));
});

// --- E1.3C/D pilot review: safety-alert official actions & reassurance ------

test("official-action extraction is deterministic (Arabic + English)", () => {
  assert.deepEqual(extractOfficialActions("يرجى التوقف عن استخدام المنتج فوراً").sort(), ["stop_use"]);
  assert.deepEqual(extractOfficialActions("Consumers should stop using it and return the product").sort(), [
    "return",
    "stop_use",
  ]);
  assert.deepEqual(extractOfficialActions("ينصح باستشارة الطبيب عند ظهور أعراض").sort(), ["seek_help"]);
  assert.deepEqual(extractOfficialActions("خبر عادي دون أي إجراء مطلوب"), []);
});

test("a safety alert that DROPS the source's official action is BLOCKED", () => {
  const src =
    "أصدرت هيئة الغذاء والدواء تحذيراً بسحب دفعة من الدواء، وطلبت من المرضى التوقف عن استخدام الدواء فوراً.";
  const body =
    "أعلنت هيئة الغذاء والدواء سحب دفعة من الدواء بعد رصد خلل في التصنيع. " +
    repeatTo(130, "تتابع الجهة الوضع وتشير إلى أن السحب يشمل الدفعة المتأثّرة من الدواء فقط");
  const { errors } = checkFactGrounding(
    { title: "سحب دفعة من الدواء بعد رصد خلل", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(errors.includes("missing_official_action"));
});

test("a safety alert PRESERVING the source's official action passes that check", () => {
  const src =
    "طلبت الجهة من المرضى التوقف عن استخدام الدواء فوراً بعد رصد تلوث في دفعة محددة.";
  const body =
    "دعت الجهة المرضى إلى التوقف عن استخدام الدواء فوراً بعد رصد تلوث في الدفعة. " +
    repeatTo(130, "تؤكد الجهة أن التوقف عن استخدام الدواء إجراء احترازي حتى انتهاء الفحص");
  const { errors } = checkFactGrounding(
    { title: "دعوة للتوقف عن استخدام دواء بعد رصد تلوث", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(!errors.includes("missing_official_action"));
  assert.ok(!errors.some((e) => e.startsWith("invented_official_action")));
});

test("a safety alert INVENTING an action the source never stated is BLOCKED", () => {
  // Source only asks to stop use; the article invents "return the product".
  const src = "طلبت الجهة من المستهلكين التوقف عن استخدام المنتج.";
  const body =
    "دعت الجهة إلى التوقف عن استخدام المنتج، وطالبت المستهلكين بإرجاع المنتج إلى نقاط البيع. " +
    repeatTo(130, "أوضحت الجهة أن التوقف عن استخدام المنتج إجراء وقائي يشمل الدفعة المعنية");
  const { errors } = checkFactGrounding(
    { title: "دعوة للتوقف عن استخدام منتج وإرجاعه", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(errors.includes("invented_official_action:return"));
});

test("dropping a clear 'other batches are safe' reassurance is BLOCKED", () => {
  const src =
    "يقتصر السحب على الدفعة المتأثرة، أما باقي الدفعات فهي غير متأثرة وآمنة للاستخدام. " +
    "وطلبت الجهة التوقف عن استخدام الدفعة المعنية.";
  const body =
    "أعلنت الجهة سحب الدفعة المعنية وطلبت التوقف عن استخدامها. " +
    repeatTo(130, "يشمل السحب الدفعة المتأثّرة وتتابع الجهة المختصة الوضع عن كثب");
  const { errors } = checkFactGrounding(
    { title: "سحب دفعة متأثرة والتوقف عن استخدامها", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(hasUnaffectedBatchStatement(src));
  assert.ok(!hasUnaffectedBatchStatement(body));
  assert.ok(errors.includes("missing_unaffected_batch_statement"));
});

test("keeping the 'other batches are safe' reassurance passes that check", () => {
  const src =
    "يقتصر السحب على الدفعة المتأثرة، أما باقي الدفعات فهي غير متأثرة وآمنة. وطلبت الجهة التوقف عن استخدام الدفعة المعنية.";
  const body =
    "أعلنت الجهة سحب الدفعة المتأثرة وطلبت التوقف عن استخدامها، مؤكدة أن باقي الدفعات غير متأثرة وآمنة. " +
    repeatTo(130, "توضّح الجهة أن السحب يقتصر على الدفعة المعنية وتتابع الوضع عن كثب");
  const { errors } = checkFactGrounding(
    { title: "سحب دفعة متأثرة مع بقاء غيرها آمناً", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(!errors.includes("missing_unaffected_batch_statement"));
});

test("these safety-alert action rules do NOT fire for non-safety profiles", () => {
  // A research story that happens to mention stopping a habit must not be
  // subject to the safety-alert official-action requirement.
  const { errors } = checkFactGrounding(
    { title: "دراسة حول عادات النوم", excerpt: "", body: "توصي الدراسة بتقليل الكافيين مساءً لتحسين النوم." },
    { sourceText: "دراسة: التوقف عن استخدام الأجهزة قبل النوم يرتبط بنوم أفضل." },
    "research_study",
  );
  assert.ok(!errors.includes("missing_official_action"));
  assert.ok(!errors.includes("missing_unaffected_batch_statement"));
});

// --- E1.3F targeted-pilot fix: broadened actions + audience awareness -------
// Exact FDA (Papaverine recall) wording that the earlier source-side parser
// failed to recognize, producing the false-positive `invented_official_action:
// return`. These lock in the broadened return/discard detection and the new
// conservative, non-blocking audience check.

test("FDA wording 'return to place of purchase' + 'discard' are detected", () => {
  assert.deepEqual(
    extractOfficialActions(
      "Distributors, retailers and healthcare facilities should stop using and " +
        "return to place of purchase or discard the product.",
    ).sort(),
    ["discard", "return", "stop_use"],
  );
});

test("FDA wording 'arranging for return/replacement' is detected as return", () => {
  assert.deepEqual(
    extractOfficialActions(
      "American Regent, Inc. is arranging for return/replacement of all recalled products.",
    ).sort(),
    ["return"],
  );
});

test("FDA wording 'return or discard' detects BOTH return and discard", () => {
  const a = extractOfficialActions("Please return or discard the recalled product.");
  assert.ok(a.includes("return"));
  assert.ok(a.includes("discard"));
});

test("FDA wording patient 'stop using and contact doctor' detects stop_use + contact/seek_help", () => {
  const a = extractOfficialActions(
    "Patients should stop using them and contact their doctor or health care provider.",
  );
  assert.ok(a.includes("stop_use"));
  assert.ok(a.includes("contact") || a.includes("seek_help"));
});

test("Arabic 'إعادة المنتج إلى مكان الشراء' and 'التخلص من المنتج' are detected", () => {
  assert.ok(extractOfficialActions("يرجى إعادة المنتج إلى مكان الشراء").includes("return"));
  assert.ok(extractOfficialActions("يجب التخلص من المنتج بأمان").includes("discard"));
});

test("a safety alert mentioning return PASSES when the verified source contains return", () => {
  // This is the corrected FDA case: the source DOES instruct return, so an
  // Arabic article that faithfully renders it must no longer be flagged.
  const src =
    "Distributors and healthcare facilities should stop using and return to place of " +
    "purchase or discard the product.";
  const body =
    "دعت الجهة الموزّعين والمنشآت الصحية إلى التوقف عن استخدام المنتج وإرجاعه إلى مكان الشراء أو التخلص من المنتج. " +
    repeatTo(130, "تتابع الجهة الوضع وتوضح أن السحب يشمل الدفعة المعنية فقط");
  const { errors } = checkFactGrounding(
    { title: "سحب منتج ودعوة الموزّعين لإعادته", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(!errors.some((e) => e.startsWith("invented_official_action")));
  assert.ok(!errors.includes("missing_official_action"));
});

test("a safety alert mentioning return is STILL BLOCKED when the source lacks return", () => {
  // Absent-action rule must NOT be weakened: source asks only to stop use and
  // contact a doctor; inventing a return instruction is still a rejection.
  const src = "Patients should stop using the product and contact their doctor.";
  const body =
    "دعت الجهة المرضى إلى التوقف عن استخدام المنتج وإرجاعه إلى نقاط البيع. " +
    repeatTo(130, "توضّح الجهة أن التوقف عن استخدام المنتج إجراء وقائي يشمل الدفعة المعنية");
  const { errors } = checkFactGrounding(
    { title: "دعوة للتوقف عن استخدام منتج", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(errors.includes("invented_official_action:return"));
});

test("officialActionsByAudience attributes each action to the audience addressed", () => {
  const src =
    "Distributors and healthcare facilities should stop using and return to place of " +
    "purchase or discard the product. Patients should stop using them and contact their doctor.";
  const { facility, patient } = officialActionsByAudience(src);
  assert.ok(facility.has("return"));
  assert.ok(facility.has("discard"));
  assert.ok(!patient.has("return"));
  assert.ok(!patient.has("discard"));
  assert.ok(patient.has("stop_use"));
});

test("safety_alert: facility-only return AND discard aimed at patients is BLOCKED", () => {
  const src =
    "Distributors and healthcare facilities should stop using and return to place of " +
    "purchase or discard the product. " +
    "Patients should stop using them and contact their doctor or health care provider.";
  const body =
    "دعت الجهة المرضى إلى التوقف عن استخدام المنتج وإرجاعه إلى مكان الشراء أو التخلص من المنتج. " +
    repeatTo(130, "تتابع الجهة الوضع وتوضح أن السحب يشمل الدفعة المعنية فقط");
  const { errors } = checkFactGrounding(
    { title: "سحب منتج وإرشادات للمرضى", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  // Source directs return/discard at facilities only; the article aims them at
  // patients — for a safety alert this now BLOCKS the draft.
  assert.ok(errors.includes("audience_misdirected_action:return"));
  assert.ok(errors.includes("audience_misdirected_action:discard"));
  // Not an invented action — the source DOES contain these (just for facilities).
  assert.ok(!errors.some((e) => e.startsWith("invented_official_action")));
});

test("safety_alert: correct audience separation PASSES (no misdirected block)", () => {
  const src =
    "Distributors and healthcare facilities should stop using and return to place of " +
    "purchase or discard the product. " +
    "Patients should stop using them and contact their doctor or health care provider.";
  const body =
    "دعت الجهة الموزّعين والمنشآت الصحية إلى التوقف عن استخدام المنتج وإرجاعه إلى مكان الشراء أو التخلص من المنتج، " +
    "بينما على المرضى التوقف عن استخدام المنتج والتواصل مع الطبيب. " +
    repeatTo(130, "تتابع الجهة الوضع وتوضح أن السحب يشمل الدفعة المعنية فقط");
  const { errors } = checkFactGrounding(
    { title: "سحب منتج بإرشادات لكل فئة", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(!errors.some((e) => e.startsWith("audience_misdirected_action")));
  assert.ok(!errors.some((e) => e.startsWith("invented_official_action")));
});

test("safety_alert: an action given to BOTH audiences by the source PASSES for patients", () => {
  // Source tells patients themselves to return, so the article may too.
  const src =
    "Distributors should return the product to place of purchase. " +
    "Patients should also return the product and stop using it.";
  const body =
    "دعت الجهة المرضى إلى التوقف عن استخدام المنتج وإرجاعه إلى مكان الشراء. " +
    repeatTo(130, "تتابع الجهة الوضع وتوضح أن السحب يشمل الدفعة المعنية فقط");
  const { errors } = checkFactGrounding(
    { title: "سحب منتج ودعوة الجميع لإعادته", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(!errors.some((e) => e.startsWith("audience_misdirected_action")));
});

test("non-safety profile keeps misdirected audience as a WARNING, not a block", () => {
  const src =
    "Distributors and healthcare facilities should return to place of purchase or discard the product. " +
    "Patients should stop using it and contact their doctor.";
  const body =
    "توصي الدراسة المرضى بإعادة المنتج إلى مكان الشراء أو التخلص من المنتج. " +
    repeatTo(130, "تتابع الجهة الوضع وتوضح تفاصيل المتابعة للمعنيين");
  const { errors, warnings } = checkFactGrounding(
    { title: "دراسة حول منتج", excerpt: "", body },
    { sourceText: src },
    "research_study",
  );
  assert.ok(warnings.includes("audience_misdirected_action:return"));
  assert.ok(warnings.includes("audience_misdirected_action:discard"));
  assert.ok(!errors.some((e) => e.startsWith("audience_misdirected_action")));
});

test("safety_alert: FDA Papaverine wording PASSES when accurately represented", () => {
  // Facilities get return/discard; patients get stop-use + contact a doctor.
  // An article that mirrors that split must not be blocked.
  const src =
    "Distributors, retailers and healthcare facilities that have the recalled product " +
    "should stop using and return to place of purchase or discard the product. " +
    "Patients that use this recalled product should stop using it and contact their " +
    "doctor or health care provider.";
  const body =
    "أوصت الجهة الموزّعين وتجار التجزئة والمنشآت الصحية بالتوقف عن استخدام المنتج المسحوب وإرجاعه إلى مكان الشراء أو التخلص من المنتج، " +
    "فيما ينبغي على المرضى التوقف عن استخدام المنتج والتواصل مع الطبيب. " +
    repeatTo(140, "تتابع الجهة الوضع وتوضح أن السحب يشمل الدفعة المعنية فقط وتبقى بقية المنتجات غير متأثرة");
  const { errors } = checkFactGrounding(
    { title: "سحب منتج بابافيرين وإرشادات لكل فئة", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(!errors.some((e) => e.startsWith("audience_misdirected_action")));
  assert.ok(!errors.some((e) => e.startsWith("invented_official_action")));
  assert.ok(!errors.includes("missing_official_action"));
});

// --- Editorial compression & reader relevance (E1.3G) ----------------------
//
// Core principle under test: a fact required for VALIDATION/PRESERVATION is not
// automatically required to appear in the PUBLISHED article. Verification-only
// identifiers (lot/NDC/registration codes) may stay in the fact packet without
// being forced into the visible story, while the reader-meaningful product
// identity must still appear for a safety alert.

// Verified FDA Papaverine fact packet (English source) reused as the regression
// fixture: facilities return/discard, patients stop-use + contact a doctor, no
// adverse events reported, other lots unaffected.
const PAPAVERINE_SOURCE =
  "FDA announces a voluntary recall of one lot of Papaverine Hydrochloride Injection, USP " +
  "due to the presence of particulate matter found in the vials. Lot 25202, NDC 0517-4002-25. " +
  "Distributors, retailers and healthcare facilities that have the recalled product should stop " +
  "using and return to place of purchase or discard the product. Patients that use this recalled " +
  "product should stop using it and contact their doctor or health care provider. To date, no " +
  "adverse events have been reported related to this recall. Other lots are not affected and remain safe.";

// The entities a real extraction yields: the product identity (kept) and the
// lot code (verification-only — omit from the visible article).
const PAPAVERINE_MUST_PRESERVE = ["Papaverine Hydrochloride", "25202"];

test("isCodeLikeEntity: only opaque codes/bare numbers are code-like; names are not", () => {
  assert.equal(isCodeLikeEntity("25202"), true); // lot
  assert.equal(isCodeLikeEntity("0517-4002-25"), true); // NDC
  assert.equal(isCodeLikeEntity("L2291"), true); // batch code
  assert.equal(isCodeLikeEntity("١٢٠٠"), true); // Arabic-digit number
  assert.equal(isCodeLikeEntity("8400"), true); // a bare number is code-like by SHAPE...
  // Reader-meaningful identity / context are never code-like.
  assert.equal(isCodeLikeEntity("Papaverine Hydrochloride"), false);
  assert.equal(isCodeLikeEntity("الكويت"), false);
  assert.equal(isCodeLikeEntity("هيئة الغذاء والدواء"), false);
});

test("classifyEntityVisibility: shape alone does NOT decide — profile + context do", () => {
  // The SAME bare number "8400" is essential in a study (a sample size the
  // reader needs) but verification-only when it sits behind an NDC/registration
  // label — proving classification is context-aware, not shape-based.
  const study =
    "A study of 8400 participants over 12 weeks found an 18% reduction in risk. " +
    "The association does not prove causation.";
  assert.equal(classifyEntityVisibility("8400", "research_study", study), "essential");

  const reg =
    "Registration no. 8400 was issued for the facility. The new fee of 25 KD is " +
    "effective from 2026-09-01.";
  assert.equal(classifyEntityVisibility("8400", "regulation_or_service", reg), "verification_only");

  // A safety-alert lot code is CONDITIONAL (needed only to disambiguate).
  assert.equal(classifyEntityVisibility("25202", "safety_alert", PAPAVERINE_SOURCE), "conditional");
  // The NDC (opaque, hyphenated, cued by "NDC") is verification-only.
  assert.equal(classifyEntityVisibility("0517-4002-25", "safety_alert", PAPAVERINE_SOURCE), "verification_only");
  // A reader-facing name is always essential regardless of profile.
  assert.equal(classifyEntityVisibility("Papaverine Hydrochloride", "safety_alert", PAPAVERINE_SOURCE), "essential");
});

test("safety alert: a compact article omitting lot/NDC still validates", () => {
  const body =
    "أعلنت هيئة الغذاء والدواء الأميركية سحب دفعة من حقن بابافيرين Papaverine Hydrochloride " +
    "بعد العثور على جسيمات دقيقة داخل العبوات قد تؤذي المرضى إذا دخلت مجرى الدم.\n\n" +
    "ونصحت الجهة المرضى الذين يستخدمون المنتج المسحوب بالتوقف عن استخدامه والتواصل مع الطبيب " +
    "عند ظهور أي أعراض. أما الموزّعون والصيدليات والمنشآت الصحية فعليهم إرجاع المنتج إلى مكان " +
    "الشراء أو التخلص من المنتج.\n\n" +
    "ولم تُسجّل حتى الآن أي أعراض جانبية مرتبطة بهذا السحب، فيما تبقى بقية الدفعات غير متأثرة " +
    "وآمنة للاستخدام وفق ما أعلنته الجهة المختصة.";
  const v = validateArticle({
    article: {
      title: "سحب دفعة من حقن بابافيرين في أميركا بعد العثور على جسيمات داخل العبوات",
      excerpt:
        "أعلنت السلطات الأميركية سحب دفعة من حقن بابافيرين بعد رصد جسيمات غريبة داخل العبوات قد تشكّل خطراً على المرضى.",
      body,
      profile: "safety_alert",
    },
    source: { sourceText: PAPAVERINE_SOURCE, mustPreserve: PAPAVERINE_MUST_PRESERVE },
  });
  // The lot code 25202 and NDC were omitted, yet the article is still creatable:
  // grounding no longer forces verification-only identifiers into the story.
  assert.equal(v.ok, true);
  assert.ok(!v.errors.some((e) => e.startsWith("missing_essential_entity")));
  // No editorial complaints on the compact, well-formed article.
  assert.ok(!v.warnings.some((w) => w.startsWith("editorial_")));
});

test("safety alert: dropping the product identity STILL fails", () => {
  // Same story but the article never names the product at all.
  const body =
    "أعلنت الجهة سحب دفعة من أحد المستحضرات بعد العثور على جسيمات داخل العبوات قد تؤذي المرضى.\n\n" +
    "ونصحت المرضى بالتوقف عن استخدام المنتج والتواصل مع الطبيب، وطلبت من الموزّعين والمنشآت الصحية " +
    "إرجاع المنتج إلى مكان الشراء أو التخلص من المنتج.\n\n" +
    "ولم تُسجّل أي أعراض جانبية، فيما تبقى بقية الدفعات غير متأثرة وآمنة.";
  const v = validateArticle({
    article: { title: "سحب دفعة من مستحضر طبي بعد رصد جسيمات", excerpt: "", body, profile: "safety_alert" },
    source: { sourceText: PAPAVERINE_SOURCE, mustPreserve: PAPAVERINE_MUST_PRESERVE },
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e === "missing_essential_entity:Papaverine Hydrochloride"));
  // The omitted lot code is NOT itself a reason (verification-only).
  assert.ok(!v.errors.some((e) => e === "missing_essential_entity:25202"));
});

test("editorial warnings: a regulatory-detail-heavy article is flagged", () => {
  const body =
    "أعلنت FDA سحب دفعة من Papaverine Hydrochloride Injection رقم الدفعة 25202 ورقم NDC 0517-4002-25 " +
    "بسبب رصد جسيمات، في إطار عملية recall رسمية. " +
    "ويجب على المرضى التوقف عن استخدام Papaverine Hydrochloride Injection والتواصل مع الطبيب. " +
    "وعلى الموزّعين والمنشآت الصحية إرجاع Papaverine Hydrochloride Injection إلى مكان الشراء أو التخلص من المنتج. " +
    "وتبقى بقية الدفعات غير متأثرة وآمنة.";
  const warnings = editorialQualityWarnings(
    { title: "FDA تعلن recall لدفعة Papaverine Hydrochloride Injection رقم 25202", excerpt: "", body },
    "safety_alert",
    { verificationOnly: ["25202"] },
  );
  assert.ok(warnings.includes("editorial_english_name_repeated"));
  assert.ok(warnings.includes("editorial_excess_english_tokens"));
  assert.ok(warnings.includes("editorial_excess_identifiers"));
});

test("editorial warnings: excerpt duplicating the title is flagged", () => {
  const warnings = editorialQualityWarnings(
    {
      title: "سحب دفعة من حقن بابافيرين بعد العثور على جسيمات",
      excerpt: "سحب دفعة من حقن بابافيرين بعد العثور على جسيمات",
      body: "أعلنت الجهة سحب دفعة من الحقن بعد رصد جسيمات، ونصحت المرضى بالتوقف عن استخدامها فوراً.",
    },
    "safety_alert",
  );
  assert.ok(warnings.includes("editorial_excerpt_duplicates_title"));
});

test("editorial warnings: an over-long body is flagged as a compression opportunity", () => {
  const longBody = repeatTo(PROFILE_WORD_BANDS.quick_news.max + 40, "تتابع الجهة الوضع الصحي وتنشر تفاصيل إضافية للقارئ");
  const warnings = editorialQualityWarnings(
    { title: "خبر صحي سريع واضح ومناسب للطول المطلوب", excerpt: "موجز مختلف تماماً عن العنوان", body: longBody },
    "quick_news",
  );
  assert.ok(warnings.includes("editorial_body_over_length"));
});

// --- Profile-aware relevance regressions (research / regulation / safety) ---
//
// These prove the fix for the blanket shape rule: a number is NOT automatically
// verification-only. Its relevance depends on the article profile and context.

test("research study: an 8400 sample and 18% result stay visible and grounded", () => {
  const src =
    "A study of 8400 participants followed over 12 weeks found an 18% reduction in risk. " +
    "Researchers said the association does not prove causation, citing sample limitations.";
  // Sample size is reader-essential for a study, not a verification-only code.
  assert.equal(classifyEntityVisibility("8400", "research_study", src), "essential");
  const body =
    "أظهرت دراسة حديثة شملت 8400 مشارك جرت متابعتهم على مدى 12 أسبوعاً أن الخطر انخفض بنسبة 18% لدى المجموعة المتابَعة. " +
    "وأوضح الباحثون أن هذه النتيجة تمثّل ارتباطاً إحصائياً يستدعي مزيداً من الدراسة قبل تعميمه. " +
    repeatTo(210, "وأشار الفريق إلى محدودية حجم العينة وإلى الحاجة لدراسات أوسع قبل تعميم النتائج على عموم السكان");
  const v = validateArticle({
    article: {
      title: "دراسة تكشف انخفاض الخطر لدى آلاف المشاركين خلال أسابيع من المتابعة",
      excerpt: "خلصت دراسة على آلاف المشاركين إلى انخفاض ملموس في الخطر خلال أسابيع من المتابعة.",
      body,
      profile: "research_study",
    },
    source: { sourceText: src, mustPreserve: ["8400"] },
  });
  assert.equal(v.ok, true);
  assert.ok(body.includes("8400")); // sample size surfaced
  assert.ok(body.includes("18%")); // effect size surfaced and grounded
  assert.ok(!v.errors.some((e) => e.startsWith("missing_essential_entity")));
  assert.ok(!v.warnings.includes("editorial_excess_identifiers"));
});

test("regulation: fee/effective date stay visible; an irrelevant NDC/date are verification-only", () => {
  const src =
    "The Ministry set a new fee of 25 KD, effective from 2026-09-01. " +
    "An unrelated registration NDC 0517-4002-25 and a distribution date of 2026-01-05 also appear on file.";
  // Reader-relevant regulatory numbers → essential.
  assert.equal(classifyEntityVisibility("25", "regulation_or_service", src), "essential");
  assert.equal(classifyEntityVisibility("2026-09-01", "regulation_or_service", src), "essential");
  // Bureaucratic identifiers → verification-only (safe to omit).
  assert.equal(classifyEntityVisibility("0517-4002-25", "regulation_or_service", src), "verification_only");
  assert.equal(classifyEntityVisibility("2026-01-05", "regulation_or_service", src), "verification_only");

  const body =
    "قرّرت الوزارة فرض رسم جديد قدره 25 ديناراً يبدأ سريانه اعتباراً من 2026-09-01 على الفئات المعنية. " +
    repeatTo(170, "وأوضحت الوزارة أن القرار يسري على جميع المشمولين وتتوفر تفاصيله عبر قنواتها الرسمية للمراجعين");
  const v = validateArticle({
    article: {
      title: "الوزارة تفرض رسماً جديداً قدره 25 ديناراً اعتباراً من سبتمبر",
      excerpt: "أقرّت الوزارة رسماً جديداً يبدأ سريانه مطلع سبتمبر على الفئات المعنية.",
      body,
      profile: "regulation_or_service",
    },
    source: { sourceText: src, mustPreserve: ["25", "0517-4002-25"] },
  });
  assert.equal(v.ok, true);
  // Omitting the NDC does not block the draft.
  assert.ok(!v.errors.some((e) => e.startsWith("missing_essential_entity")));
});

test("safety alert: batch/strength is REQUIRED when multiple variants are ambiguous", () => {
  const src =
    "FDA recalls two lots of an injection: 250 mg and 500 mg strengths. " +
    "Lots 25202 and 25203 are affected. Patients should stop using and contact their doctor.";
  // Two strengths / two lots → the identifier is needed to disambiguate.
  assert.equal(safetyIdentifierNeeded(src), true);
  assert.equal(classifyEntityVisibility("25202", "safety_alert", src), "conditional");
  const body =
    "أعلنت الجهة سحب دفعات من أحد المستحضرات الدوائية بعد رصد مشكلة في التصنيع. " +
    "ونصحت المرضى بالتوقف عن استخدام المنتج والتواصل مع الطبيب. " +
    repeatTo(140, "وتتابع الجهة الوضع وتوضح تفاصيل السحب للمعنيين عبر قنواتها الرسمية");
  const v = validateArticle({
    article: { title: "سحب دفعات من مستحضر دوائي ونصائح للمرضى", excerpt: "", body, profile: "safety_alert" },
    source: { sourceText: src, mustPreserve: ["25202"] },
  });
  // The ambiguous batch omission now BLOCKS: the reader can't tell which variant.
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e === "missing_essential_entity:25202"));
});

// --- Optional "باختصار" summary field (additive schema) --------------------

test("parser accepts an optional summary field", () => {
  const r = parseWriterOutput(
    '{"title":"عنوان صحي واضح ومناسب","excerpt":"موجز","summary":"جملة باختصار للقارئ المستعجل","body":"نص الخبر الكامل هنا."}',
  );
  assert.ok(r.ok);
  assert.equal(r.ok && r.article.summary, "جملة باختصار للقارئ المستعجل");
});

test("the legacy three-field object still parses without a summary", () => {
  const r = parseWriterOutput('{"title":"عنوان صحي واضح","excerpt":"موجز","body":"نص الخبر الكامل."}');
  assert.ok(r.ok);
  assert.equal(r.ok && "summary" in r.article, false);
});

test("a non-string summary is a schema violation", () => {
  const r = parseWriterOutput('{"title":"عنوان","excerpt":"","body":"نص","summary":123}');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_schema_invalid");
});

test("an oversized summary is a schema violation", () => {
  const huge = "ا".repeat(401);
  const r = parseWriterOutput(`{"title":"عنوان","excerpt":"","body":"نص كافٍ للخبر","summary":"${huge}"}`);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "writer_output_schema_invalid");
});

test("writing instructions carry the compression rules and optional summary field", () => {
  const instr = buildWritingInstructions("safety_alert");
  assert.ok(instr.includes("مبدأ التركيز التحريري"));
  assert.ok(instr.includes("باختصار"));
  assert.ok(instr.includes("\"summary\""));
  // Still a bare object with the three required fields and no profile field.
  assert.ok(instr.includes("\"title\""));
  assert.ok(instr.includes("\"body\""));
  assert.ok(!instr.includes("\"profile\""));
});

// --- Arabic-first foreign-name naming contract -----------------------------
//
// A reader-essential foreign proper name must appear as «Arabic (Exact Original)»
// at the first mention only, then Arabic alone, with an Arabic-only title. The
// exact original identity must survive; formal/regulatory suffixes are removable.

test("stripFormalSuffixes: removes formal/regulatory suffixes, keeps identity", () => {
  assert.equal(stripFormalSuffixes("Cyclophosphamide for Injection, USP"), "Cyclophosphamide");
  assert.equal(stripFormalSuffixes("Papaverine Hydrochloride Injection, USP"), "Papaverine Hydrochloride");
  assert.equal(stripFormalSuffixes("Sunny Pharmtech Inc."), "Sunny Pharmtech");
  assert.equal(stripFormalSuffixes("Acme Labs LLC"), "Acme Labs");
  // A chemical descriptor that IS part of the identity is preserved.
  assert.equal(stripFormalSuffixes("Papaverine Hydrochloride"), "Papaverine Hydrochloride");
  // A standalone name is never truncated (no "co"/"inc" false strip).
  assert.equal(stripFormalSuffixes("Aramco"), "Aramco");
  assert.equal(stripFormalSuffixes("Cyclophosphamide"), "Cyclophosphamide");
});

test("foreignEssentialNameStatus: Arabic-first + exact parenthetical passes", () => {
  const s = foreignEssentialNameStatus({
    title: "سحب ثلاث دفعات من حقن سيكلوفوسفاميد بسبب جسيمات معدنية",
    visible:
      "سحبت شركة سني فارماتيك (Sunny Pharmtech) ثلاث دفعات من حقن سيكلوفوسفاميد (Cyclophosphamide) في الولايات المتحدة، بعد العثور على جسيمات معدنية داخل بعض العبوات.\n\nوطلبت من الصيدليات التوقف عن استخدام المنتج وإرجاعه.",
    entity: "Cyclophosphamide for Injection, USP",
  });
  assert.equal(s.status, "ok");
  assert.equal(s.firstMentionGloss, true);
  assert.equal(s.englishInTitle, false);
  assert.equal(s.englishRepeated, false);

  const p = foreignEssentialNameStatus({
    title: "سحب دفعة من حقن بابافيرين بعد العثور على جسيمات",
    visible:
      "سحبت شركة أميركية دفعة من حقن بابافيرين (Papaverine Hydrochloride)، بعد العثور على جسيمات داخل بعض العبوات.\n\nوطلبت من المرضى التوقف عن الاستخدام.",
    entity: "Papaverine Hydrochloride",
  });
  assert.equal(p.status, "ok");
  assert.equal(p.firstMentionGloss, true);
});

test("foreignEssentialNameStatus: dropping the exact original entirely fails", () => {
  const s = foreignEssentialNameStatus({
    title: "سحب حقن سيكلوفوسفاميد",
    visible: "سحبت شركة سني فارماتيك ثلاث دفعات من حقن سيكلوفوسفاميد بعد العثور على جسيمات معدنية.",
    entity: "Cyclophosphamide",
  });
  assert.equal(s.status, "missing");
  assert.equal(s.present, false);
});

test("foreignEssentialNameStatus: English-first wording is flagged, not clean", () => {
  const s = foreignEssentialNameStatus({
    title: "سحب حقن",
    visible: "Cyclophosphamide injection recalled بعد رصد جسيمات داخل قوارير سيكلوفوسفاميد.",
    entity: "Cyclophosphamide",
  });
  assert.equal(s.englishFirst, true);
  assert.equal(s.firstMentionGloss, false);
  assert.notEqual(s.status, "ok");
});

test("foreignEssentialNameStatus: English repeated after first mention is flagged", () => {
  const s = foreignEssentialNameStatus({
    title: "سحب حقن سيكلوفوسفاميد",
    visible:
      "سحبت الجهة حقن سيكلوفوسفاميد (Cyclophosphamide)، ثم أكدت أن Cyclophosphamide غير آمن للاستخدام.",
    entity: "Cyclophosphamide",
  });
  assert.equal(s.englishRepeated, true);
  assert.notEqual(s.status, "ok");
});

test("foreignEssentialNameStatus: English in the title is flagged", () => {
  const s = foreignEssentialNameStatus({
    title: "سحب دواء Cyclophosphamide للحقن",
    visible: "سحبت الجهة حقن سيكلوفوسفاميد (Cyclophosphamide) بعد رصد جسيمات.",
    entity: "Cyclophosphamide",
  });
  assert.equal(s.englishInTitle, true);
  assert.notEqual(s.status, "ok");
});

test("foreignEssentialNameStatus: a shortened identity does not silently pass", () => {
  // The protected identity is "Papaverine Hydrochloride"; a bare "Papaverine"
  // could change identity, so it must NOT count as present.
  const s = foreignEssentialNameStatus({
    title: "سحب حقن بابافيرين",
    visible: "سحبت الجهة حقن بابافيرين (Papaverine) بعد رصد جسيمات داخل العبوات.",
    entity: "Papaverine Hydrochloride",
  });
  assert.equal(s.status, "missing");
});

// Verified Arabic source for the fact-grounding integration checks below.
const CYCLO_CONTRACT_SOURCE =
  "سحبت شركة سني فارماتيك (Sunny Pharmtech) ثلاث دفعات من حقن سيكلوفوسفاميد (Cyclophosphamide for Injection, USP) " +
  "في الولايات المتحدة بعد العثور على جسيمات معدنية داخل بعض العبوات. وطلبت من الصيدليات والمستشفيات التوقف عن " +
  "استخدام المنتج وإرجاعه إلى مكان الشراء.";

test("checkFactGrounding: an Arabic-first gloss for a foreign entity is grounded", () => {
  const { errors } = checkFactGrounding(
    {
      title: "سحب ثلاث دفعات من حقن سيكلوفوسفاميد بسبب جسيمات معدنية",
      excerpt: "قرار احترازي بعد العثور على جسيمات معدنية داخل بعض العبوات.",
      body:
        "سحبت شركة سني فارماتيك (Sunny Pharmtech) ثلاث دفعات من حقن سيكلوفوسفاميد (Cyclophosphamide) في الولايات المتحدة، بعد العثور على جسيمات معدنية داخل بعض العبوات.\n\n" +
        "وطلبت الشركة من الصيدليات والمستشفيات التوقف عن استخدام المنتج وإرجاعه إلى مكان الشراء.",
    },
    { sourceText: CYCLO_CONTRACT_SOURCE, mustPreserve: ["Cyclophosphamide for Injection, USP", "Sunny Pharmtech"] },
    "safety_alert",
  );
  assert.ok(!errors.some((e) => e.startsWith("missing_essential_entity")));
});

test("checkFactGrounding: dropping the parenthetical protected identity fails safely", () => {
  const { errors } = checkFactGrounding(
    {
      title: "سحب ثلاث دفعات من حقن سيكلوفوسفاميد بسبب جسيمات معدنية",
      excerpt: "قرار احترازي بعد العثور على جسيمات معدنية داخل بعض العبوات.",
      body:
        "سحبت شركة سني فارماتيك ثلاث دفعات من حقن سيكلوفوسفاميد في الولايات المتحدة، بعد العثور على جسيمات معدنية داخل بعض العبوات.\n\n" +
        "وطلبت الشركة من الصيدليات والمستشفيات التوقف عن استخدام المنتج وإرجاعه إلى مكان الشراء.",
    },
    { sourceText: CYCLO_CONTRACT_SOURCE, mustPreserve: ["Cyclophosphamide"] },
    "safety_alert",
  );
  assert.ok(errors.includes("missing_essential_entity:Cyclophosphamide"));
});

test("validateArticle: approved Papaverine Arabic-first gloss passes identity validation", () => {
  const v = validateArticle({
    article: {
      title: "سحب دفعة من حقن بابافيرين بعد العثور على جسيمات داخل العبوات",
      excerpt: "قرار احترازي بعد رصد جسيمات داخل بعض العبوات قد تضر المرضى.",
      body:
        "سحبت السلطات الأميركية دفعة من حقن بابافيرين (Papaverine Hydrochloride) بعد العثور على جسيمات داخل بعض العبوات قد تؤذي المرضى إذا دخلت مجرى الدم.\n\n" +
        "ونصحت المرضى الذين يستخدمون المنتج بالتوقف عن استخدامه والتواصل مع الطبيب، فيما طُلب من الموزّعين والمنشآت الصحية إرجاع المنتج إلى مكان الشراء أو التخلص منه.\n\n" +
        "ولم تُسجَّل حتى الآن أي أعراض جانبية مرتبطة بهذا السحب، وتبقى بقية الدفعات غير متأثرة وآمنة.",
      profile: "safety_alert",
    },
    source: { sourceText: PAPAVERINE_SOURCE, mustPreserve: PAPAVERINE_MUST_PRESERVE },
  });
  assert.equal(v.ok, true);
  assert.ok(!v.errors.some((e) => e.startsWith("missing_essential_entity")));
  // A correct first-mention gloss raises none of the placement warnings.
  assert.ok(!v.warnings.some((w) => w.startsWith("essential_entity_")));
});

// --- Deterministic Arabic discard-equivalence (E1.5 action matcher) --------
//
// The disposal verb (التخلص من / تخلصوا من / إتلاف) followed by an explicit
// reference to the affected product, its stock/quantities, or an attached
// object pronoun (‑ه/‑ها/‑هما) referring back to the same product all count as
// the SAME "discard" action. This is a bounded whitelist of grammatical
// variants, never free-form fuzzy matching — an unrelated pronoun does not
// invent a discard, and discard stays distinct from return.

test("extractOfficialActions: التخلص منه counts as discard (pronoun form)", () => {
  const actions = extractOfficialActions(
    "على المنشآت الصحية إرجاع المنتج إلى مكان الشراء أو التخلص منه.",
  );
  assert.ok(actions.includes("discard"));
  assert.ok(actions.includes("return"));
});

test("extractOfficialActions: التخلص من الكميات المتأثرة counts as discard", () => {
  const actions = extractOfficialActions("يجب التخلص من الكميات المتأثرة فوراً.");
  assert.ok(actions.includes("discard"));
});

test("extractOfficialActions: إتلاف المنتج and إتلافه both count as discard", () => {
  assert.ok(extractOfficialActions("يُرجى إتلاف المنتج المسحوب.").includes("discard"));
  assert.ok(extractOfficialActions("يُرجى إتلافه على الفور.").includes("discard"));
});

test("extractOfficialActions: an unrelated pronoun does NOT invent a discard", () => {
  // "تخلّصنا من القلق" (we got rid of the worry) is not a disposal instruction:
  // no whitelisted noun and no attached object pronoun on the preposition.
  const actions = extractOfficialActions(
    "أكدت الجهة أنها تابعت الوضع عن كثب دون أي مخاطر على المرضى.",
  );
  assert.ok(!actions.includes("discard"));
});

test("extractOfficialActions: discard stays distinct from return", () => {
  // Return alone must never register as discard.
  const actions = extractOfficialActions("على الموزّعين إرجاع المنتج إلى مكان الشراء.");
  assert.ok(actions.includes("return"));
  assert.ok(!actions.includes("discard"));
});

// --- Audience separation is symmetric and BLOCKING for a safety alert ------
//
// #5 patient action cannot satisfy a facility action; #6 facility action
// cannot satisfy a patient action. Both directions block a safety alert.

test("safety_alert: facility-only discard (pronoun form) aimed at patients is BLOCKED", () => {
  // #6 mirror using the pronoun disposal form: the source assigns discard to
  // facilities only, the article tells patients to التخلص منه.
  const src =
    "Distributors and healthcare facilities should return to place of purchase " +
    "or discard the product. Patients should stop using it and contact their doctor.";
  const body =
    "دعت الجهة المرضى إلى التوقف عن استخدام المنتج والتخلص منه. " +
    repeatTo(130, "تتابع الجهة الوضع وتوضح أن السحب يشمل الدفعة المعنية فقط");
  const { errors } = checkFactGrounding(
    { title: "سحب منتج وإرشادات للمرضى", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(errors.includes("audience_misdirected_action:discard"));
  assert.ok(!errors.some((e) => e.startsWith("invented_official_action")));
});

test("safety_alert: patient-only contact action given to facilities is BLOCKED", () => {
  // #5: source assigns contact-a-doctor to patients only; the article puts it on
  // the facilities. A facility action cannot stand in for the patient one and
  // vice-versa — this must block.
  const src =
    "Distributors and healthcare facilities should return to place of purchase. " +
    "Patients should stop using it and contact their doctor.";
  const body =
    "دعت الجهة الموزّعين والمنشآت الصحية إلى إرجاع المنتج إلى مكان الشراء والتواصل مع الطبيب. " +
    repeatTo(130, "تتابع الجهة الوضع وتوضح أن السحب يشمل الدفعة المعنية فقط");
  const { errors } = checkFactGrounding(
    { title: "سحب منتج وإرشادات للمنشآت", excerpt: "", body },
    { sourceText: src },
    "safety_alert",
  );
  assert.ok(errors.includes("audience_misdirected_action:contact"));
  assert.ok(!errors.some((e) => e.startsWith("invented_official_action")));
});
