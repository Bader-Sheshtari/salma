// Develop Story V2 — controlled-example tests for the pure modules
// (sourceNetwork routing/classification, retriever parsers, Brief ds2
// parsing + citation enforcement, adaptive depth). No network, no LLM.
// Runs under `deno test` or Node's test runner like the ingest-news suites.

import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptiveDepth,
  classifyDomain,
  depthCaps,
  detectClaimDomains,
  rankEvidence,
  resolveDraftSourceLang,
  roleToClass,
  shouldSearchLiterature,
  shouldSearchOpenFda,
  shouldSearchTrials,
} from "./sourceNetwork.ts";
import { buildSearchTerm, classifyPubTypes, orderPubmedItems, type PubmedItem } from "./retrievers.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkFactGrounding, numberLocaleForLang } from "../ingest-news/salmaWriter.ts";
import {
  buildDevelopmentInstructions,
  DEVELOP_EDITOR_OVERLAY,
  newVsUpdateAdvice,
  parseBriefV2Output,
  type BriefV2,
} from "./brief.ts";

// ---- sourceNetwork ----------------------------------------------------------

test("classifyDomain: exact and subdomain matches, unknown → null", () => {
  assert.equal(classifyDomain("fda.gov")?.cls, "regulator");
  assert.equal(classifyDomain("www.who.int")?.cls, "public_health_agency");
  assert.equal(classifyDomain("sfda.gov.sa")?.cls, "regulator");
  assert.equal(classifyDomain("moh.gov.kw")?.cls, "gcc_ministry");
  assert.equal(classifyDomain("random-blog.example"), null);
});

test("roleToClass maps escalation heuristics onto ASN classes", () => {
  assert.equal(roleToClass("regulator"), "regulator");
  assert.equal(roleToClass("journal"), "primary_study");
  assert.equal(roleToClass("company"), "company_pr");
  assert.equal(roleToClass("secondary_media"), "secondary_media");
});

test("claim-domain detection: drug approval / trial / study / GCC", () => {
  const drug = detectClaimDomains("هيئة الغذاء والدواء توافق على عقار جديد", "standard_news");
  assert.ok(drug.has("drug_regulatory"));
  const trial = detectClaimDomains("Phase 3 trial NCT01234567 enrollment begins", "standard_news");
  assert.ok(trial.has("clinical_trial"));
  const sci = detectClaimDomains("دراسة جديدة من الباحثين حول النوم", "standard_news");
  assert.ok(sci.has("scientific"));
  const gcc = detectClaimDomains("وزارة الصحة في الكويت تعلن حملة تطعيم", "standard_news");
  assert.ok(gcc.has("gcc_health"));
  const general = detectClaimDomains("نصائح عامة للمشي اليومي", "quick_news");
  assert.ok(general.has("general"));
});

test("ADAPTIVE depth (owner adjustment #2): evidence-heavy topics auto-deepen", () => {
  assert.equal(adaptiveDepth(detectClaimDomains("دراسة سريرية المرحلة الثالثة", "research_study")), "deep");
  assert.equal(adaptiveDepth(detectClaimDomains("FDA approves new drug", "standard_news")), "deep");
  assert.equal(adaptiveDepth(detectClaimDomains("نصائح للمشي اليومي في الصيف", "quick_news")), "standard");
  const deep = depthCaps("deep"), std = depthCaps("standard");
  assert.ok(deep.webFetches > std.webFetches && deep.literature > std.literature);
});

test("retriever routing truth table", () => {
  const sci = detectClaimDomains("peer-reviewed study of a meta-analysis", "research_study");
  assert.ok(shouldSearchLiterature(sci, "standard"));
  const general = detectClaimDomains("حملة توعية عامة", "quick_news");
  assert.ok(!shouldSearchLiterature(general, "standard"));
  assert.ok(shouldSearchLiterature(general, "deep")); // deep mode widens
  assert.ok(shouldSearchTrials(detectClaimDomains("NCT87654321", "standard_news")));
  assert.ok(!shouldSearchTrials(general));
  assert.ok(shouldSearchOpenFda(detectClaimDomains("EMA approval granted", "standard_news")));
});

test("rankEvidence: primary first, then tier, then recency", () => {
  const ranked = rankEvidence([
    { is_primary: false, tier: 3, published_date: "2026-10-01" },
    { is_primary: true, tier: 2, published_date: "2026-01-01" },
    { is_primary: true, tier: 1, published_date: "2025-01-01" },
    { is_primary: true, tier: 1, published_date: "2026-09-01" },
  ]);
  assert.deepEqual(ranked.map((r) => [r.is_primary, r.tier, r.published_date]), [
    [true, 1, "2026-09-01"], [true, 1, "2025-01-01"], [true, 2, "2026-01-01"], [false, 3, "2026-10-01"],
  ]);
});

// ---- retriever parsers --------------------------------------------------------

