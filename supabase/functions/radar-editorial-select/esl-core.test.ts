// ESL core — deterministic unit tests. Run: node --test esl-core.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterRows, clusterKey, titleSignature, sourceTier, bestSource, isL5Eligible,
  scoreCandidate, selectBalanced, emptyDayState, defaultLaneConfig, gccSignal, resolveGcc,
  candidateMergeGroups, dominantStoryType, significantTokens,
  type RadarRow, type RegistryEntry, type ScoredCandidate,
} from "./esl-core.ts";

const NOW = Date.parse("2026-08-20T12:00:00Z");
function row(p: Partial<RadarRow>): RadarRow {
  return {
    id: p.id ?? crypto.randomUUID(), event_uri: p.event_uri ?? null,
    title: p.title ?? "t", title_ar: p.title_ar ?? null, url: p.url ?? "https://x/y",
    source_title: p.source_title ?? null, source_domain: p.source_domain ?? "example.com",
    language: p.language ?? "eng", country: p.country ?? null,
    published_at: p.published_at ?? "2026-08-20T10:00:00Z", first_seen_at: p.first_seen_at ?? "2026-08-20T10:00:00Z",
    priority_score: p.priority_score ?? 60, priority_level: p.priority_level ?? "important",
    expected_category_slug: p.expected_category_slug ?? "world",
    duplicate_status: p.duplicate_status ?? "new", matched_content_id: p.matched_content_id ?? null,
    esl_lane: p.esl_lane ?? "L1", esl_story_type: p.esl_story_type ?? "general",
    esl_evidence_class: p.esl_evidence_class ?? null, esl_gcc: p.esl_gcc ?? null, esl_usefulness: p.esl_usefulness ?? 50,
  };
}
const reg = new Map<string, RegistryEntry>([
  ["fda.gov", { domain: "fda.gov", source_type: "official", tier: "1", trust_score: 95 }],
  ["nature.com", { domain: "nature.com", source_type: "research", tier: "1", trust_score: 90 }],
]);

test("one event, many sources → one cluster candidate", () => {
  const rows = [
    row({ event_uri: "e1", source_domain: "reuters.com" }),
    row({ event_uri: "e1", source_domain: "yahoo.com" }),
    row({ event_uri: "e1", source_domain: "cnn.com" }),
    row({ event_uri: "e2", source_domain: "bbc.com" }),
  ];
  const clusters = clusterRows(rows);
  assert.equal(clusters.size, 2);
  assert.equal(clusters.get("ev:e1")!.length, 3);
});

test("title-signature clusters republishers when event_uri missing", () => {
  const a = row({ event_uri: null, title: "FDA approves new cancer drug for melanoma" });
  const b = row({ event_uri: null, title: "FDA approves new melanoma cancer drug!!" });
  assert.equal(clusterKey(a), clusterKey(b));
});

test("story-type-aware best source: regulatory → regulator, not the wire", () => {
  const members = [row({ source_domain: "reuters.com" }), row({ source_domain: "fda.gov" }), row({ source_domain: "yahoo.com" })];
  const best = bestSource(members, "regulatory_decision", reg);
  assert.equal(best.source_domain, "fda.gov");
});
test("story-type-aware best source: scientific study → journal", () => {
  const members = [row({ source_domain: "dailymail.com" }), row({ source_domain: "nature.com" })];
  assert.equal(bestSource(members, "scientific_study", reg).source_domain, "nature.com");
});
test("story-type-aware best source: corporate M&A → independent wire over company/aggregator", () => {
  const members = [row({ source_domain: "prnewswire.com" }), row({ source_domain: "reuters.com" }), row({ source_domain: "yahoo.com" })];
  assert.equal(bestSource(members, "corporate_business", reg).source_domain, "reuters.com");
});

test("source tier: registry official=1, journal=2, aggregator fallback=5", () => {
  assert.equal(sourceTier("fda.gov", reg), 1);
  assert.equal(sourceTier("nature.com", reg), 2);
  assert.equal(sourceTier("some-random-aggregator.co", reg), 5);
  assert.equal(sourceTier("who.int", reg), 1); // heuristic
});

