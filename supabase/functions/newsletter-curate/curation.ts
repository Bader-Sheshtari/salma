// NEWSLETTER CURATION ENGINE V1 — pure selection/scoring module (no I/O).
//
// Deterministic by design (brief §36): everything here — scoring, section
// assignment, dedup, balance — runs with zero LLM calls. The single batched
// LLM pass (copy polish + intro) lives in index.ts and has a deterministic
// fallback built from the fields this module produces, so the engine always
// yields a complete editor-ready issue.
//
// Editorial principle (§2, §17–18): importance + authority + usefulness lead;
// popularity and curiosity support, never decide. "Interesting" must still be
// useful — sensational cues are penalized, not rewarded.

// --- Shared text helpers -----------------------------------------------------

export function normalizeArabic(text: string): string {
  return (text ?? "")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

export function containsTerm(text: string, needle: string): boolean {
  const arabic = /[؀-ۿ]/.test(needle);
  const hayRaw = ` ${(text ?? "").trim()} `;
  if (arabic) {
    const n = normalizeArabic(needle);
    const words = n.split(/\s+/).filter(Boolean).map((w) => {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Stacked proclitics before the stem; a SHORT closed suffix set after it
      // (accusative alif «استحواذاً→استحواذا», plural/pronoun endings). Longer
      // word tails still never match (عمان stays out of عثمان).
      return `(?:و|ف)?(?:ب|ل|ك|لل)?(?:ال)?${esc}(?:ا|ه|ي|ين|ون|ان|ات|ها|هم|كم|نا)?`;
    });
    const re = new RegExp(
      `(^|[^\\u0600-\\u06FF])${words.join("[^\\u0600-\\u06FF]+")}($|[^\\u0600-\\u06FF])`,
    );
    return re.test(` ${normalizeArabic(hayRaw)} `);
  }
  const esc = needle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(hayRaw.toLowerCase());
}

function anyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((t) => containsTerm(text, t));
}

/** Title signature for same-story clustering (mirrors the ESL approach). */
export function titleSignature(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 6)
    .sort()
    .join("|");
}

// --- Candidate types ---------------------------------------------------------

export type NewsletterSection =
  | "lead" | "top_missed" | "economy" | "gcc" | "research" | "qol"
  | "trend" | "expert" | "transfers" | "quick";

export type GccFacts = {
  countryCode: string;
  topics: string[];
  signals: string[];
  strategic: boolean;
  gccScore: number;
  whyAr: string | null;
};

export type Candidate = {
  kind: "article" | "external" | "transfer";
  /** content.id / radar row id / transfer id */
  refId: string;
  title: string;
  titleAr: string | null;
  summary: string | null;          // excerpt / ai_summary / editorial_value
  url: string | null;              // external only
  sourceDomain: string | null;
  sourceName: string | null;
  country?: string | null;         // English label (radar convention)
  categorySlug: string | null;
  publishedAt: string | null;
  isBreaking?: boolean;
  /** radar ranking (external) */
  priorityLevel?: "very_important" | "important" | "low" | null;
  priorityScore?: number | null;
  editorialValue?: string | null;
  eslEvidenceClass?: string | null;
  eslCanonicalKey?: string | null;
  gcc?: GccFacts | null;
  /** reader metrics (articles; 0 when analytics has no data yet) */
  views?: number;
  engaged?: number;
  completed?: number;
  /** published developed child of this article, when one exists */
  developedChildId?: string | null;
  developedFromId?: string | null;
  /** transfer extras */
  transfer?: { doctorName: string; from: string | null; to: string | null; specialty: string | null };
  /**
   * Primary-source escalation (§5, set by the orchestrator): when a stronger
   * primary/official source was found behind a secondary media item, authority
   * and verification follow the PRIMARY domain; external_url keeps the
   * secondary as context.
   */
  hasPrimary?: boolean;
  primaryUrl?: string | null;
  primaryDomain?: string | null;
};

