// NEWSLETTER CURATION ENGINE V1 — deterministic engine tests (brief §37).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  assignSection,
  type Candidate,
  dedupeCandidates,
  fallbackCopy,
  scoreCandidate,
  selectIssue,
  type SignalContext,
  titleSignature,
} from "./curation.ts";

const ctx = (over: Partial<SignalContext> = {}): SignalContext => ({
  tierOf: (d) => (d && /gov|sfda|who|nejm/.test(d) ? 1 : d ? 3 : 1),
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
  url: "https://example.com/x",
  sourceDomain: "example.com",
  sourceName: null,
  categorySlug: null,
  publishedAt: new Date().toISOString(),
  priorityLevel: "important",
  priorityScore: 60,
  ...over,
});

// --- Section assignment --------------------------------------------------------

Deno.test("sections: research > economy > trend > qol > gcc precedence", () => {
  assertEquals(
    assignSection(cand({ titleAr: "دراسة سريرية جديدة حول دواء السكري" })),
    "research",
  );
  assertEquals(
    assignSection(cand({
      titleAr: "برجيل تستحوذ على مجموعة مستشفيات",
      gcc: { countryCode: "AE", topics: ["investment"], signals: ["acquisition"], strategic: true, gccScore: 70, whyAr: null },
    })),
    "economy",
  );
  assertEquals(
    assignSection(cand({ title: "Why everyone is talking about GLP-1 drugs" })),
    "trend",
  );
  assertEquals(
    assignSection(cand({ titleAr: "فوائد النوم المبكر للصحة", categorySlug: "lifestyle" })),
    "qol",
  );
  assertEquals(
    assignSection(cand({
      titleAr: "وزارة الصحة الكويتية تفتتح مركزاً جديداً",
      country: "Kuwait",
      gcc: { countryCode: "KW", topics: ["hospitals"], signals: [], strategic: false, gccScore: 40, whyAr: null },
    })),
    "gcc",
  );
  assertEquals(assignSection(cand({ kind: "transfer", transfer: { doctorName: "د. x", from: null, to: null, specialty: null } })), "transfers");
  assertEquals(assignSection(cand({ title: "Opinion: The future of telehealth", titleAr: null })), "expert");
});

Deno.test("GLP-1 story from a GCC source stays GCC, not trend", () => {
  const s = assignSection(cand({
    titleAr: "السعودية توسع تغطية أدوية إنقاص الوزن أوزمبك",
    gcc: { countryCode: "SA", topics: ["pharma"], signals: [], strategic: false, gccScore: 50, whyAr: null },
  }));
  assert(s === "gcc" || s === "economy", `got ${s}`);
});

// --- Scoring (§17–18) -----------------------------------------------------------

Deno.test("§37-4/5: high-authority low-view beats popular low-value", () => {
  const authority = scoreCandidate(cand({
    titleAr: "الهيئة تسحب دواءً من الأسواق",
    sourceDomain: "sfda.gov.sa",
    priorityLevel: "very_important",
    gcc: { countryCode: "SA", topics: ["pharma"], signals: ["recall_or_suspension"], strategic: true, gccScore: 85, whyAr: "سحب رسمي" },
  }), ctx());
  const popularFluff = scoreCandidate(cand({
    kind: "article",
    refId: "pop",
    titleAr: "نصائح عامة للعناية بالبشرة",
    sourceDomain: null,
    priorityLevel: null,
    views: 1000, engaged: 100, completed: 50,
    isBreaking: false,
  }), ctx({ maxViews: 1000 }));
  assert(authority.score > popularFluff.score,
    `authority ${authority.score} should beat popular ${popularFluff.score}`);
});

Deno.test("§18: sensational phrasing is penalized, not rewarded", () => {
  const sober = scoreCandidate(cand({ titleAr: "علاج جديد لمرض السكري يظهر نتائج واعدة" }), ctx());
  const clickbait = scoreCandidate(cand({ titleAr: "لن تصدق هذا العلاج المعجزة الصادم للسكري" }), ctx());
  assert(sober.parts.interest > clickbait.parts.interest);
});

Deno.test("§27: repeated reader searches boost matching candidates", () => {
  const c = cand({ titleAr: "كل ما تريد معرفته عن فيتامين د" });
  const without = scoreCandidate(c, ctx());
  const withDemand = scoreCandidate(c, ctx({ searchTerms: [{ term: "فيتامين د", count: 4 }] }));
  assert(withDemand.parts.interest > without.parts.interest);
  assert(withDemand.reasons.includes("search_demand"));
});

Deno.test("reader signal degrades to zero without analytics data", () => {
  const c = scoreCandidate(cand({ kind: "article", refId: "a1", views: 0 }), ctx({ maxViews: 0 }));
  assertEquals(c.parts.reader, 0);
});

// --- Duplication control (§21) ---------------------------------------------------

