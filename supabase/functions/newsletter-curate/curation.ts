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
      return `(?:و|ف)?(?:ب|ل|ك|لل)?(?:ال)?${esc}`;
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
};

export type SignalContext = {
  /** 1 (highest authority) .. 5; built from news_sources + gcc_sources + defaults */
  tierOf: (domain: string | null) => number;
  /** repeated reader-search terms in range (normalized), for demand boost (§27) */
  searchTerms: { term: string; count: number }[];
  /** aggregate audience topic tallies (§28), survey TOPIC_OPTIONS keys */
  audienceTopics: Record<string, number>;
  maxViews: number;                // max views among article candidates (for normalization)
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
};

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

  // Source authority (§17, §29).
  const tier = ctx.tierOf(c.sourceDomain);
  const authority = c.kind === "article" ? 0.85 : Math.max(0, (5.5 - tier) / 4.5);
  if (tier <= 1.5 && c.kind === "external") reasons.push("official_source");

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

  // Reader signal (0 when analytics has no data yet — degrades gracefully).
  let reader = 0;
  if (c.kind === "article" && ctx.maxViews > 0) {
    const v = (c.views ?? 0) / ctx.maxViews;
    const completion = (c.views ?? 0) > 0 ? (c.completed ?? 0) / (c.views ?? 1) : 0;
    reader = Math.min(1, 0.6 * v + 0.4 * completion);
    if (reader >= 0.5) reasons.push("high_engagement");
  }

  // GCC strategic relevance.
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
  if (section === "research") reasons.push("research");
  if (section === "economy") reasons.push("econ_important");
  if (section === "qol") reasons.push("qol");
  if (section === "trend") reasons.push("global_trend");
  if (section === "transfers") reasons.push("transfer");
  const opinion = isOpinion(c);
  if (opinion) reasons.push("expert_article");

  const parts: ScoreBreakdown = {
    editorial: round2(editorial),
    authority: round2(authority),
    interest: round2(interest),
    reader: round2(reader),
    gcc: round2(gccSig),
    freshness: round2(freshness),
  };
  // Popularity can never dominate: editorial+authority carry 50% of the weight,
  // reader 15%.
  const score =
    0.3 * editorial + 0.2 * authority + 0.15 * interest +
    0.15 * reader + 0.12 * gccSig + 0.08 * freshness;

  return { ...c, section, score: round2(score), parts, reasons: [...new Set(reasons)], opinion };
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
};

const LEAD_MIN_SCORE = 0.45;
const SECTION_MIN_SCORE = 0.3;
const QUICK_MIN_SCORE = 0.22;

export function selectIssue(
  deduped: ScoredCandidate[],
  ctx: SignalContext,
): IssueSelection {
  const picks: IssueSelection["picks"] = [];
  const used = new Set<string>();
  const domainCount = new Map<string, number>();

  const take = (c: ScoredCandidate, section: NewsletterSection) => {
    used.add(c.refId);
    const d = c.sourceDomain ?? "salma";
    domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
    picks.push({ candidate: c, section, position: 0 });
  };
  const usable = (c: ScoredCandidate) =>
    !used.has(c.refId) && (domainCount.get(c.sourceDomain ?? "salma") ?? 0) < 2;

  // §28: aggregate audience interest can widen a section, never shrink below 1.
  const aud = ctx.audienceTopics;
  const audTotal = Object.values(aud).reduce((s, n) => s + n, 0);
  const widen = (key: string) => audTotal >= 5 && (aud[key] ?? 0) / audTotal >= 0.3;

  // 1) Lead (§19): best overall with an editorial floor — never a transfer,
  //    never an opinion piece, never on popularity alone.
  const lead = deduped.find((c) =>
    usable(c) && c.kind !== "transfer" && !c.opinion &&
    c.score >= LEAD_MIN_SCORE && c.parts.editorial >= 0.5 && c.parts.authority >= 0.4
  );
  if (lead) take(lead, "lead");

  // 2) Specialist sections.
  const fillSection = (section: NewsletterSection, max: number, min = SECTION_MIN_SCORE) => {
    let n = 0;
    for (const c of deduped) {
      if (n >= max) break;
      if (!usable(c) || c.section !== section || c.score < min) continue;
      take(c, section);
      n++;
    }
    return n;
  };

  fillSection("economy", widen("health_sector") ? 2 : 1);
  fillSection("research", widen("research_studies") ? 2 : 1);
  fillSection("qol", 1);
  fillSection("trend", 1);
  fillSection("expert", 1);
  fillSection("gcc", widen("gcc_health") || widen("kuwait_health") ? 3 : 2);

  // 3) أهم ما فاتك: the strongest remaining hard-news items (general pool or
  //    overflow from specialist sections).
  let missed = 0;
  for (const c of deduped) {
    if (missed >= 5) break;
    if (!usable(c) || c.kind === "transfer" || c.opinion) continue;
    if (c.score < SECTION_MIN_SCORE || c.parts.editorial < 0.45) continue;
    take(c, "top_missed");
    missed++;
    if (missed >= 3 && picks.length >= 10) break;
  }

  // 4) Transfers (§7): compact, capped.
  fillSection("transfers", widen("doctor_transfers") ? 6 : 4, 0);

  // 5) باختصار: short useful leftovers.
  let quick = 0;
  for (const c of deduped) {
    if (quick >= 5) break;
    if (!usable(c) || c.kind === "transfer") continue;
    if (c.score < QUICK_MIN_SCORE) continue;
    take(c, "quick");
    quick++;
  }

  // Near-duplicate backstop (§21): the signature clustering upstream misses
  // same-story items whose Arabic titles are worded differently (e.g. two
  // agency reports of one outbreak). Within the ISSUE, drop any later pick
  // sharing ≥3 distinctive tokens (length ≥4, or a number) with an earlier,
  // higher-placed pick.
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
      return shared >= 3;
    });
    if (!dup) tokenSets.push(tokens);
    return !dup;
  });
  picks.length = 0;
  picks.push(...nearDupFree);

  // Positions within sections follow score order of insertion.
  const perSection = new Map<NewsletterSection, number>();
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
  return { picks, emptySections };
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