export type SignalContext = {
  /** 1 (highest authority) .. 5; built from news_sources + gcc_sources + defaults */
  tierOf: (domain: string | null) => number;
  /** repeated reader-search terms in range (normalized), for demand boost (§27) */
  searchTerms: { term: string; count: number }[];
  /** aggregate audience topic tallies (§28), survey TOPIC_OPTIONS keys */
  audienceTopics: Record<string, number>;
  maxViews: number;                // max views among article candidates (for normalization)
  /** trend-group hit counts across the full pool (buildTrendCounts) — V1.1 §7 */
  trendGroupCounts?: Record<string, number>;
};

// --- Deterministic vocabulary ------------------------------------------------

const ECON_TERMS = [
  "استحواذ", "اندماج", "استثمار", "تمويل", "جوله تمويليه", "صفقه", "اكتتاب", "ارباح",
  "توسعه", "افتتاح مستشفي", "تامين صحي", "شراكه", "مناقصه", "ترسيه", "اسعار الادويه",
  "سوق", "قطاع خاص",
  "acquisition", "merger", "funding", "investment", "ipo", "stake", "deal",
  "insurance", "insurer", "reimbursement", "market", "expansion", "valuation",
  "private equity", "revenue", "profits", "partnership",
] as const;

const RESEARCH_TERMS = [
  "دراسه", "دراسات", "بحث جديد", "باحثون", "تجربه سريريه", "نتائج المرحله",
  "مجله طبيه", "علماء",
  "study", "trial", "researchers", "clinical trial", "meta-analysis", "findings",
  "published in", "phase 3", "phase iii", "peer-reviewed",
] as const;

const QOL_TERMS = [
  "نوم", "تغذيه", "فيتامين", "فيتامينات", "مكملات", "رياضه", "تمارين", "شيخوخه",
  "وقايه", "صحه نفسيه", "توتر", "اطاله العمر", "نمط حياه", "صيام", "سمنه",
  "sleep", "nutrition", "vitamin", "supplement", "exercise", "aging", "longevity",
  "prevention", "stress", "wellbeing", "diet", "metabolic", "obesity",
] as const;

const TREND_TERMS = [
  "اوزمبك", "ويغوفي", "مونجارو", "انقاص الوزن", "الذكاء الاصطناعي", "ساعه ذكيه",
  "اجهزه قابله للارتداء", "تيك توك", "طول العمر",
  "ozempic", "wegovy", "mounjaro", "glp-1", "semaglutide", "ai", "artificial intelligence",
  "wearable", "apple watch", "viral", "tiktok", "longevity", "biohacking", "microplastics",
] as const;

const OPINION_TERMS = [
  "راي", "مقال راي", "وجهه نظر", "تحليل", "بقلم",
  "opinion", "op-ed", "viewpoint", "commentary", "perspective", "column", "essay",
] as const;

// §18: curiosity that is still useful — rewarded.
const INTEREST_TERMS = [
  "لاول مره", "دواء جديد", "علاج جديد", "اكتشاف", "اختراق", "يغير", "تحذير رسمي",
  "first time", "new drug", "new treatment", "breakthrough", "discovery", "approval",
  ...TREND_TERMS,
] as const;

// §18: sensationalism / fear / clickbait — penalized.
const SENSATIONAL_TERMS = [
  "صادم", "مرعب", "كارثه", "لن تصدق", "خطير جدا", "قاتل صامت", "معجزه", "سر",
  "shocking", "terrifying", "miracle", "you won't believe", "secret", "silent killer",
  "celebrity", "مشاهير",
] as const;

const GCC_COUNTRY_LABELS = new Set([
  "Kuwait", "Saudi Arabia", "United Arab Emirates", "UAE", "Qatar", "Bahrain", "Oman",
]);

// --- Section-specific quality rules (V1.1 §7) --------------------------------

/** Domains that count as ORIGINAL research sources («دراسة أصلية»). */
const RESEARCH_PRIMARY_DOMAINS = [
  "nejm.org", "thelancet.com", "jamanetwork.com", "bmj.com", "nature.com",
  "science.org", "cell.com", "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov",
  "nih.gov", "doi.org", "cochrane.org", "annals.org", "ahajournals.org",
] as const;