test("L5 eligibility: research and guidance pass, none/clickbait fails", () => {
  assert.equal(isL5Eligible({ esl_lane: "L5", esl_evidence_class: "research" }), true);
  assert.equal(isL5Eligible({ esl_lane: "L5", esl_evidence_class: "guidance" }), true);
  assert.equal(isL5Eligible({ esl_lane: "L5", esl_evidence_class: "none" }), false); // clickbait/hype
  assert.equal(isL5Eligible({ esl_lane: "L1", esl_evidence_class: "research" }), false);
});

test("already-in-salma tanks originality (low score)", () => {
  const r = row({ duplicate_status: "already_in_salma", priority_level: "important" });
  const s = scoreCandidate(r, [r], reg, emptyDayState(), NOW);
  const fresh = row({ duplicate_status: "new" });
  const s2 = scoreCandidate(fresh, [fresh], reg, emptyDayState(), NOW);
  assert.ok(s.score < s2.score);
});

test("repeated source + repeated topic penalties reduce score", () => {
  const r = row({ source_domain: "reuters.com", title: "sleep timing matters for healthy aging study" });
  const clean = scoreCandidate(r, [r], reg, emptyDayState(), NOW);
  const day = emptyDayState();
  day.domains.add("reuters.com");
  day.topicSigs.add(titleSignature(r.title));
  const penalized = scoreCandidate(r, [r], reg, day, NOW);
  assert.ok(penalized.score < clean.score);
});

test("GCC cross-tag flows through", () => {
  const r = row({ esl_gcc: true });
  assert.equal(scoreCandidate(r, [r], reg, emptyDayState(), NOW).gcc, true);
});

test("daily cap respected and stateful across runs", () => {
  const cands: ScoredCandidate[] = Array.from({ length: 6 }, (_, i) =>
    scoreCandidate(row({ id: "c" + i, title: "topic " + i, esl_lane: "L1", priority_level: "important", esl_usefulness: 80 }), [], reg, emptyDayState(), NOW));
  const day = emptyDayState();
  day.totalSelected = 5; day.laneCounts = { L1: 5 };
  const res = selectBalanced(cands, day, /*remainingCap*/ 3, defaultLaneConfig(8));
  assert.ok(res.selected.length <= 3);
});

test("no quota forcing on a dry L5 day (floors are soft — never invents)", () => {
  // Only clinical candidates available; selection must not fabricate L5.
  const cands = Array.from({ length: 4 }, (_, i) =>
    scoreCandidate(row({ id: "x" + i, title: "clinical " + i, esl_lane: "L1", esl_usefulness: 80, priority_level: "important" }), [], reg, emptyDayState(), NOW));
  const res = selectBalanced(cands, emptyDayState(), 8, defaultLaneConfig(8));
  assert.ok(res.selected.every((c) => c.lane === "L1")); // no L5 conjured
});

test("breaking very_important overrides a full lane ceiling", () => {
  const cfg = defaultLaneConfig(8);
  const day = emptyDayState();
  day.laneCounts = { L1: cfg.ceilings.L1 ?? 5 }; // L1 already at ceiling
  const breaking = scoreCandidate(row({ title: "huge breaking approval", esl_lane: "L1", priority_level: "very_important", priority_score: 95, esl_usefulness: 95, source_domain: "fda.gov", esl_story_type: "regulatory_decision" }), [], reg, day, NOW);
  const res = selectBalanced([breaking], day, 8, cfg);
  assert.equal(res.selected.length, 1); // overrides ceiling
});

// ---- editorial-tuning pass: GCC guard, story types, tier penalty, usefulness ----

test("A. GCC guard: DRC Ebola via a Gulf/Arabic outlet is NOT GCC", () => {
  const arTitle = "عدد مصابي إيبولا في الكونغو الديموقراطية يتجاوز الـ5000";
  assert.equal(gccSignal(arTitle), false);
  // Even if the classifier wrongly said gcc:true (Arabic outlet), the guard downgrades.
  assert.equal(resolveGcc(true, arTitle, "DRC Ebola cases exceed 5000"), false);
  // A UK/Britain regulatory story is likewise not GCC.
  assert.equal(resolveGcc(true, "بريطانيا تمهّد لعلاج الأنسولين الأسبوعي", "UK weekly insulin"), false);
});

