// ESL core — deterministic unit tests. Run: node --test esl-core.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterRows, clusterKey, titleSignature, sourceTier, bestSource, isL5Eligible,
  scoreCandidate, selectBalanced, emptyDayState, defaultLaneConfig, gccSignal, resolveGcc,
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

test("low-score candidate is skipped with reason", () => {
  const weak = scoreCandidate(row({ priority_level: "low", esl_usefulness: 5, duplicate_status: "already_in_salma", source_domain: "aggr.co", published_at: "2026-08-12T00:00:00Z", first_seen_at: "2026-08-12T00:00:00Z" }), [], reg, emptyDayState(), NOW);
  const res = selectBalanced([weak], emptyDayState(), 8, defaultLaneConfig(8));
  assert.equal(res.selected.length, 0);
  assert.equal(res.skipped[0].reason, "low_score");
});