export function isResearchPrimary(domain: string | null | undefined): boolean {
  const d = (domain ?? "").toLowerCase().replace(/^www\./, "");
  if (!d) return false;
  return RESEARCH_PRIMARY_DOMAINS.some((p) => d === p || d.endsWith("." + p));
}

// «اقتصاد الصحة» must MATERIALLY affect the market (§7): these terms describe
// concrete market events; soft words like سوق/market alone do not qualify.
const MATERIAL_ECON_TERMS = [
  "استحواذ", "اندماج", "صفقه", "تمويل", "جوله تمويليه", "اكتتاب", "ترسيه", "مناقصه",
  "تامين صحي", "اسعار الادويه", "توسعه بقيمه", "ارباح", "نتائج ماليه", "خصخصه",
  "acquisition", "merger", "takeover", "funding round", "raises", "ipo", "stake",
  "tender", "contract awarded", "reimbursement", "insurance", "insurer",
  "private equity", "valuation", "earnings", "divests",
] as const;

export function econMaterial(c: Candidate): boolean {
  const topics = new Set(c.gcc?.topics ?? []);
  if (topics.has("investment") || topics.has("insurance") || topics.has("healthcare_finance")) {
    return true;
  }
  return anyTerm(candText(c), MATERIAL_ECON_TERMS);
}

// «جودة الحياة» needs reasonable evidence, not popularity (§7): a credible
// source tier or an explicit evidence cue in the text.
const EVIDENCE_CUE_TERMS = [
  "دراسه", "دراسات", "باحثون", "تجربه سريريه", "جامعه", "معهد", "مراجعه علميه",
  "الادله", "بينت النتائج",
  "study", "studies", "researchers", "trial", "university", "institute",
  "evidence", "meta-analysis", "randomized",
] as const;

export function qolHasEvidence(c: Candidate, tier: number): boolean {
  return tier <= 2 || anyTerm(candText(c), EVIDENCE_CUE_TERMS);
}

// «ماذا يتحدث عنه العالم؟» needs evidence a topic is genuinely trending (§7):
// either several independent candidates in THIS pool hit the same trend group,
// or the story comes from a tier-1/2 outlet. A single random international
// article is not a trend.
const TREND_GROUPS: Record<string, readonly string[]> = {
  glp1: ["اوزمبك", "ويغوفي", "مونجارو", "ozempic", "wegovy", "mounjaro", "glp-1", "semaglutide"],
  ai: ["الذكاء الاصطناعي", "ai", "artificial intelligence"],
  longevity: ["طول العمر", "اطاله العمر", "longevity", "biohacking", "healthy aging"],
  wearables: ["ساعه ذكيه", "اجهزه قابله للارتداء", "wearable", "apple watch"],
  microplastics: ["microplastics", "بلاستيك دقيق"],
  viral: ["تيك توك", "tiktok", "viral"],
};

export function trendGroupOf(c: Candidate): string | null {
  const text = candText(c);
  for (const [key, terms] of Object.entries(TREND_GROUPS)) {
    if (anyTerm(text, terms)) return key;
  }
  return null;
}

/** Count trend-group hits across the FULL scored pool (before dedup). */
export function buildTrendCounts(all: readonly Candidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of all) {
    const g = trendGroupOf(c);
    if (g) counts[g] = (counts[g] ?? 0) + 1;
  }
  return counts;
}

// --- Section labels (shared vocabulary with the UI lib) ----------------------

export const SECTION_LABELS: Record<NewsletterSection, string> = {
  lead: "الخبر الأبرز",
  top_missed: "أهم ما فاتك",
  economy: "اقتصاد الصحة",
  gcc: "من الخليج",
  research: "البحث الذي يستحق الانتباه",
  qol: "جودة الحياة",
  trend: "ماذا يتحدث عنه العالم؟",
  expert: "مقال يستحق القراءة",
  transfers: "انتقالات",
  quick: "باختصار",
};

// --- Section assignment (§5) -------------------------------------------------

function candText(c: Candidate): string {
  return `${c.titleAr ?? ""} ${c.title ?? ""} ${c.summary ?? ""}`;
}

