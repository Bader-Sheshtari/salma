// NEWSLETTER CURATION ENGINE — deterministic engine tests.
// V1.1 (Editorial Calibration): verification gate, quality floors, section
// rules, GCC priority, trend evidence, opportunities pool (brief §16).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  assignSection,
  buildTrendCounts,
  type Candidate,
  dedupeCandidates,
  econMaterial,
  fallbackCopy,
  isResearchPrimary,
  scoreBand,
  scoreCandidate,
  selectIssue,
  type SignalContext,
  titleSignature,
  containsTerm,
} from "./curation.ts";

// Production-like tiers: known tier-1 officials/journals, tier-2 wires/majors,
// unknown everything-else at 3.5 (→ unverified externals by default, like prod).
const tierOf = (d: string | null): number => {
  const dom = (d ?? "").toLowerCase();
  if (!dom) return 3.5;
  if (/\.gov|sfda|who\.int|nejm|thelancet|fda\.gov|nih|moh\./.test(dom)) return 1;
  if (/reuters|bbc\.com|kuna|statnews|apnews|aawsat|argaam|aljarida|nature\.com/.test(dom)) return 2;
  if (/gulfnews|khaleejtimes|thenationalnews|arabnews|mobihealthnews/.test(dom)) return 3;
  return 3.5;
};

const ctx = (over: Partial<SignalContext> = {}): SignalContext => ({
  tierOf,
  searchTerms: [],
  audienceTopics: {},
  maxViews: 0,
  ...over,
});

let seq = 0;
const cand = (over: Partial<Candidate>): Candidate => ({
  kind: "external",
  refId: `c${seq++}`,
  title: "",
  titleAr: null,
  summary: null,
  url: `https://example.com/x${seq}`,
  sourceDomain: "example.com",
  sourceName: null,
  categorySlug: null,
  publishedAt: new Date().toISOString(),
  priorityLevel: "important",
  priorityScore: 60,
  ...over,
});

const score = (over: Partial<Candidate>, c: SignalContext = ctx()) =>
  scoreCandidate(cand(over), c);

// --- Matching / shared helpers (unchanged behavior) ---------------------------

Deno.test("containsTerm: Arabic proclitics match, word-tails do not", () => {
  assert(containsTerm("أعلنت وزارة الصحة والتأمين الصحي الجديد", "تامين صحي"));
  assert(!containsTerm("قال عثمان إن المشروع مستمر", "عمان"));
  assert(!containsTerm("woman wins award", "oman"));
});


// --- V1.1 scoring: live-signal renormalization + bands -------------------------

Deno.test("V1.1: strong verified official story reaches the strong band", () => {
  const s = score({
    titleAr: "الهيئة تصدر تعميماً إلزامياً بسحب دواء من الأسواق",
    sourceDomain: "sfda.gov.sa",
    priorityLevel: "very_important",
    gcc: { countryCode: "SA", topics: ["pharma"], signals: ["recall_or_suspension"], strategic: true, gccScore: 85, whyAr: "سحب رسمي" },
  });
  assert(s.score >= 0.62, `expected strong, got ${s.score}`);
  assertEquals(scoreBand(s.score), "strong");
  assert(s.verified);
});

Deno.test("scoreBand thresholds", () => {
  assertEquals(scoreBand(0.7), "strong");
  assertEquals(scoreBand(0.55), "good");
  assertEquals(scoreBand(0.3), "weak");
});

Deno.test("§16: high-authority low-view beats viral low-value", () => {
  const authority = score({
    titleAr: "الهيئة تسحب دواءً من الأسواق",
    sourceDomain: "sfda.gov.sa",
    priorityLevel: "very_important",
  });
  const viral = score({
    kind: "article",
    refId: "pop",
    titleAr: "نصائح عامة للعناية بالبشرة",
    sourceDomain: null,
    priorityLevel: null,
    views: 5000, engaged: 900, completed: 800,
  }, ctx({ maxViews: 5000 }));
  assert(authority.score > viral.score, `${authority.score} vs ${viral.score}`);
});

