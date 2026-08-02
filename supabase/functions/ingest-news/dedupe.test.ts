// Controlled-example checks for the deterministic semantic-dedup logic (E1.2).
//
// Pure module (no Deno/Supabase), runnable under `deno test` or Node's
// node:test. Titles are realistic same-story / different-story pairs so the
// conservative thresholds are exercised the way the live run will see them.

import test from "node:test";
import assert from "node:assert/strict";
import {
  betterSource,
  clusterStories,
  contentTokens,
  normalizeTitle,
  numericConflict,
  pickBestIndex,
  similarity,
  type SourceRank,
  type StoryText,
  storyDuplicate,
} from "./dedupe.ts";
import { DRAFT_STATUS, type RegistrySource } from "./registry.ts";

function source(partial: Partial<RegistrySource> & { domain: string }): RegistrySource {
  return {
    name: partial.name ?? partial.domain,
    domain: partial.domain,
    region: partial.region ?? "world",
    source_type: partial.source_type ?? "official",
    tier: partial.tier ?? "3",
    trust_score: partial.trust_score ?? 50,
    discovery_enabled: partial.discovery_enabled ?? true,
    final_source_allowed: partial.final_source_allowed ?? true,
    active: partial.active ?? true,
  };
}

// --- normalization --------------------------------------------------------

test("normalizeTitle folds Arabic letter variants, diacritics, digits, punctuation", () => {
  // Alef/ya/ta-marbuta variants + harakat collapse to a stable form.
  assert.equal(normalizeTitle("أَحمد"), "احمد");
  assert.equal(normalizeTitle("مُستشفى"), "مستشفي");
  assert.equal(normalizeTitle("صِحّة"), "صحه");
  // Arabic-Indic digits fold to ASCII; punctuation becomes spaces.
  assert.equal(normalizeTitle("١٢٣, مؤشر!"), "123 موشر");
});

test("contentTokens strips branding/stopwords and the leading ال", () => {
  const toks = contentTokens("عاجل: منظمة الصحة العالمية تحذر - وكالة كونا");
  assert.ok(!toks.includes("عاجل")); // headline noise removed
  assert.ok(!toks.includes("كونا")); // agency branding removed
  assert.ok(!toks.includes("وكاله")); // "وكالة" normalized+removed
  assert.ok(toks.includes("صحه")); // "الصحة" -> ال stripped -> صحه
  assert.ok(toks.includes("تحذر"));
});

// --- Section 7 scenarios --------------------------------------------------

test("the same story from four different domains creates one draft", () => {
  const items: StoryText[] = [
    { title: "FDA approves new Alzheimer's drug lecanemab - Reuters" },
    { title: "FDA Approves New Alzheimer’s Drug Lecanemab | BBC News" },
    { title: "US FDA approves new Alzheimer's drug lecanemab" },
    { title: "FDA approves lecanemab, a new Alzheimer's drug — CNN" },
  ];
  const clusters = clusterStories(items, (t) => t);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 4);
});

test("a Tier-1 primary source beats a Tier-2 report in the same cluster", () => {
  const ranks: SourceRank[] = [
    { source: source({ domain: "reuters.com", tier: "2", trust_score: 80, source_type: "media" }) },
    { source: source({ domain: "nejm.org", tier: "1", trust_score: 96, source_type: "research" }) },
  ];
  assert.equal(pickBestIndex(ranks), 1);
  assert.ok(betterSource(ranks[1], ranks[0]) < 0);
});

test("within a tier, a primary/original source beats a media report", () => {
  const ranks: SourceRank[] = [
    { source: source({ domain: "wam.ae", tier: "2", trust_score: 90, source_type: "media" }) },
    { source: source({ domain: "moh.gov.ae", tier: "2", trust_score: 90, source_type: "official" }) },
  ];
  // Equal tier & trust -> the non-media (primary) source wins.
  assert.equal(pickBestIndex(ranks), 1);
});

test("same-run semantic duplicates receive duplicate_semantic_same_run", () => {
  // Mirror the index.ts same-run clustering: one representative, the rest logged
  // as duplicate_semantic_same_run.
  const members = [
    { text: { title: "الكويت تسجل أول إصابة بجدري القرود - كونا" } as StoryText },
    { text: { title: "الكويت تسجل أول إصابة بجدري القرود وفق وزارة الصحة" } as StoryText },
  ];
  const clusters = clusterStories(members, (m) => m.text);
  assert.equal(clusters.length, 1);
  const reasons: string[] = [];
  for (const cluster of clusters) {
    for (let i = 1; i < cluster.length; i++) {
      const v = storyDuplicate(cluster[i].text, cluster[0].text);
      reasons.push(v.duplicate ? "duplicate_semantic_same_run" : "kept");
    }
  }
  assert.deepEqual(reasons, ["duplicate_semantic_same_run"]);
});