test("GCC guard: a real GCC-subject story IS GCC (downgrade-only, never invents)", () => {
  assert.equal(gccSignal("الكويت تطلق حملة تطعيم وطنية"), true);
  assert.equal(gccSignal("Saudi SFDA approves new diabetes drug"), true);
  assert.equal(resolveGcc(true, "UAE launches health initiative"), true);
  // Guard never upgrades: classifier said false → stays false even with a GCC token.
  assert.equal(resolveGcc(false, "Kuwait health news"), false);
});

test("B. product recall → regulator is the best source", () => {
  const members = [row({ source_domain: "pulse2.com" }), row({ source_domain: "fda.gov" }), row({ source_domain: "yahoo.com" })];
  assert.equal(bestSource(members, "product_safety_or_recall", reg).source_domain, "fda.gov");
});

test("C. company tech showcase → independent wire beats the company/aggregator", () => {
  const members = [row({ source_domain: "businesswire.com" }), row({ source_domain: "reuters.com" }), row({ source_domain: "newspim.com" })];
  assert.equal(bestSource(members, "product_or_technology_announcement", reg).source_domain, "reuters.com");
});

test("D. comparable stories: a T2 source beats a T5-only source", () => {
  const common = { title: "new therapy shows benefit", priority_level: "important", esl_usefulness: 70 } as Partial<RadarRow>;
  const t2 = scoreCandidate(row({ ...common, source_domain: "reuters.com" }), [], reg, emptyDayState(), NOW);
  const t5 = scoreCandidate(row({ ...common, source_domain: "some-aggregator.co" }), [], reg, emptyDayState(), NOW);
  assert.ok(t2.score > t5.score);
});

test("a FRESH T5 story does not beat an OLDER T2 story on recency alone", () => {
  const common = { title: "trial reports results", priority_level: "important", esl_usefulness: 70 } as Partial<RadarRow>;
  const freshT5 = scoreCandidate(row({ ...common, source_domain: "some-aggregator.co", published_at: "2026-08-20T11:30:00Z" }), [], reg, emptyDayState(), NOW);
  const olderT2 = scoreCandidate(row({ ...common, source_domain: "reuters.com", published_at: "2026-08-18T12:00:00Z" }), [], reg, emptyDayState(), NOW);
  assert.ok(olderT2.score > freshT5.score);
});

test("E. a breaking (very_important) T5 story still clears the bar", () => {
  const breaking = scoreCandidate(
    row({ title: "major outbreak declared emergency", source_domain: "some-aggregator.co", priority_level: "very_important", priority_score: 92, esl_usefulness: 80 }),
    [], reg, emptyDayState(), NOW,
  );
  const res = selectBalanced([breaking], emptyDayState(), 8, defaultLaneConfig(8));
  assert.equal(res.selected.length, 1); // authority-floor penalty waived for breaking importance
});

test("reader usefulness is decisive between otherwise-comparable strong-source stories", () => {
  const common = { source_domain: "reuters.com", priority_level: "important" } as Partial<RadarRow>;
  const useful = scoreCandidate(row({ ...common, title: "practical guidance patients", esl_usefulness: 90 }), [], reg, emptyDayState(), NOW);
  const niche = scoreCandidate(row({ ...common, title: "niche mechanism abstract", esl_usefulness: 20 }), [], reg, emptyDayState(), NOW);
  assert.ok(useful.score > niche.score);
});

// ---- cross-language canonical event merge --------------------------------