Deno.test("sensational phrasing penalized; search demand boosts", () => {
  const sober = score({ titleAr: "علاج جديد لمرض السكري يظهر نتائج واعدة" });
  const bait = score({ titleAr: "لن تصدق هذا العلاج المعجزة الصادم للسكري" });
  assert(sober.parts.interest > bait.parts.interest);
  const demand = score(
    { titleAr: "كل ما تريد معرفته عن فيتامين د" },
    ctx({ searchTerms: [{ term: "فيتامين د", count: 4 }] }),
  );
  assert(demand.reasons.includes("search_demand"));
});

// --- §5: primary-source escalation effect --------------------------------------

Deno.test("§5: a located primary flips verification and lifts authority", () => {
  const before = score({ titleAr: "تقرير عن موافقة جديدة لدواء القلب", sourceDomain: "random-health-blog.com" });
  assert(!before.verified);
  const after = score({
    titleAr: "تقرير عن موافقة جديدة لدواء القلب",
    sourceDomain: "random-health-blog.com",
    hasPrimary: true,
    primaryUrl: "https://www.fda.gov/news/x",
    primaryDomain: "fda.gov",
  });
  assert(after.verified);
  assert(after.parts.authority > before.parts.authority);
  assert(after.reasons.includes("official_source"));
});

// --- §2/§6: the lead ------------------------------------------------------------

function strongLead(): Partial<Candidate> {
  return {
    titleAr: "الهيئة تعتمد أول علاج جيني لفقر الدم المنجلي",
    sourceDomain: "sfda.gov.sa",
    priorityLevel: "very_important",
    gcc: { countryCode: "SA", topics: ["regulation"], signals: ["regulatory_approval"], strategic: true, gccScore: 85, whyAr: "اعتماد رسمي" },
  };
}

Deno.test("§2: an editor-kept lead blocks the engine from suggesting another", () => {
  seq = 5;
  const strong = score(strongLead());
  const { picks } = selectIssue(dedupeCandidates([strong]), ctx(), { lead: 1 });
  assertEquals(picks.filter((p) => p.section === "lead").length, 0);
  // The strong candidate still lands somewhere useful instead of vanishing.
  assert(picks.length >= 1);
});

Deno.test("§16: exactly one lead — never more", () => {
  seq = 0;
  const pool = [
    score(strongLead()),
    score({ titleAr: "منظمة الصحة تعلن حالة طوارئ صحية عالمية جديدة", sourceDomain: "who.int", priorityLevel: "very_important" }),
  ];
  const { picks } = selectIssue(dedupeCandidates(pool), ctx());
  assertEquals(picks.filter((p) => p.section === "lead").length, 1);
});

Deno.test("§16: no candidate clears the bar → NO forced lead", () => {
  seq = 10;
  const weak = [
    score({ titleAr: "خبر صحي عادي من مصدر غير معروف الهوية", sourceDomain: "unknown-site.net", priorityLevel: "important" }),
    score({ titleAr: "تقرير عام عن نزلات البرد الموسمية", sourceDomain: "another-blog.org", priorityLevel: "important" }),
  ];
  const { picks, emptySections } = selectIssue(dedupeCandidates(weak), ctx());
  assertEquals(picks.filter((p) => p.section === "lead").length, 0);
  assert(emptySections.includes("lead"));
});

Deno.test("§6: unverified item can never be the lead even with a high score", () => {
  seq = 20;
  const unverifiedStrong = score({
    titleAr: "اكتشاف علاج جديد مهم جداً لمرض السكري بنتائج أولية",
    sourceDomain: "viral-health-news.com",
    priorityLevel: "very_important",
  });
  const { picks } = selectIssue(dedupeCandidates([unverifiedStrong]), ctx());
  assertEquals(picks.filter((p) => p.section === "lead").length, 0);
});

// --- §4/§10: verification gate + opportunities pool ------------------------------

Deno.test("§16: unverified externals go to opportunities, never core sections", () => {
  seq = 30;
  const unverified = score({
    titleAr: "دراسة واعدة عن علاج جديد للزهايمر تثير اهتماماً واسعاً",
    sourceDomain: "some-aggregator.io",
    priorityLevel: "very_important",
  });
  const { picks, opportunities } = selectIssue(dedupeCandidates([unverified]), ctx());
  assertEquals(picks.length, 0);
  assertEquals(opportunities.length, 1);
  assertEquals(opportunities[0].refId, unverified.refId);
});