test("buildSearchTerm: stopwords out, dedupe, capped", () => {
  const t = buildSearchTerm("The study says new Semaglutide trial results from the Semaglutide group");
  assert.ok(t.includes("Semaglutide"));
  assert.ok(!/\bthe\b/i.test(t));
  assert.equal(t.match(/Semaglutide/g)?.length, 1);
  assert.ok(t.split(" ").length <= 6);
});

test("classifyPubTypes precedence", () => {
  assert.equal(classifyPubTypes(["Journal Article", "Meta-Analysis"]), "meta_analysis");
  assert.equal(classifyPubTypes(["Systematic Review"]), "systematic_review");
  assert.equal(classifyPubTypes(["Randomized Controlled Trial", "Journal Article"]), "rct");
  assert.equal(classifyPubTypes(["Editorial"]), "editorial");
  assert.equal(classifyPubTypes(["Review"]), "review");
  assert.equal(classifyPubTypes(["Journal Article"]), "primary");
});

test("orderPubmedItems: stronger evidence classes first, stable otherwise", () => {
  const mk = (pmid: string, pub_type: PubmedItem["pub_type"]): PubmedItem =>
    ({ pmid, title: pmid, journal: null, pubdate: null, doi: null, pub_type, abstract: null });
  const out = orderPubmedItems([mk("1", "editorial"), mk("2", "primary"), mk("3", "meta_analysis"), mk("4", "primary")]);
  assert.deepEqual(out.map((o) => o.pmid), ["3", "2", "4", "1"]);
});

// ---- Brief ds2 -----------------------------------------------------------------

const VALID: BriefV2 = {
  story_summary: "ملخص",
  why_it_matters: "مهم",
  previously_known: [{ statement: "كان معروفاً", source_ids: ["S1"] }],
  new_now: [{ statement: "جديد", source_ids: ["S2"] }],
  changed: [],
  timeline: [{ date: "2026-01-02", event: "موافقة", source_ids: ["S2"], confidence: "high" }],
  scientific_evidence: [{ summary: "دراسة", source_ids: ["S2"], study_type: "rct" }],
  regulatory_evidence: [],
  key_numbers: [{ value: "42", context: "مشاركاً", source_ids: ["S2"] }],
  conflicts: [{
    topic: "الفعالية",
    position_a: { statement: "٩٠٪", source_ids: ["S1"] },
    position_b: { statement: "٧٠٪", source_ids: ["S2"] },
  }],
  unknown: ["غير معروف"],
  unanswered_questions: [],
  evidence_gaps: [],
  suggested_angles: [{ direction: "evidence_analysis", title: "زاوية", rationale: "سبب", recommended: true }],
};

test("parseBriefV2Output: valid brief parses; unknown source ids are dropped", () => {
  const raw = JSON.stringify({
    ...VALID,
    new_now: [{ statement: "جديد", source_ids: ["S2", "S999", "injected"] }],
  });
  const r = parseBriefV2Output(raw, ["S1", "S2"]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.brief.new_now[0].source_ids, ["S2"]);
    assert.equal(r.brief.conflicts.length, 1);
    assert.equal(r.brief.timeline[0].confidence, "high");
  }
});

test("parseBriefV2Output: missing summary and invalid JSON fail closed", () => {
  const noSummary = parseBriefV2Output(JSON.stringify({ ...VALID, story_summary: "" }), ["S1"]);
  assert.ok(!noSummary.ok);
  const bad = parseBriefV2Output("not json {", ["S1"]);
  assert.ok(!bad.ok);
});

test("ds2 output contract: fenced JSON is accepted and parsed (no response_format path)", () => {
  const fenced = "```json\n" + JSON.stringify(VALID) + "\n```";
  const r = parseBriefV2Output(fenced, ["S1", "S2"]);
  assert.ok(r.ok);
});

test("newVsUpdateAdvice branches (advisory only)", () => {
  assert.equal(newVsUpdateAdvice({ ...VALID, new_now: [] }, true).key, "nothing_new");
  assert.equal(newVsUpdateAdvice(VALID, false).key, "new_article");
  assert.equal(
    newVsUpdateAdvice({ ...VALID, new_now: [VALID.new_now[0]], changed: [] }, true).key,
    "follow_up",
  );
});

// ---- e2.0 development overlay: depth by significance, not word count -------

test("e2.0 development instructions: no numeric word target, depth sections kept", () => {
  const t = buildDevelopmentInstructions({ direction: "deeper_explainer", editorNote: null });
  assert.ok(!t.includes("٤٥٠"));
  assert.ok(!t.includes("٨٠٠"));
  assert.ok(!t.includes("الطول المستهدف"));
  assert.ok(t.includes("لا يوجد طول مستهدف"));
  assert.ok(t.includes("المعالجة السطحية لقصة كبيرة"));
  // After-the-News depth is preserved: ordered sections, unknowns, disputes.
  assert.ok(t.includes("«ما لا نعرفه»"));
  assert.ok(t.includes("فاعرضه كخلاف صريح بين الموقفين"));
  assert.ok(t.includes("فقط إذا كان هناك أمر محدّد منتظر فعلاً"));
  assert.ok(t.includes("المخبرية والتجارب على الحيوانات والدراسات على البشر"));
  assert.ok(!t.includes("أثبت")); // never model a CLAIM_KEYWORDS word
});