const WIN72 = 72 * 60 * 60 * 1000;
// The three ACTUAL production Moderna/Merck mRNA-melanoma-vaccine variants
// (Chinese / Romanian / Greek originals) as radar-rank translated them to Arabic.
// Original titles kept in their real (non-English) languages, as production has
// them; the Arabic translation (title_ar) is the cross-language bridge.
const moderna = [
  row({ id: "zho", event_uri: "zho-2095743", language: "zho", source_domain: "ec.ltn.com.tw", esl_story_type: "corporate_business", esl_lane: "L4", esl_usefulness: 50, title: "莫德納 stock jumps 176%", title_ar: "اختراق كبير في لقاح السرطان! ارتفاع سعر سهم موديرنا", published_at: "2026-08-19T23:56:00Z" }),
  row({ id: "ron", event_uri: "ron-489835", language: "ron", source_domain: "stiripesurse.ro", esl_story_type: "scientific_study", esl_lane: "L1", esl_usefulness: 75, title: "Moderna Merck test major piele", title_ar: "لقاح ضد سرطان الجلد ينجح في اختبار رئيسي: موديرنا وميرك", published_at: "2026-08-20T15:57:00Z" }),
  row({ id: "ell", event_uri: "ell-1289360", language: "ell", source_domain: "liberal.gr", esl_story_type: "scientific_study", esl_lane: "L1", esl_usefulness: 75, title: "mRNA emvolio Moderna Merck", title_ar: "السرطان: لقاح mRNA المخصص يمر بالاختبار الكبير - موديرنا وميرك", published_at: "2026-08-20T13:56:00Z" }),
];
// Negative control: a DIFFERENT vaccine development (Shigella conjugate) — shares
// only the generic word "لقاح" (vaccine), must NOT be gathered with the Moderna set.
const shigella = row({ id: "shg", event_uri: null, source_domain: "thelancet.com", esl_story_type: "scientific_study", esl_lane: "L1", title: "Synthetic carbohydrate conjugate vaccine SF2a-TT15 Shigella", title_ar: "سلامة ومناعة لقاح الكربوهيدرات الاصطناعي SF2a ضد الشيغيلا", published_at: "2026-08-19T22:42:00Z" });

test("cross-language pre-filter gathers the 3 Moderna variants (via Arabic tokens)", () => {
  const groups = candidateMergeGroups(moderna, WIN72, 2);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
});

test("negative control: a different vaccine development is NOT gathered with Moderna", () => {
  const groups = candidateMergeGroups([...moderna, shigella], WIN72, 2);
  const big = groups.find((g) => g.length > 1);
  assert.ok(big && big.length === 3); // still just the 3 Moderna variants
  assert.ok(!big!.some((r) => r.id === "shg")); // Shigella excluded
});

test("negative control: same company, different development & time → not merged", () => {
  const trial = row({ id: "t", source_domain: "reuters.com", title: "Moderna melanoma trial", title_ar: "موديرنا لقاح سرطان الجلد تجربة", published_at: "2026-08-20T10:00:00Z" });
  const earnings = row({ id: "e", source_domain: "reuters.com", title: "Moderna quarterly earnings revenue", title_ar: "موديرنا أرباح فصلية إيرادات مبيعات", published_at: "2026-05-01T10:00:00Z" });
  const groups = candidateMergeGroups([trial, earnings], WIN72, 2);
  assert.equal(groups.length, 0); // months apart + only "موديرنا" in common → never even a candidate pair
});

test("dominant story type keeps the most substantive framing (study over stock surge)", () => {
  assert.equal(dominantStoryType(moderna), "scientific_study");
});

test("significantTokens bridges languages through the Arabic translation", () => {
  const a = significantTokens(moderna[0]); // Chinese-origin, Arabic title
  const b = significantTokens(moderna[1]); // Romanian-origin, Arabic title
  const shared = [...a].filter((t) => b.has(t));
  assert.ok(shared.includes("لقاح") && shared.includes("سرطان") && shared.includes("موديرنا"));
});