test("a match against recent stored content receives duplicate_semantic_existing", () => {
  // Recent stored rows carry title + original_title (as index.ts loads them).
  const recent = [
    { title: "Kuwait reports first case of monkeypox", original_title: "الكويت تسجل أول إصابة بجدري القرود - كونا" },
  ];
  const candidate: StoryText = { title: "الكويت تسجل أول إصابة بجدري القرود وفق وزارة الصحة" };
  let reason = "insert";
  for (const r of recent) {
    // Mirror index.ts: compare against {title, originalTitle} of the stored row.
    if (storyDuplicate(candidate, { title: r.title, originalTitle: r.original_title }).duplicate) {
      reason = "duplicate_semantic_existing";
      break;
    }
  }
  assert.equal(reason, "duplicate_semantic_existing");
});

test("source-branding differences do not prevent a match", () => {
  const a: StoryText = { title: "منظمة الصحة العالمية تعلن انتهاء حالة الطوارئ لكوفيد - وكالة كونا" };
  const b: StoryText = { title: "منظمة الصحة العالمية تعلن انتهاء حالة الطوارئ لكوفيد - وام" };
  assert.equal(storyDuplicate(a, b).duplicate, true);
});

test("different stories about the same disease remain separate", () => {
  const yemen: StoryText = { title: "تفشي الكوليرا في اليمن" };
  const sudan: StoryText = { title: "تفشي الكوليرا في السودان" };
  assert.equal(storyDuplicate(yemen, sudan).duplicate, false);
});

test("a materially new update remains eligible (numeric conflict keeps them apart)", () => {
  const july: StoryText = { title: "الكويت تسجل 1200 إصابة جديدة بكورونا في يوليو" };
  const august: StoryText = { title: "الكويت تسجل 4500 إصابة جديدة بكورونا في أغسطس" };
  assert.equal(numericConflict(july.title, august.title), true);
  assert.equal(storyDuplicate(july, august).duplicate, false);
});

test("two different drug approvals are not merged", () => {
  const a: StoryText = { title: "FDA approves Wegovy for heart disease" };
  const b: StoryText = { title: "FDA approves Leqembi for Alzheimer's disease" };
  assert.equal(storyDuplicate(a, b).duplicate, false);
});

test("borderline similarity is not automatically rejected", () => {
  // Partial topical overlap, no matching excerpt -> stays a separate draft.
  const a: StoryText = {
    title: "دراسة تربط النوم الجيد بصحة القلب",
    excerpt: "بحث جديد حول عادات النوم لدى البالغين.",
  };
  const b: StoryText = {
    title: "دراسة تربط الرياضة بصحة القلب",
    excerpt: "تقرير عن التمارين وضغط الدم.",
  };
  const v = storyDuplicate(a, b);
  assert.equal(v.duplicate, false);
  assert.ok(v.score < 1);
});

test("secondary sources are preserved without becoming duplicate drafts", () => {
  // A cluster collapses to ONE representative; the others become supporting
  // URLs (never separate drafts).
  type M = { text: StoryText; url: string; source: SourceRank };
  const members: M[] = [
    {
      text: { title: "WHO declares end of COVID emergency - Reuters" },
      url: "https://reuters.com/a",
      source: { source: source({ domain: "reuters.com", tier: "2", trust_score: 80, source_type: "media" }) },
    },
    {
      text: { title: "WHO declares end of the COVID global emergency" },
      url: "https://who.int/b",
      source: { source: source({ domain: "who.int", tier: "1", trust_score: 96, source_type: "official" }) },
    },
  ];
  const clusters = clusterStories(members, (m) => m.text);
  assert.equal(clusters.length, 1);
  const cluster = clusters[0];
  const bestIdx = pickBestIndex(cluster.map((m) => m.source));
  const supporting = cluster.filter((_, i) => i !== bestIdx).map((m) => m.url);
  assert.equal(cluster[bestIdx].url, "https://who.int/b"); // Tier-1 wins
  assert.deepEqual(supporting, ["https://reuters.com/a"]); // Tier-2 kept as context
});