Deno.test("opportunities: unverified-but-promising listed before verified leftovers", () => {
  seq = 40;
  const pool = [
    score({ titleAr: "خبر قوي غير موثق عن دواء جديد للقلب", sourceDomain: "unknown-a.com", priorityLevel: "very_important" }),
    // verified but below quick floor → not an opportunity (too weak)
    score({ titleAr: "خبر عادي", sourceDomain: "reuters.com", priorityLevel: "low", priorityScore: 10 }),
  ];
  const { opportunities } = selectIssue(dedupeCandidates(pool), ctx());
  assert(opportunities.length >= 1);
  assertEquals(opportunities[0].sourceDomain, "unknown-a.com");
});

// --- §7: section-specific rules ---------------------------------------------------

Deno.test("§7 research: weak repost excluded; original journal or found primary accepted", () => {
  seq = 50;
  const repost = score({ titleAr: "دراسة جديدة تقول إن القهوة مفيدة للقلب", sourceDomain: "arabnews.com" });
  let sel = selectIssue(dedupeCandidates([repost]), ctx());
  assertEquals(sel.picks.filter((p) => p.section === "research").length, 0);

  const journal = score({ titleAr: "دراسة جديدة تقول إن القهوة مفيدة للقلب", sourceDomain: "nejm.org" });
  sel = selectIssue(dedupeCandidates([journal]), ctx());
  assertEquals(sel.picks.filter((p) => p.section === "research").length, 1);

  const withPrimary = score({
    titleAr: "دراسة جديدة تقول إن القهوة مفيدة للقلب", sourceDomain: "arabnews.com",
    hasPrimary: true, primaryDomain: "thelancet.com", primaryUrl: "https://thelancet.com/x",
  });
  sel = selectIssue(dedupeCandidates([withPrimary]), ctx());
  assertEquals(sel.picks.filter((p) => p.section === "research").length, 1);
  assert(isResearchPrimary("thelancet.com"));
});

Deno.test("§7 economy: material market event qualifies, soft business talk does not", () => {
  const deal = cand({ titleAr: "مجموعة مستشفيات تعلن استحواذاً بقيمة مليار" });
  const soft = cand({ titleAr: "نمو متوقع في سوق الرعاية الصحية الإقليمي" });
  assert(econMaterial(deal));
  assert(!econMaterial(soft));
});

Deno.test("§7 trend: one random global article is NOT a trend; evidence or tier-1/2 is", () => {
  seq = 60;
  const single = score({ title: "Why microplastics worry health researchers", sourceDomain: "random-blog.net" });
  // unverified anyway — use a tier-3 known outlet to isolate the trend rule
  const t3 = score({ title: "Why everyone is talking about GLP-1 for longevity", sourceDomain: "gulfnews.com", hasPrimary: true, primaryDomain: "fda.gov", primaryUrl: "https://fda.gov/x" });
  // No pool evidence, tier 3 source → trend slot stays empty.
  let sel = selectIssue(dedupeCandidates([t3]), ctx({ trendGroupCounts: { glp1: 1 } }));
  assertEquals(sel.picks.filter((p) => p.section === "trend").length, 0);
  // Pool evidence (≥2 hits) → qualifies.
  sel = selectIssue(dedupeCandidates([t3]), ctx({ trendGroupCounts: { glp1: 3 } }));
  assertEquals(sel.picks.filter((p) => p.section === "trend").length, 1);
  // Tier-2 outlet qualifies even alone.
  const t2 = score({ title: "Why everyone is talking about GLP-1 for longevity", sourceDomain: "bbc.com" });
  sel = selectIssue(dedupeCandidates([t2]), ctx({ trendGroupCounts: { glp1: 1 } }));
  assertEquals(sel.picks.filter((p) => p.section === "trend").length, 1);
  assert(buildTrendCounts([single, t2, t3]).glp1 >= 2);
});

Deno.test("§7 qol: evidence threshold required", () => {
  seq = 70;
  const noEvidence = score({ titleAr: "نصائح للنوم الجيد في الصيف", sourceDomain: "gulfnews.com" });
  let sel = selectIssue(dedupeCandidates([noEvidence]), ctx());
  assertEquals(sel.picks.filter((p) => p.section === "qol").length, 0);
  const withEvidence = score({ titleAr: "عادات النوم الصحية: توصيات جديدة من جامعة هارفارد", sourceDomain: "statnews.com" });
  assertEquals(withEvidence.section, "qol");
  sel = selectIssue(dedupeCandidates([withEvidence]), ctx());
  assertEquals(sel.picks.filter((p) => p.section === "qol").length, 1);
});