export function isOpinion(c: Candidate): boolean {
  return anyTerm(`${c.titleAr ?? ""} ${c.title ?? ""}`, OPINION_TERMS);
}

/**
 * Deterministic "home" section. Precedence encodes editorial intent:
 * research > economy > trend(global) > qol > gcc > general pool.
 * (An SFDA recall lands in «من الخليج»; a Burjeel acquisition in «اقتصاد
 * الصحة»; a global GLP-1 story in «ماذا يتحدث عنه العالم؟».)
 */
export function assignSection(c: Candidate): NewsletterSection | "general" {
  if (c.kind === "transfer") return "transfers";
  const text = candText(c);
  if (isOpinion(c)) return "expert";
  if (c.eslEvidenceClass === "research" || anyTerm(text, RESEARCH_TERMS)) return "research";
  const gccTopics = new Set(c.gcc?.topics ?? []);
  const isEcon = gccTopics.has("investment") || gccTopics.has("insurance") ||
    gccTopics.has("healthcare_finance") || anyTerm(text, ECON_TERMS);
  if (isEcon) return "economy";
  const isGcc = !!c.gcc || GCC_COUNTRY_LABELS.has(c.country ?? "") ||
    c.categorySlug === "kuwait" || c.categorySlug === "gulf";
  if (anyTerm(text, TREND_TERMS) && !isGcc) return "trend";
  if (c.categorySlug === "lifestyle" || anyTerm(text, QOL_TERMS)) return "qol";
  if (isGcc) return "gcc";
  return "general";
}

// --- Scoring (§17–19) --------------------------------------------------------

export type ScoreBreakdown = {
  editorial: number;
  authority: number;
  interest: number;
  reader: number;
  gcc: number;
  freshness: number;
};

export type ScoredCandidate = Candidate & {
  section: NewsletterSection | "general";
  score: number;
  parts: ScoreBreakdown;
  reasons: string[];
  opinion: boolean;
  /** effective authority tier (primary domain when escalation found one) */
  tier: number;
  /** §4: externals need tier ≤2 authority or a located primary source */
  verified: boolean;
};

/**
 * V1.1 score bands (§11): the raw percentage implied false precision — with
 * dead signals the live range compressed to ~44–59%. The score is now
 * renormalized over SIGNALS THAT ARE ACTUALLY ALIVE and shown to editors as
 * three honest categories; the numeric score remains for internal ranking.
 */
export type ScoreBand = "strong" | "good" | "weak";

export function scoreBand(score: number): ScoreBand {
  if (score >= 0.62) return "strong";
  if (score >= 0.48) return "good";
  return "weak";
}