test("an accepted (non-duplicate) representative maps to the pending draft status", () => {
  // storyDuplicate never flags genuinely distinct stories, so they proceed to
  // insertion — which index.ts always writes as DRAFT_STATUS (never published).
  assert.equal(DRAFT_STATUS, "pending");
  const a: StoryText = { title: "Kuwait launches new diabetes screening program" };
  const b: StoryText = { title: "Bahrain updates measles vaccination schedule" };
  assert.equal(storyDuplicate(a, b).duplicate, false);
});

test("published content is never targeted by dedup (matches are rejections, not edits)", () => {
  // A semantic match yields a duplicate VERDICT (the new candidate is rejected);
  // it never returns an instruction to modify the matched/stored row.
  const stored: StoryText = { title: "الكويت تسجل أول إصابة بجدري القرود - كونا" };
  const candidate: StoryText = { title: "الكويت تسجل أول إصابة بجدري القرود وفق وزارة الصحة" };
  const v = storyDuplicate(candidate, stored);
  assert.equal(v.duplicate, true);
  // The verdict has no field that could mutate stored content — it only carries
  // score/method used to REJECT the incoming candidate.
  assert.deepEqual(Object.keys(v).sort(), ["duplicate", "method", "score"]);
});

test("Arabic-title duplicate example: reworded same story collapses", () => {
  const a: StoryText = { title: "وزارة الصحة الكويتية تطلق حملة للتطعيم ضد الإنفلونزا الموسمية" };
  const b: StoryText = { title: "الصحة الكويتية تطلق حملة التطعيم ضد الإنفلونزا الموسمية" };
  assert.equal(storyDuplicate(a, b).duplicate, true);
});

// --- Point 4: additional false-positive protection --------------------------

test("an approval and a recall/safety warning for the same medicine stay separate", () => {
  const approval: StoryText = { title: "FDA approves Ozempic for weight loss treatment" };
  const recall: StoryText = { title: "FDA recalls Ozempic batches over contamination warning" };
  assert.equal(storyDuplicate(approval, recall).duplicate, false);
});

test("a service launch and a later hours/eligibility change stay separate", () => {
  const launch: StoryText = { title: "Kuwait launches new diabetes screening clinic" };
  const change: StoryText = { title: "Kuwait diabetes screening clinic extends opening hours and eligibility" };
  assert.equal(storyDuplicate(launch, change).duplicate, false);
});

test("new clinical guidance and new case statistics for one disease stay separate", () => {
  const guidance: StoryText = { title: "WHO issues new guidance on measles vaccination" };
  const stats: StoryText = { title: "WHO reports 1200 new measles cases this month" };
  assert.equal(storyDuplicate(guidance, stats).duplicate, false);
});

test("two different studies from the same institution stay separate", () => {
  const coffee: StoryText = { title: "Harvard study links coffee to lower heart disease risk" };
  const sleep: StoryText = { title: "Harvard study links exercise to better sleep quality" };
  assert.equal(storyDuplicate(coffee, sleep).duplicate, false);
});

test("an editor-written article and a different AI candidate on the same general topic stay separate", () => {
  const editor: StoryText = { title: "Ministry of Health opens new mental health center in Kuwait City" };
  const candidate: StoryText = { title: "Kuwait announces expansion of school vaccination program" };
  assert.equal(storyDuplicate(editor, candidate).duplicate, false);
});

test("a new AI candidate matching a recent manually-written article is rejected as duplicate_semantic_existing", () => {
  // Manual editor rows carry origin != 'ai' but the existing-content scope is
  // origin-agnostic, so the AI candidate must still be caught as a duplicate.
  const manualRecent = [
    {
      title: "وزارة الصحة تطلق حملة التطعيم ضد الإنفلونزا الموسمية",
      original_title: null as string | null,
    },
  ];
  const aiCandidate: StoryText = { title: "الصحة تطلق حملة للتطعيم ضد الإنفلونزا الموسمية" };
  let reason = "insert";
  for (const r of manualRecent) {
    if (storyDuplicate(aiCandidate, { title: r.title, originalTitle: r.original_title }).duplicate) {
      reason = "duplicate_semantic_existing";
      break;
    }
  }
  assert.equal(reason, "duplicate_semantic_existing");
});

test("similarity is symmetric and bounded", () => {
  const a = "Kuwait Ministry of Health launches flu vaccination campaign";
  const b = "Ministry of Health in Kuwait launches the flu vaccination campaign";
  const s1 = similarity(a, b);
  const s2 = similarity(b, a);
  assert.equal(s1, s2);
  assert.ok(s1 >= 0 && s1 <= 1);
});