test("e2.0 develop editor overlay protects facts and material caveats, not word count", () => {
  assert.ok(!DEVELOP_EDITOR_OVERLAY.includes("٤٥٠"));
  assert.ok(!DEVELOP_EDITOR_OVERLAY.includes("لا تختصرها"));
  assert.ok(DEVELOP_EDITOR_OVERLAY.includes("يجوز الاختصار من أجل الوضوح"));
  assert.ok(DEVELOP_EDITOR_OVERLAY.includes("لا يُسقط أي حقيقة أو دليل أو رقم أو تحفّظ جوهري"));
  assert.ok(DEVELOP_EDITOR_OVERLAY.includes("«ما لا نعرفه»"));
});

test("e2.1 develop overlays: grammar pass, attribution, compression — depth kept", () => {
  const t = buildDevelopmentInstructions({ direction: "deeper_explainer", editorNote: null });
  assert.ok(t.includes("الضغط في مادة معمّقة يخدم الوضوح لا القِصر"));
  assert.ok(t.includes("وانسب التوقّعات والتقديرات إلى أصحابها"));
  assert.ok(t.includes("لا تذكر عدداً غير وارد نصاً في المصدر"));
  assert.ok(t.includes("الفئات الأكثر عرضة للخطر"));
  assert.ok(t.includes("المعالجة السطحية لقصة كبيرة")); // depth mandate untouched
  assert.ok(!t.includes("أثبت"));
  assert.ok(DEVELOP_EDITOR_OVERLAY.includes("المراجعة النهائية الإلزامية للقواعد والمطابقة والانسياب"));
  assert.ok(DEVELOP_EDITOR_OVERLAY.includes("أمانة changes_made"));
  assert.ok(DEVELOP_EDITOR_OVERLAY.includes("لا تحذف أقسام التحليل أو السياق")); // depth mandate untouched
});


// ---- P4R2: source language threaded into the draft stage ---------------------

// D18 (hotnews.ro, Romanian), verbatim fragment: «peste 1.100 de pacienți».
const D18_SOURCE =
  "Datele din studiul de fază 3, care a inclus peste 1.100 de pacienți, au arătat, de asemenea, că vaccinul a redus riscul. Dintre cei care au primit vaccinul în plus față de Keytruda, 82,2% erau încă fără cancer după doi ani.";
const d18Numbers = (draft: string, sourceLang: string | null) =>
  checkFactGrounding({ title: "ع", excerpt: "", body: draft }, { sourceText: D18_SOURCE, sourceLang }, "research_study")
    .errors.filter((e) => e.startsWith("unsupported_number"));

test("P4R2 develop-story resolves the source language (draft_inputs first, then the origin article)", () => {
  assert.equal(resolveDraftSourceLang({ source_lang: "ro" }, { source_lang: "en" }), "ro");
  assert.equal(resolveDraftSourceLang({}, { source_lang: "ro" }), "ro");
  assert.equal(resolveDraftSourceLang({ source_lang: "  " }, { source_lang: "ro" }), "ro");
  assert.equal(resolveDraftSourceLang(null, null), null);
  assert.equal(numberLocaleForLang("ro-RO"), "eu");
  assert.equal(numberLocaleForLang("pt_BR"), "eu");
});

test("P4R2 D18: with the Romanian source language «1.100» grounds the draft's 1100 (and 82,2 ↔ 82.2)", () => {
  const draft = "الدراسة كانت في المرحلة الثالثة وشملت أكثر من 1100 مريض. وبقي 82.2% بلا سرطان بعد عامين.";
  assert.deepEqual(d18Numbers(draft, resolveDraftSourceLang({ source_lang: "ro" }, null)), []);
  assert.deepEqual(d18Numbers("وشملت أكثر من 1,100 مريض.", "ro"), []);
});

test("P4R2 D18 counter: without a language «1.100» stays 1.1 (strict), and a wrong figure still fails under ro", () => {
  assert.deepEqual(d18Numbers("وشملت أكثر من 1100 مريض.", null), ["unsupported_number:1100"]);
  assert.deepEqual(d18Numbers("وشملت أكثر من 1101 مريض.", "ro"), ["unsupported_number:1101"]);
  assert.deepEqual(d18Numbers("وبقي 82.3% بلا سرطان.", "ro"), ["unsupported_number:82.3"]);
});

test("P4R2 develop-story wiring: the draft stage no longer hard-codes sourceLang: null", () => {
  const src = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  assert.ok(!src.includes("sourceLang: null"));
  assert.ok(src.includes("const sourceLang = resolveDraftSourceLang(inputs, origin.original);"));
  assert.ok(src.includes("source_lang: origin.kind === \"article\" ? origin.row.source_lang : null,"));
  assert.equal((src.match(/sourceLang\b/g) ?? []).length, 3);
});