// Eight distinct medical stories across lanes (distinct titles → no topic collision).
const MED8: [string, string][] = [
  ["L1", "دواء جديد للسكري يظهر نتائج واعدة"],
  ["L1", "علاج مناعي يطيل بقاء مرضى السرطان"],
  ["L1", "لقاح ضد الالتهاب الرئوي يحصل موافقة"],
  ["L2", "تفشي الحصبة في أوروبا يثير القلق"],
  ["L2", "منظمة الصحة تحذر من موجة إنفلونزا"],
  ["L2", "حملة تطعيم واسعة ضد شلل الأطفال"],
  ["L3", "ذكاء اصطناعي يكشف أورام الثدي مبكرا"],
  ["L3", "روبوت جراحي جديد يدخل المستشفيات"],
];

test("V1.1: soft L5 floor promotes credible Healthy-Life over the weakest medical pick", () => {
  const medical = MED8.map(([ln, t], i) =>
    scoreCandidate(row({ id: "m" + i, esl_lane: ln, source_domain: "reuters.com", priority_level: "important", esl_usefulness: 60, title: "m" + i, title_ar: t }), [], reg, emptyDayState(), NOW));
  // Two credible L5 guidance stories: low priority + weak source (as real ones are),
  // but fresh + useful enough to clear the min-score bar after the tier-5 penalty.
  const l5Titles = ["عادة النوم المنتظم تحسن صحة القلب", "المشي بعد الوجبات يفيد الهضم والسكر"];
  const l5 = l5Titles.map((t, i) =>
    scoreCandidate(row({ id: "l" + i, esl_lane: "L5", esl_evidence_class: "guidance", esl_story_type: "guidance_explainer", source_domain: "regional-outlet.co", priority_level: "low", esl_usefulness: 90, title: "hl" + i, title_ar: t, published_at: "2026-08-20T11:30:00Z" }), [], reg, emptyDayState(), NOW));
  const res = selectBalanced([...medical, ...l5], emptyDayState(), 8, defaultLaneConfig(8));
  assert.equal(res.selected.length, 8);
  assert.equal(res.selected.filter((c) => c.lane === "L5").length, 2); // floor met from credible supply
  assert.ok(res.skipped.some((s) => s.reason === "l5_floor_displaced"));
});

test("V1.1: soft L5 floor never promotes a sub-quality (below-min-score) L5", () => {
  const medical = MED8.map(([ln, t], i) =>
    scoreCandidate(row({ id: "m" + i, esl_lane: ln, source_domain: "reuters.com", priority_level: "important", esl_usefulness: 60, title: "m" + i, title_ar: t }), [], reg, emptyDayState(), NOW));
  // A weak L5: old + low usefulness + weak source → below min score. Must NOT be promoted.
  const weakL5 = scoreCandidate(row({ id: "w", esl_lane: "L5", esl_evidence_class: "guidance", source_domain: "aggr.co", priority_level: "low", esl_usefulness: 10, title: "weak", title_ar: "نصيحة ضعيفة قديمة", published_at: "2026-08-12T00:00:00Z" }), [], reg, emptyDayState(), NOW);
  const res = selectBalanced([...medical, weakL5], emptyDayState(), 8, defaultLaneConfig(8));
  assert.equal(res.selected.filter((c) => c.lane === "L5").length, 0); // quality mandatory
});

test("V1.1: same Healthy-Life story in multiple languages → one cluster", () => {
  // A "regular sleep timing & heart health" study surfacing via several languages,
  // as radar-rank translated each to Arabic. They share نوم + منتظم (+ قلب/دراسة).
  const sleep = [
    row({ id: "s1", event_uri: "eng-1", source_domain: "reuters.com", title: "Regular sleep timing heart", title_ar: "دراسة جديدة: النوم المنتظم يقلل خطر أمراض القلب" }),
    row({ id: "s2", event_uri: "spa-2", source_domain: "elpais.com", title: "Sueno regular corazon", title_ar: "النوم المنتظم وصحة القلب وفق بحث حديث" }),
    row({ id: "s3", event_uri: "fra-3", source_domain: "lemonde.fr", title: "Sommeil regulier coeur", title_ar: "أهمية النوم المنتظم لصحة القلب - دراسة" }),
  ];
  const groups = candidateMergeGroups(sleep, WIN72, 2);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
  // A different Healthy-Life development (walking after meals) must NOT join.
  const walking = row({ id: "w", source_domain: "bbc.com", title: "Walking after meals", title_ar: "المشي بعد الوجبات يحسن سكر الدم وفق دراسة" });
  const groups2 = candidateMergeGroups([...sleep, walking], WIN72, 2);
  const big = groups2.find((g) => g.length > 1)!;
  assert.ok(!big.some((r) => r.id === "w"));
});