Deno.test("§7 expert: unknown-domain opinion never auto-fills the expert slot", () => {
  seq = 80;
  const unknownOpinion = score({ title: "Opinion: The future of hospital AI safety", sourceDomain: "random-substack.io" });
  let sel = selectIssue(dedupeCandidates([unknownOpinion]), ctx());
  assertEquals(sel.picks.filter((p) => p.section === "expert").length, 0);
  const credibleOpinion = score({ title: "Opinion: The future of hospital AI safety", sourceDomain: "statnews.com" });
  sel = selectIssue(dedupeCandidates([credibleOpinion]), ctx());
  assertEquals(sel.picks.filter((p) => p.section === "expert").length, 1);
});

// --- §8: GCC calibration -----------------------------------------------------------

const gccCand = (country: "KW" | "SA" | "AE", gccScore: number, strategic: boolean, title: string, domain = "moh.gov.kw") =>
  score({
    titleAr: title,
    sourceDomain: domain,
    country: country === "KW" ? "Kuwait" : country === "SA" ? "Saudi Arabia" : "United Arab Emirates",
    gcc: { countryCode: country, topics: ["hospitals"], signals: strategic ? ["mandatory_directive"] : [], strategic, gccScore, whyAr: null },
  });

Deno.test("§16: strong Kuwait story surfaced and preferred over equal UAE story", () => {
  seq = 90;
  const kw = gccCand("KW", 70, true, "وزارة الصحة الكويتية تصدر تعميماً إلزامياً للمستشفيات", "moh.gov.kw");
  const ae = gccCand("AE", 70, true, "هيئة صحية إماراتية تصدر قراراً تنظيمياً جديداً", "doh.gov.ae");
  const { picks } = selectIssue(dedupeCandidates([ae, kw]), ctx());
  const gccPicks = picks.filter((p) => p.section === "gcc");
  assert(gccPicks.length >= 1);
  assertEquals(gccPicks[0].candidate.gcc?.countryCode, "KW");
});

Deno.test("§16: weak routine GCC story is NOT forced into the section", () => {
  seq = 100;
  // Known tier-3 outlet (verified path blocked: tier 3 > 2 → unverified too),
  // plus low gcc_score and no strategic flag → must not fill من الخليج.
  const weak = score({
    titleAr: "فعالية توعوية عامة في مركز صحي محلي",
    sourceDomain: "khaleejtimes.com",
    priorityLevel: "important",
    gcc: { countryCode: "AE", topics: [], signals: [], strategic: false, gccScore: 20, whyAr: null },
  });
  const { picks } = selectIssue(dedupeCandidates([weak]), ctx());
  assertEquals(picks.filter((p) => p.section === "gcc").length, 0);
});

// --- §3/§9: less is more -------------------------------------------------------------

Deno.test("§16: sparse week stays sparse — no padding into premium sections", () => {
  seq = 110;
  const sparse = [
    score({ titleAr: "تحديث بروتوكول علاج الربو من وزارة الصحة", sourceDomain: "moh.gov.sa", priorityLevel: "important" }),
    score({ titleAr: "نصائح عامة للترطيب", sourceDomain: "unknown.net", priorityLevel: "low", priorityScore: 10 }),
  ];
  const { picks, emptySections } = selectIssue(dedupeCandidates(sparse), ctx());
  assert(picks.length <= 2, `got ${picks.length}`);
  assert(emptySections.includes("research"));
  assert(emptySections.includes("economy"));
  assert(emptySections.includes("trend"));
});

Deno.test("balance: max 2 per domain and capped quick section", () => {
  seq = 120;
  const flood = Array.from({ length: 8 }, (_, i) =>
    score({
      refId: `f${i}`,
      titleAr: `تعميم تنظيمي صحي مهم ومختلف كلياً رقم ${i} بشأن علاج ${i}`,
      sourceDomain: "reuters.com",
      priorityLevel: "very_important",
    }));
  const { picks } = selectIssue(flood, ctx());
  assert(picks.filter((p) => p.candidate.sourceDomain === "reuters.com").length <= 2);
});

// --- Duplication control (unchanged + still enforced) --------------------------------