export function scoreCandidate(c: Candidate, ctx: SignalContext): ScoredCandidate {
  const text = candText(c);
  const reasons: string[] = [];

  // Editorial consequence/novelty.
  let editorial = 0.3;
  if (c.kind === "article") {
    editorial = c.isBreaking ? 0.8 : 0.55;
    if (c.developedFromId) {
      editorial += 0.15; // After-the-News developed piece = Salma's own value add
      reasons.push("after_news");
    }
  } else if (c.kind === "external") {
    editorial = c.priorityLevel === "very_important" ? 0.9
      : c.priorityLevel === "important" ? 0.6 : 0.25;
    if (c.editorialValue === "newsworthy_new_development") editorial += 0.1;
  } else {
    editorial = 0.45; // transfers: inherently newsletter-worthy, never lead material
  }
  editorial = Math.min(1, editorial);

  // Source authority (§29). The escalated PRIMARY domain wins when present (§5).
  const authorityDomain = c.primaryDomain ?? c.sourceDomain;
  const tier = ctx.tierOf(authorityDomain);
  const authority = c.kind === "article" ? 0.85 : Math.max(0, (5.5 - tier) / 4.5);
  if (tier <= 1.5 && c.kind === "external") reasons.push("official_source");
  const verified = c.kind !== "external" || tier <= 2 || c.hasPrimary === true;

  // Interest / curiosity — useful-interesting only (§18).
  let interest = 0;
  if (anyTerm(text, INTEREST_TERMS)) interest += 0.6;
  if (c.kind === "transfer") interest += 0.5;
  if (anyTerm(text, SENSATIONAL_TERMS)) interest -= 0.5; // penalized, never rewarded
  // Reader search demand (§27).
  const norm = normalizeArabic(text);
  if (ctx.searchTerms.some((t) => t.count >= 2 && norm.includes(normalizeArabic(t.term)))) {
    interest += 0.3;
    reasons.push("search_demand");
  }
  interest = Math.max(0, Math.min(1, interest));

  // Reader signal (only when analytics actually has data).
  const readerLive = ctx.maxViews > 0;
  let reader = 0;
  if (c.kind === "article" && readerLive) {
    const v = (c.views ?? 0) / ctx.maxViews;
    const completion = (c.views ?? 0) > 0 ? (c.completed ?? 0) / (c.views ?? 1) : 0;
    reader = Math.min(1, 0.6 * v + 0.4 * completion);
    if (reader >= 0.5) reasons.push("high_engagement");
  }

  // GCC strategic relevance — an additive BONUS, not a universal component
  // (as a weighted component it deflated every non-GCC score).
  let gccSig = 0;
  if (c.gcc) {
    gccSig = Math.min(1, c.gcc.gccScore / 100 + (c.gcc.strategic ? 0.25 : 0));
    if (c.gcc.strategic) reasons.push("gcc_strategic");
  }

  // Freshness: newest material reads best in a weekly issue.
  let freshness = 0.5;
  if (c.publishedAt) {
    const days = Math.max(0, (Date.now() - Date.parse(c.publishedAt)) / 86400000);
    freshness = Math.max(0, Math.min(1, 1 - days / 10));
  }

  const section = assignSection(c);
  if (section === "economy") reasons.push("econ_important");
  if (section === "trend") reasons.push("global_trend");
  if (c.hasPrimary && (section === "research" || isResearchPrimary(authorityDomain))) {
    reasons.push("primary_research");
  } else if (isResearchPrimary(c.sourceDomain)) {
    reasons.push("primary_research");
  }
  const opinion = isOpinion(c);

  const parts: ScoreBreakdown = {
    editorial: round2(editorial),
    authority: round2(authority),
    interest: round2(interest),
    reader: round2(reader),
    gcc: round2(gccSig),
    freshness: round2(freshness),
  };

  // V1.1 weights, renormalized over LIVE signals so the top of the scale is
  // reachable: editorial 0.40 + authority 0.30 + interest 0.15 + freshness
  // 0.05 (+ reader 0.10 only when analytics has data). GCC adds up to +0.08
  // on top. Editorial+authority still carry the clear majority (§17).
  const weights: [number, number][] = [
    [0.4, editorial],
    [0.3, authority],
    [0.15, interest],
    [0.05, freshness],
    ...(readerLive ? [[0.1, reader] as [number, number]] : []),
  ];
  const wsum = weights.reduce((s, [w]) => s + w, 0);
  const base = weights.reduce((s, [w, v]) => s + w * v, 0) / wsum;
  const score = Math.min(1, base + 0.08 * gccSig);

  return {
    ...c, section, score: round2(score), parts,
    reasons: [...new Set(reasons)], opinion, tier, verified,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Duplication control (§21) -----------------------------------------------

/**
 * Collapse duplicates BEFORE selection:
 * - an article with a published developed child is replaced by the child
 *   (prefer the strongest editorial version);
 * - candidates sharing an ESL canonical key or a title signature keep only the
 *   highest-scoring member, with internal Salma articles preferred over
 *   external briefs for the same story.
 */
export function dedupeCandidates(scored: ScoredCandidate[]): ScoredCandidate[] {
  const byId = new Map(scored.map((c) => [c.refId, c]));
  // Drop originals whose developed child is itself a candidate.
  const dropped = new Set<string>();
  for (const c of scored) {
    if (c.kind === "article" && c.developedChildId && byId.has(c.developedChildId)) {
      dropped.add(c.refId);
    }
  }
  const groups = new Map<string, ScoredCandidate[]>();
  for (const c of scored) {
    if (dropped.has(c.refId)) continue;
    // A transfer's identity is the move itself — never title-cluster transfers.
    const key = c.kind === "transfer"
      ? c.refId
      : c.eslCanonicalKey || titleSignature(c.titleAr ?? c.title) || c.refId;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  const out: ScoredCandidate[] = [];
  for (const members of groups.values()) {
    members.sort((a, b) => {
      // Salma's own article beats an external brief for the same story.
      const ka = a.kind === "article" ? 0 : 1;
      const kb = b.kind === "article" ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return b.score - a.score;
    });
    out.push(members[0]);
  }
  return out.sort((a, b) => b.score - a.score);
}

// --- Balanced issue selection (§20) -------------------------------------------

export type IssueSelection = {
  picks: { candidate: ScoredCandidate; section: NewsletterSection; position: number }[];
  /** sections that stayed empty for lack of qualifying material (§5 adaptive) */
  emptySections: NewsletterSection[];
  /**
   * V1.1 §10: the editor-only pool («فرص تحريرية») — interesting items that
   * did NOT clear the bar for the issue, led by unverified-but-promising
   * externals. They are suggestions for editors, never reader-facing.
   */
  opportunities: ScoredCandidate[];
};

// V1.1 quality floors (§3, §6): with the renormalized scale, "strong" starts
// at 0.62. Premium sections demand at least "good" material plus their own
// section rule; the lead demands "strong". Weak weeks produce SHORT issues.
const LEAD_MIN_SCORE = 0.62;
const LEAD_MIN_EDITORIAL = 0.6;
const LEAD_MIN_AUTHORITY = 0.55;
const SECTION_MIN_SCORE = 0.5;
const MISSED_MIN_EDITORIAL = 0.55;
const QUICK_MIN_SCORE = 0.42;
const OPPORTUNITY_MIN_SCORE = 0.45;
const MAX_OPPORTUNITIES = 6;

const GCC_COUNTRY_PRIORITY: Record<string, number> = { KW: 0, SA: 1, AE: 2 };

export function selectIssue(
  deduped: ScoredCandidate[],
  ctx: SignalContext,
  /**
   * Items ALREADY in the issue from editor decisions (accepted/manual) that
   * survive a re-curation, counted per section. The engine fills around them:
   * an occupied lead is never re-filled (§2 — exactly one), and section caps
   * shrink by what the editor already kept.
   */
  existing: Partial<Record<NewsletterSection, number>> = {},
): IssueSelection {
  const picks: IssueSelection["picks"] = [];
  const used = new Set<string>();
  const domainCount = new Map<string, number>();
  const trendCounts = ctx.trendGroupCounts ?? {};
  const kept = (s: NewsletterSection) => existing[s] ?? 0;

  const take = (c: ScoredCandidate, section: NewsletterSection) => {
    used.add(c.refId);
    const d = c.sourceDomain ?? "salma";
    domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
    picks.push({ candidate: c, section, position: 0 });
  };
  const usable = (c: ScoredCandidate) =>
    !used.has(c.refId) && (domainCount.get(c.sourceDomain ?? "salma") ?? 0) < 2;

  // §4: NO unverified external enters any reader-facing section automatically.
  const eligible = (c: ScoredCandidate) => usable(c) && c.verified;

  // §28: aggregate audience interest can widen a section, never shrink below 1.
  const aud = ctx.audienceTopics;
  const audTotal = Object.values(aud).reduce((s, n) => s + n, 0);
  const widen = (key: string) => audTotal >= 5 && (aud[key] ?? 0) / audTotal >= 0.3;

  // 1) Lead (§2, §6): EXACTLY one, clearing the "strong" bar on score,
  //    consequence AND authority; externals must be verified tier-1/2. Never
  //    a transfer, never an opinion piece, and only a NEWS-type story — a
  //    lone study/trend/lifestyle item belongs to its own section, not the
  //    lead. Never forced: an issue without a strong lead has no lead.
  const LEAD_SECTIONS = new Set<ScoredCandidate["section"]>(["general", "gcc", "economy"]);
  const lead = kept("lead") > 0 ? undefined : deduped.find((c) =>
    eligible(c) && c.kind !== "transfer" && !c.opinion &&
    LEAD_SECTIONS.has(c.section) &&
    c.score >= LEAD_MIN_SCORE &&
    c.parts.editorial >= LEAD_MIN_EDITORIAL &&
    c.parts.authority >= LEAD_MIN_AUTHORITY &&
    (c.kind !== "external" || c.tier <= 2)
  );
  if (lead) take(lead, "lead");

  // 2) Specialist sections — each with its OWN quality rule (§7) on top of
  //    the shared floor + verification gate.
  const fillSection = (
    section: NewsletterSection,
    maxTotal: number,
    rule: (c: ScoredCandidate) => boolean = () => true,
    min = SECTION_MIN_SCORE,
  ) => {
    const max = Math.max(0, maxTotal - kept(section));
    let n = 0;
    for (const c of deduped) {
      if (n >= max) break;
      if (!eligible(c) || c.section !== section || c.score < min) continue;
      if (!rule(c)) continue;
      take(c, section);
      n++;
    }
    return n;
  };

  fillSection("economy", widen("health_sector") ? 2 : 1, (c) => econMaterial(c));
  fillSection(
    "research",
    widen("research_studies") ? 2 : 1,
    // Original study / recognized journal / located primary — weak reposts
    // without a findable original do not fill the research slot.
    (c) => c.hasPrimary === true || isResearchPrimary(c.primaryDomain ?? c.sourceDomain) ||
      isResearchPrimary(c.sourceDomain),
  );
  fillSection("qol", 1, (c) => qolHasEvidence(c, c.tier));
  fillSection(
    "trend",
    1,
    // Genuinely trending: several pool candidates share the trend group, or a
    // tier-1/2 OUTLET is reporting it (judged on the reporting outlet, not an
    // escalated primary — a primary proves authority, not trendiness). One
    // random article ≠ a trend.
    (c) => {
      const g = trendGroupOf(c);
      return g !== null &&
        ((trendCounts[g] ?? 0) >= 2 || ctx.tierOf(c.sourceDomain) <= 2);
    },
  );
  fillSection(
    "expert",
    1,
    // Identifiable credible outlet required: unknown default-tier domains
    // never auto-fill the expert slot (manual add remains the editor's path).
    (c) => c.tier <= 3,
  );

  // «من الخليج» (§8): quality first, Kuwait → Saudi → UAE preference second.
  // Routine low-impact Gulf stories do not fill a quota.
  const gccPool = deduped
    .filter((c) =>
      eligible(c) && c.section === "gcc" && c.score >= SECTION_MIN_SCORE &&
      (c.gcc?.strategic === true || (c.gcc?.gccScore ?? 0) >= 55 || c.tier <= 2)
    )
    .sort((a, b) => {
      const pa = GCC_COUNTRY_PRIORITY[a.gcc?.countryCode ?? ""] ?? 9;
      const pb = GCC_COUNTRY_PRIORITY[b.gcc?.countryCode ?? ""] ?? 9;
      if (pa !== pb) return pa - pb;
      return b.score - a.score;
    });
  const gccMax = Math.max(0, (widen("gcc_health") || widen("kuwait_health") ? 3 : 2) - kept("gcc"));
  for (const c of gccPool) {
    if (picks.filter((p) => p.section === "gcc").length >= gccMax) break;
    if (!eligible(c)) continue;
    take(c, "gcc");
  }

  // 3) أهم ما فاتك (§7, §9): 2–4 genuinely consequential items.
  let missed = 0;
  const missedMax = Math.max(0, 4 - kept("top_missed"));
  for (const c of deduped) {
    if (missed >= missedMax) break;
    if (!eligible(c) || c.kind === "transfer" || c.opinion) continue;
    if (c.score < SECTION_MIN_SCORE || c.parts.editorial < MISSED_MIN_EDITORIAL) continue;
    take(c, "top_missed");
    missed++;
  }

  // 4) Transfers (§7): compact, capped. (Internal data — no verification gate.)
  fillSection("transfers", widen("doctor_transfers") ? 6 : 4, () => true, 0);

  // 5) باختصار: a few short USEFUL items — not a landing zone for leftovers.
  let quick = 0;
  const quickMax = Math.max(0, 4 - kept("quick"));
  for (const c of deduped) {
    if (quick >= quickMax) break;
    if (!eligible(c) || c.kind === "transfer") continue;
    if (c.score < QUICK_MIN_SCORE) continue;
    take(c, "quick");
    quick++;
  }

  // Near-duplicate backstop (§21): the signature clustering upstream misses
  // same-story items whose Arabic titles are worded differently (e.g. two
  // agency reports of one outbreak). Within the ISSUE, drop any later pick
  // sharing ≥4 distinctive tokens (length ≥4, or a number) with an earlier,
  // higher-placed pick. (≥4, not ≥3: two DIFFERENT SFDA recalls share three
  // boilerplate tokens «جميع التشغيلات مستحضر» and must both survive.)
  const tokenSets: Set<string>[] = [];
  const nearDupFree = picks.filter((p) => {
    if (p.candidate.kind === "transfer") {
      tokenSets.push(new Set());
      return true;
    }
    const tokens = new Set(
      normalizeArabic(`${p.candidate.titleAr ?? ""} ${p.candidate.title ?? ""}`)
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 4 || /^\d+$/.test(t)),
    );
    const dup = tokenSets.some((prev) => {
      let shared = 0;
      for (const t of tokens) if (prev.has(t)) shared++;
      return shared >= 4;
    });
    if (!dup) tokenSets.push(tokens);
    return !dup;
  });
  picks.length = 0;
  picks.push(...nearDupFree);

  // Positions within sections follow score order of insertion, starting after
  // any editor-kept items; kept sections also count as non-empty.
  const perSection = new Map<NewsletterSection, number>();
  for (const [s, n] of Object.entries(existing)) {
    if ((n ?? 0) > 0) perSection.set(s as NewsletterSection, n ?? 0);
  }
  for (const p of picks) {
    const n = perSection.get(p.section) ?? 0;
    p.position = n;
    perSection.set(p.section, n + 1);
  }

  const allSections: NewsletterSection[] = [
    "lead", "top_missed", "economy", "gcc", "research", "qol",
    "trend", "expert", "transfers", "quick",
  ];
  const emptySections = allSections.filter((s) => !perSection.has(s));

  // §10: editorial opportunities — promising material that did not make the
  // issue, with UNVERIFIED externals first (that is the most actionable gap:
  // verify the source, or wait for the primary), then strong-but-unplaced.
  const opportunities = deduped
    .filter((c) => !used.has(c.refId) && c.kind !== "transfer" && c.score >= OPPORTUNITY_MIN_SCORE)
    .sort((a, b) => {
      const va = a.verified ? 1 : 0;
      const vb = b.verified ? 1 : 0;
      if (va !== vb) return va - vb; // unverified first
      return b.score - a.score;
    })
    .slice(0, MAX_OPPORTUNITIES);

  return { picks, emptySections, opportunities };
}

// --- Deterministic fallback copy (§15–16, §22) --------------------------------

export function fallbackCopy(c: ScoredCandidate): {
  headline: string;
  teaser: string | null;
  whyAr: string | null;
} {
  if (c.kind === "transfer" && c.transfer) {
    const t = c.transfer;
    const spec = t.specialty ? ` — ${t.specialty}` : "";
    const from = t.from ? ` من ${t.from}` : "";
    const to = t.to ? ` إلى ${t.to}` : "";
    return {
      headline: `${t.doctorName} انتقل${from}${to}${spec}`.trim(),
      teaser: null,
      whyAr: null,
    };
  }
  const headline = (c.titleAr ?? c.title ?? "").trim().slice(0, 160);
  const teaser = (c.summary ?? "").trim().slice(0, 300) || null;
  const whyAr = c.gcc?.whyAr ?? null;
  return { headline, teaser, whyAr };
}