test("near-duplicate backstop: a split-off same-development variant does not take a 2nd slot", () => {
  // Two Moderna/Merck variants the LLM merge left in separate clusters. Among a
  // set where "موديرنا"/"وميرك" are rare, they share ≥2 distinctive tokens.
  const modA = scoreCandidate(row({ id: "mA", source_domain: "stiripesurse.ro", esl_usefulness: 75, title: "skin cancer test", title_ar: "لقاح ضد سرطان الجلد ينجح في اختبار رئيسي موديرنا وميرك" }), [], reg, emptyDayState(), NOW);
  const modB = scoreCandidate(row({ id: "mB", source_domain: "liberal.gr", esl_usefulness: 70, title: "mRNA test", title_ar: "السرطان لقاح mRNA المخصص يمر بالاختبار الكبير موديرنا وميرك" }), [], reg, emptyDayState(), NOW);
  const fillers = ["اكتشاف جديد حول ضغط الدم", "دراسة النوم والذاكرة", "تطعيم الأطفال في المدارس"].map((t, i) =>
    scoreCandidate(row({ id: "f" + i, source_domain: "reuters.com", esl_usefulness: 60, title: "f" + i, title_ar: t }), [], reg, emptyDayState(), NOW));
  const res = selectBalanced([modA, modB, ...fillers], emptyDayState(), 8, defaultLaneConfig(8));
  const mods = res.selected.filter((c) => c.rep.id === "mA" || c.rep.id === "mB");
  assert.equal(mods.length, 1); // only ONE of the two Moderna variants
  assert.ok(res.skipped.some((s) => s.reason === "near_duplicate"));
});

test("near-duplicate backstop does NOT over-merge different developments sharing only common words", () => {
  // Two different FDA approvals: they share regulatory boilerplate (الغذاء/الدواء/
  // ترخيص) that is COMMON across the set, so it is not distinctive; their entities
  // differ → both remain selectable.
  const common = "الغذاء والدواء تمنح ترخيص دواء";
  const fdaA = scoreCandidate(row({ id: "a", source_domain: "reuters.com", esl_usefulness: 70, title: "lilly", title_ar: `${common} ليلي لمرض السكري` }), [], reg, emptyDayState(), NOW);
  const fdaB = scoreCandidate(row({ id: "b", source_domain: "reuters.com", esl_usefulness: 70, title: "novo", title_ar: `${common} نوفو لعلاج السمنة` }), [], reg, emptyDayState(), NOW);
  // extra approvals inflate the document-frequency of the boilerplate tokens.
  const more = ["فايزر لالتهاب", "روش للسرطان", "باير للقلب"].map((x, i) =>
    scoreCandidate(row({ id: "m" + i, source_domain: "reuters.com", esl_usefulness: 60, title: "m" + i, title_ar: `${common} ${x}` }), [], reg, emptyDayState(), NOW));
  const res = selectBalanced([fdaA, fdaB, ...more], emptyDayState(), 8, defaultLaneConfig(8));
  const picked = res.selected.filter((c) => c.rep.id === "a" || c.rep.id === "b");
  assert.equal(picked.length, 2); // both distinct approvals selected
});

test("low-score candidate is skipped with reason", () => {
  const weak = scoreCandidate(row({ priority_level: "low", esl_usefulness: 5, duplicate_status: "already_in_salma", source_domain: "aggr.co", published_at: "2026-08-12T00:00:00Z", first_seen_at: "2026-08-12T00:00:00Z" }), [], reg, emptyDayState(), NOW);
  const res = selectBalanced([weak], emptyDayState(), 8, defaultLaneConfig(8));
  assert.equal(res.selected.length, 0);
  assert.equal(res.skipped[0].reason, "low_score");
});