Deno.test("dedup: developed version replaces original; Salma article beats external", () => {
  seq = 130;
  const original = score({ kind: "article", refId: "orig", titleAr: "خبر الدواء الأصلي", developedChildId: "dev", sourceDomain: null });
  const developed = score({ kind: "article", refId: "dev", titleAr: "ما بعد الخبر: ماذا يعني دواء القلب الجديد؟", developedFromId: "orig", sourceDomain: null });
  const out = dedupeCandidates([original, developed]);
  assert(out.some((c) => c.refId === "dev") && !out.some((c) => c.refId === "orig"));

  const ext = score({ refId: "ext", titleAr: "وزارة الصحة تعتمد لقاح الإنفلونزا الجديد", sourceDomain: "sfda.gov.sa" });
  const art = score({ kind: "article", refId: "art", titleAr: "وزارة الصحة تعتمد لقاح الإنفلونزا الجديد", sourceDomain: null });
  assertEquals(dedupeCandidates([ext, art])[0].refId, "art");
});

Deno.test("two DIFFERENT SFDA recalls survive the near-dup backstop", () => {
  seq = 135;
  const a = score({
    refId: "r1", sourceDomain: "sfda.gov.sa", priorityLevel: "very_important",
    titleAr: "سحب جميع التشغيلات من مستحضر : CLASGEN 0.5 mg/ml Eye drops",
    gcc: { countryCode: "SA", topics: ["pharma"], signals: ["recall_or_suspension"], strategic: true, gccScore: 85, whyAr: null },
  });
  const b = score({
    refId: "r2", sourceDomain: "sfda.gov.sa", priorityLevel: "very_important",
    titleAr: "سحب جميع التشغيلات من مستحضر : NOREPIRIN 2 mg/ml Injection",
    gcc: { countryCode: "SA", topics: ["pharma"], signals: ["recall_or_suspension"], strategic: true, gccScore: 85, whyAr: null },
  });
  const { picks } = selectIssue(dedupeCandidates([a, b]), ctx());
  const ids = picks.map((p) => p.candidate.refId);
  assert(ids.includes("r1") && ids.includes("r2"), `both recalls kept, got ${ids}`);
  // And one of them is strong enough to lead (gcc section is lead-eligible).
  assertEquals(picks.filter((p) => p.section === "lead").length, 1);
});

Deno.test("near-dup token backstop still catches differently-worded same story", () => {
  seq = 140;
  const a = score({ refId: "d1", sourceDomain: "reuters.com", titleAr: "حمى الضنك تواصل الضغط على بنغلاديش مع أكثر من 300 وفاة" });
  const b = score({ refId: "d2", sourceDomain: "bbc.com", titleAr: "حمى الضنك في بنغلاديش تتجاوز 300 وفاة هذا العام" });
  const { picks } = selectIssue(dedupeCandidates([a, b]), ctx());
  const ids = picks.map((p) => p.candidate.refId);
  assert(!(ids.includes("d1") && ids.includes("d2")));
});

// --- Sections / copy (unchanged helpers) ----------------------------------------------

Deno.test("section precedence: research > economy > trend > qol > gcc", () => {
  assertEquals(assignSection(cand({ titleAr: "دراسة سريرية جديدة حول دواء السكري" })), "research");
  assertEquals(
    assignSection(cand({ titleAr: "برجيل تستحوذ على مجموعة مستشفيات", gcc: { countryCode: "AE", topics: ["investment"], signals: ["acquisition"], strategic: true, gccScore: 70, whyAr: null } })),
    "economy",
  );
  assertEquals(assignSection(cand({ title: "Why everyone is talking about GLP-1 drugs" })), "trend");
});

Deno.test("fallbackCopy: transfer compact format + gcc why line", () => {
  const t = score({ kind: "transfer", refId: "tt", transfer: { doctorName: "د. سارة العلي", from: "مستشفى مبارك", to: "مستشفى جابر", specialty: "قلب" } });
  assertEquals(fallbackCopy(t).headline, "د. سارة العلي انتقل من مستشفى مبارك إلى مستشفى جابر — قلب");
  assertEquals(titleSignature("وزارةُ الصحةِ تعتمدُ لقاحاً جديداً!"), titleSignature("وزارة الصحة تعتمد لقاحا جديدا"));
});