Deno.test("§37-11: developed version replaces the original", () => {
  const original = scoreCandidate(cand({
    kind: "article", refId: "orig", titleAr: "خبر الدواء الأصلي", developedChildId: "dev",
  }), ctx());
  const developed = scoreCandidate(cand({
    kind: "article", refId: "dev", titleAr: "ما بعد الخبر: ماذا يعني دواء القلب الجديد؟",
    developedFromId: "orig",
  }), ctx());
  const out = dedupeCandidates([original, developed]);
  const ids = out.map((c) => c.refId);
  assert(ids.includes("dev"));
  assert(!ids.includes("orig"));
});

Deno.test("same-story external + Salma article keeps the Salma article", () => {
  const ext = scoreCandidate(cand({
    refId: "ext", titleAr: "وزارة الصحة تعتمد لقاح الإنفلونزا الجديد", priorityLevel: "very_important",
    sourceDomain: "sfda.gov.sa",
  }), ctx());
  const art = scoreCandidate(cand({
    kind: "article", refId: "art", titleAr: "وزارة الصحة تعتمد لقاح الإنفلونزا الجديد",
    sourceDomain: null,
  }), ctx());
  const out = dedupeCandidates([ext, art]);
  assertEquals(out.length, 1);
  assertEquals(out[0].refId, "art");
});

// --- Selection & balance (§20, §37-1/2/12) ---------------------------------------

function mixedWeek(): Candidate[] {
  seq = 0;
  return [
    cand({ titleAr: "الهيئة تعتمد أول علاج جيني لفقر الدم المنجلي", sourceDomain: "sfda.gov.sa", priorityLevel: "very_important", gcc: { countryCode: "SA", topics: ["regulation"], signals: ["regulatory_approval"], strategic: true, gccScore: 85, whyAr: "اعتماد رسمي" } }),
    cand({ titleAr: "منظمة الصحة تحذر من تفشي الحصبة عالمياً", sourceDomain: "who.int", priorityLevel: "very_important" }),
    cand({ titleAr: "ارتفاع إصابات الإنفلونزا الموسمية في المدارس", sourceDomain: "reuters.com", priorityLevel: "important" }),
    cand({ titleAr: "وزارة الصحة تطلق حملة فحص مبكر للسرطان", sourceDomain: "kuna.net.kw", priorityLevel: "important" }),
    cand({ titleAr: "برجيل القابضة تستحوذ على مجموعة عيادات بقيمة مليار درهم", sourceDomain: "argaam.com", gcc: { countryCode: "AE", topics: ["investment"], signals: ["acquisition"], strategic: true, gccScore: 72, whyAr: "استحواذ" }, priorityLevel: "important" }),
    cand({ titleAr: "دراسة في NEJM: دواء جديد يخفض الكوليسترول 50%", sourceDomain: "nejm.org", priorityLevel: "important" }),
    cand({ titleAr: "ما حقيقة فوائد المغنيسيوم للنوم؟", sourceDomain: "statnews.com", categorySlug: "lifestyle", priorityLevel: "important" }),
    cand({ title: "Why is everyone talking about GLP-1 for longevity?", sourceDomain: "bbc.com", priorityLevel: "important" }),
    cand({ titleAr: "الكويت تعلن مشروع مستشفى جديد في الجهراء", sourceDomain: "aljarida.com", country: "Kuwait", gcc: { countryCode: "KW", topics: ["infrastructure"], signals: ["facility_launch"], strategic: false, gccScore: 55, whyAr: "توسعة" }, priorityLevel: "important" }),
    cand({ title: "Opinion: Digital health needs clinical humility", sourceDomain: "mobihealthnews.com", priorityLevel: "important" }),
    cand({ kind: "transfer", refId: "t1", titleAr: "انتقال", transfer: { doctorName: "د. سارة العلي", from: "مستشفى مبارك", to: "مستشفى جابر", specialty: "قلب" } }),
    cand({ kind: "transfer", refId: "t2", titleAr: "انتقال", transfer: { doctorName: "د. خالد الرشيد", from: "دله", to: "الحبيب", specialty: null } }),
    cand({ titleAr: "نصائح سريعة لترطيب الجسم في الصيف", priorityLevel: "low", priorityScore: 20 }),
    cand({ titleAr: "افتتاح صيدلية مركزية جديدة", priorityLevel: "important" }),
  ];
}

Deno.test("§37-1: mixed week produces a balanced issue with a lead", () => {
  const scored = mixedWeek().map((c) => scoreCandidate(c, ctx()));
  const { picks } = selectIssue(dedupeCandidates(scored), ctx());
  const sections = new Map<string, number>();
  for (const p of picks) sections.set(p.section, (sections.get(p.section) ?? 0) + 1);
  assertEquals(sections.get("lead"), 1);
  assert((sections.get("economy") ?? 0) >= 1, "economy section present");
  assert((sections.get("research") ?? 0) >= 1, "research section present");
  assert((sections.get("qol") ?? 0) >= 1, "qol present");
  assert((sections.get("trend") ?? 0) >= 1, "trend present");
  assert((sections.get("transfers") ?? 0) === 2, "both transfers");
  assert((sections.get("expert") ?? 0) === 1, "expert article");
  // Lead must be a strong, non-opinion, non-transfer item.
  const lead = picks.find((p) => p.section === "lead")!;
  assert(lead.candidate.parts.editorial >= 0.5);
  assert(!lead.candidate.opinion);
});

Deno.test("§37-12: sparse week — engine adapts, no padding", () => {
  seq = 100;
  const sparse = [
    cand({ titleAr: "وزارة الصحة تعتمد تحديث بروتوكول علاج الربو", priorityLevel: "important" }),
    cand({ titleAr: "نصائح عامة", priorityLevel: "low", priorityScore: 10 }),
  ].map((c) => scoreCandidate(c, ctx()));
  const { picks, emptySections } = selectIssue(dedupeCandidates(sparse), ctx());
  // Low-value filler must NOT be pulled into major sections just to fill them.
  assert(picks.length <= 3, `sparse issue stays small, got ${picks.length}`);
  assert(emptySections.includes("research"));
  assert(emptySections.includes("economy"));
});

Deno.test("balance: max 2 items per external source domain", () => {
  seq = 200;
  const flood = Array.from({ length: 6 }, (_, i) =>
    scoreCandidate(cand({
      refId: `f${i}`, titleAr: `خبر صحي مهم مختلف تماماً رقم ${i} عن علاج ${i}`,
      sourceDomain: "samedomain.com", priorityLevel: "very_important",
    }), ctx()));
  const { picks } = selectIssue(flood, ctx());
  const fromDomain = picks.filter((p) => p.candidate.sourceDomain === "samedomain.com");
  assert(fromDomain.length <= 2, `got ${fromDomain.length} from one domain`);
});

Deno.test("§28: audience interest widens a section", () => {
  seq = 300;
  const researchHeavy = [
    cand({ titleAr: "دراسة أولى حول لقاح السرطان الشخصي", sourceDomain: "nejm.org", priorityLevel: "very_important" }),
    cand({ titleAr: "دراسة ثانية عن تأثير الصيام على القلب", sourceDomain: "nejm.org", priorityLevel: "important" }),
    cand({ titleAr: "باحثون يكتشفون مؤشراً مبكراً للزهايمر", priorityLevel: "important" }),
  ].map((c) => scoreCandidate(c, ctx()));
  const narrow = selectIssue(dedupeCandidates(researchHeavy), ctx());
  const wide = selectIssue(
    dedupeCandidates(researchHeavy),
    ctx({ audienceTopics: { research_studies: 8, kuwait_health: 2 } }),
  );
  const count = (sel: typeof narrow) => sel.picks.filter((p) => p.section === "research").length;
  assert(count(wide) >= count(narrow));
  assert(count(wide) === 2);
});

// --- Copy fallback (§15–16) -------------------------------------------------------

Deno.test("§21: differently-worded same-story items are caught by the token backstop", () => {
  seq = 400;
  const a = scoreCandidate(cand({
    refId: "d1", sourceDomain: "wowtv.co.kr",
    titleAr: "حمى الضنك تواصل الضغط على بنغلاديش مع أكثر من 300 وفاة",
  }), ctx());
  const b = scoreCandidate(cand({
    refId: "d2", sourceDomain: "yna.co.kr",
    titleAr: "حمى الضنك في بنغلاديش تتجاوز 300 وفاة هذا العام",
  }), ctx());
  const c = scoreCandidate(cand({
    refId: "d3", sourceDomain: "reuters.com",
    titleAr: "دراسة جديدة عن لقاح الملاريا تظهر نتائج واعدة",
  }), ctx());
  const { picks } = selectIssue(dedupeCandidates([a, b, c]), ctx());
  const ids = picks.map((p) => p.candidate.refId);
  assert(!(ids.includes("d1") && ids.includes("d2")), "dengue story must appear once");
  assert(ids.includes("d3"), "unrelated story survives");
});

Deno.test("fallbackCopy: transfer renders the compact §7 format", () => {
  const t = scoreCandidate(cand({
    kind: "transfer", refId: "tt",
    transfer: { doctorName: "د. سارة العلي", from: "مستشفى مبارك", to: "مستشفى جابر", specialty: "قلب" },
  }), ctx());
  const copy = fallbackCopy(t);
  assertEquals(copy.headline, "د. سارة العلي انتقل من مستشفى مبارك إلى مستشفى جابر — قلب");
});

Deno.test("fallbackCopy: external uses gcc why line when present", () => {
  const c = scoreCandidate(cand({
    titleAr: "سحب دواء",
    gcc: { countryCode: "SA", topics: ["pharma"], signals: ["recall_or_suspension"], strategic: true, gccScore: 85, whyAr: "سحب أو إيقاف من جهة رسمية." },
  }), ctx());
  assertEquals(fallbackCopy(c).whyAr, "سحب أو إيقاف من جهة رسمية.");
});

Deno.test("titleSignature: stable across punctuation/diacritics", () => {
  assertEquals(
    titleSignature("وزارةُ الصحةِ تعتمدُ لقاحاً جديداً!"),
    titleSignature("وزارة الصحة تعتمد لقاحا جديدا"),
  );
});
