// Editorial Selection Layer — PURE, deterministic core.
//
// No network, no Deno APIs — everything here is unit-testable. The edge handler
// (index.ts) loads data + runs the (bounded) LLM classification, then this core
// does all clustering, source selection, scoring, diversity, and balancing so
// the selection stays understandable and tunable (never an LLM black box).

export type Lane = "L1" | "L2" | "L3" | "L4" | "L5";
export type StoryType =
  | "scientific_study"
  | "regulatory_decision"
  | "public_health"
  | "corporate_business"
  | "product_or_technology_announcement"
  | "product_safety_or_recall"
  | "product_claim"
  | "guidance_explainer"
  | "general";

export type RadarRow = {
  id: string;
  provider?: string | null;
  provider_uri?: string | null;
  event_uri: string | null;
  title: string | null;
  title_ar: string | null;
  url: string | null;
  source_title: string | null;
  source_domain: string | null;
  language: string | null;
  country: string | null;
  published_at: string | null;
  first_seen_at: string;
  priority_score: number | null;
  priority_level: string | null; // very_important | important | low
  expected_category_slug: string | null;
  duplicate_status: string | null; // new | possible_duplicate | already_in_salma
  matched_content_id: string | null;
  esl_lane: string | null;
  esl_story_type: string | null;
  esl_evidence_class: string | null; // research | guidance | none
  esl_gcc: boolean | null;
  esl_usefulness: number | null; // 0..100
  esl_canonical_key?: string | null;
};

export type RegistryEntry = {
  domain: string;
  source_type: string; // official | research | medical_institution | media | reference
  tier: string; // 1 | 2 | 3 | blocked
  trust_score: number | null;
};

export type SourceRole = "regulator" | "journal" | "institution" | "wire" | "company" | "general";

// ---- Source tier (deterministic) ----------------------------------------
// Registry match first (Salma already knows the domain); conservative fallback
// only when unknown. Tier 1 = strongest primary/official … 5 = weak aggregator.

const REGULATOR_DOMAINS = new Set([
  "fda.gov", "ema.europa.eu", "who.int", "cdc.gov", "nih.gov", "ecdc.europa.eu",
  "mhra.gov.uk", "moh.gov.kw", "sfda.gov.sa", "mohap.gov.ae", "moph.gov.qa",
]);
const WIRE_DOMAINS = new Set([
  "reuters.com", "apnews.com", "afp.com", "bloomberg.com",
]);
const JOURNAL_DOMAINS = new Set([
  "nature.com", "nejm.org", "thelancet.com", "jamanetwork.com", "bmj.com",
  "science.org", "cell.com", "thelancet.com",
]);
const SPECIALIST_DOMAINS = new Set([
  "statnews.com", "medpagetoday.com", "endpts.com", "fiercebiotech.com",
  "fiercepharma.com", "medscape.com",
]);
const MAJOR_MEDIA_DOMAINS = new Set([
  "bbc.com", "bbc.co.uk", "theguardian.com", "nytimes.com", "washingtonpost.com",
  "ft.com", "aljazeera.com", "cnn.com",
]);

export function normalizeDomain(d: string | null | undefined): string {
  return String(d ?? "").trim().toLowerCase().replace(/^www\./, "");
}

/** Numeric source tier 1..5 for a domain. Registry wins; else domain heuristic. */
export function sourceTier(domain: string | null | undefined, registry: Map<string, RegistryEntry>): number {
  const d = normalizeDomain(domain);
  if (!d) return 5;
  const reg = registry.get(d);
  if (reg) {
    if (reg.tier === "blocked") return 5;
    if (reg.source_type === "official") return 1;
    if (reg.source_type === "research" || reg.source_type === "medical_institution") return 2;
    if (reg.source_type === "reference") return 2;
    if (reg.source_type === "media") return reg.tier === "1" ? 3 : 4;
  }
  if (REGULATOR_DOMAINS.has(d)) return 1;
  if (JOURNAL_DOMAINS.has(d)) return 2;
  if (WIRE_DOMAINS.has(d)) return 2;
  if (SPECIALIST_DOMAINS.has(d)) return 3;
  if (MAJOR_MEDIA_DOMAINS.has(d)) return 4;
  return 5; // aggregator / unknown secondary
}

/** Coarse role of a domain, used for story-type-aware suitability. */
export function sourceRole(domain: string | null | undefined, registry: Map<string, RegistryEntry>): SourceRole {
  const d = normalizeDomain(domain);
  const reg = registry.get(d);
  if (REGULATOR_DOMAINS.has(d) || reg?.source_type === "official") return "regulator";
  if (JOURNAL_DOMAINS.has(d) || reg?.source_type === "research") return "journal";
  if (reg?.source_type === "medical_institution") return "institution";
  if (WIRE_DOMAINS.has(d)) return "wire";
  return "general";
}

// ---- Story-type-aware "best source for THIS claim" ----------------------
// The strongest source for the specific claim — NOT simply the highest tier.

const ROLE_PREFERENCE: Record<StoryType, SourceRole[]> = {
  scientific_study: ["journal", "institution", "wire", "regulator", "general"],
  regulatory_decision: ["regulator", "wire", "journal", "institution", "general"],
  public_health: ["regulator", "institution", "wire", "journal", "general"],
  // Corporate: independent wire adds context/verification over a company release.
  corporate_business: ["wire", "general", "regulator", "institution", "company"],
  // A company showing off tech/a product: prefer INDEPENDENT verification (wire /
  // specialist / journal) over the company's own announcement.
  product_or_technology_announcement: ["wire", "journal", "institution", "regulator", "general", "company"],
  // A recall / safety action: the regulator is the authority; independent wire next.
  product_safety_or_recall: ["regulator", "wire", "journal", "institution", "general", "company"],
  // Product/efficacy: prefer independent/regulatory evidence for the claim.
  product_claim: ["regulator", "journal", "wire", "institution", "general", "company"],
  guidance_explainer: ["institution", "regulator", "journal", "general"],
  general: ["wire", "journal", "regulator", "institution", "general"],
};

/** Pick the representative row of a cluster whose source best fits the story
 *  type. Higher role-fit dominates; tier and freshness break ties. */
export function bestSource(
  members: RadarRow[],
  storyType: StoryType,
  registry: Map<string, RegistryEntry>,
): RadarRow {
  const pref = ROLE_PREFERENCE[storyType] ?? ROLE_PREFERENCE.general;
  const rank = (r: RadarRow): number => {
    const role = sourceRole(r.source_domain, registry);
    const roleIdx = pref.indexOf(role);
    const roleScore = roleIdx >= 0 ? (pref.length - roleIdx) : 0; // higher = better fit
    const tier = sourceTier(r.source_domain, registry); // 1..5
    const tierScore = (6 - tier); // 5..1
    // role fit dominates (×10), tier is the tie-breaker, freshness a nudge.
    const fresh = r.published_at ? -ageHours(r.published_at, nowMsFallback(members)) / 1000 : 0;
    return roleScore * 10 + tierScore + fresh;
  };
  return [...members].sort((a, b) => rank(b) - rank(a))[0];
}

// Deterministic "now": callers pass an explicit nowMs into scoring; for bestSource
// tie-break we only need relative freshness, so derive a stable reference from the
// newest member rather than the wall clock (keeps the function pure/testable).
function nowMsFallback(members: RadarRow[]): number {
  let max = 0;
  for (const m of members) {
    const t = Date.parse(m.published_at ?? m.first_seen_at ?? "");
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max || 0;
}

function ageHours(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 999;
  return Math.max(0, (nowMs - t) / 3_600_000);
}

// ---- Clustering: one event → one candidate ------------------------------
// event_uri is the primary key (Event Registry's own event id). Rows without a
// usable event_uri fall back to a normalized-title signature so obvious
// republishers still collapse. Deterministic and cheap.

const STOP = new Set(["the", "a", "an", "of", "to", "in", "for", "and", "on", "with", "new", "study", "says", "after"]);
export function titleSignature(title: string | null | undefined): string {
  const toks = String(title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return toks.slice(0, 6).sort().join(" ");
}

export function clusterKey(row: RadarRow): string {
  const ev = String(row.event_uri ?? "").trim();
  if (ev) return `ev:${ev}`;
  const sig = titleSignature(row.title_ar || row.title);
  return sig ? `t:${sig}` : `id:${row.id}`;
}

export function clusterRows(rows: RadarRow[]): Map<string, RadarRow[]> {
  const m = new Map<string, RadarRow[]>();
  for (const r of rows) {
    const k = clusterKey(r);
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return m;
}

// ---- GCC relevance guard (content-based) --------------------------------
// GCC relevance must come from the SUBJECT of the story, never from the fact
// that a Gulf/Arabic outlet published it. This deterministic guard only ever
// DOWNGRADES the classifier's gcc flag: a story is treated as GCC-relevant only
// when the classifier said so AND an explicit GCC signal (a Gulf country,
// city, institution, or regulator) actually appears in the headline. It never
// upgrades, so it cannot manufacture GCC relevance.

const GCC_TOKENS_EN = [
  "kuwait", "saudi", "ksa", "uae", "united arab emirates", "emirati", "emirates",
  "qatar", "qatari", "bahrain", "bahraini", "oman", "omani", "riyadh", "jeddah",
  "mecca", "makkah", "medina", "dubai", "abu dhabi", "sharjah", "doha", "manama",
  "muscat", "gcc", "gulf cooperation", "gulf states", "sfda", "arabian gulf",
];
const GCC_TOKENS_AR = [
  "الكويت", "السعودية", "السعودي", "الإمارات", "الامارات", "إماراتي", "اماراتي",
  "قطر", "قطري", "البحرين", "بحريني", "عمان", "عماني", "الخليج", "خليجي",
  "مجلس التعاون", "الرياض", "جدة", "مكة", "المدينة المنورة", "دبي", "أبوظبي",
  "ابوظبي", "الشارقة", "الدوحة", "المنامة", "مسقط", "السعوديه",
];

/** Strip Arabic diacritics (harakat/tatweel) so token matching is robust. */
function stripArabicMarks(s: string): string {
  return s.replace(/[ـً-ْٰ]/g, "");
}

/** True when an explicit GCC subject signal appears in the given text (title). */
export function gccSignal(text: string | null | undefined): boolean {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  const en = raw.toLowerCase();
  if (GCC_TOKENS_EN.some((k) => en.includes(k))) return true;
  const ar = stripArabicMarks(raw);
  return GCC_TOKENS_AR.some((k) => ar.includes(stripArabicMarks(k)));
}

/** Resolve the final GCC flag: the classifier's judgement gated by an actual
 *  in-headline GCC signal. Downgrade-only (never invents GCC relevance). */
export function resolveGcc(llmGcc: boolean, ...texts: (string | null | undefined)[]): boolean {
  if (!llmGcc) return false;
  return texts.some((t) => gccSignal(t));
}

// ---- Cross-language canonical event merge -------------------------------
// Event Registry assigns LANGUAGE-SCOPED event ids, so the same real-world
// development surfaces as different event_uris in different languages and never
// clusters. radar-rank translates every headline to Arabic (title_ar), which
// gives a cross-language token bridge. We use it in two bounded stages:
//   (1) a cheap DETERMINISTIC pre-filter (significant shared tokens + a time
//       window) gathers only the AMBIGUOUS candidate set — most stories share
//       nothing and are never considered;
//   (2) a bounded LLM confirmer (index.ts) decides which of those actually
//       describe the SAME concrete development, and the result is cached.
// This never sends the whole pool to an LLM and never over-merges on topic alone.

const LATIN_STOP = new Set([
  "the", "a", "an", "of", "to", "in", "for", "and", "on", "with", "new", "study",
  "says", "after", "over", "amid", "as", "by", "is", "are", "at", "its", "from",
]);
const AR_STOP = new Set([
  "في", "من", "على", "عن", "الى", "مع", "بعد", "قبل", "هذا", "هذه", "التي", "الذي",
  "بين", "حول", "خلال", "ضد", "او", "ما", "لكن", "كما", "قد", "عبر", "أول", "أمام",
]);

/** Strip a leading Arabic article/clitic so "السرطان" and "سرطان" match. */
function normAr(w: string): string {
  const s = stripArabicMarks(w);
  return s.replace(/^(وال|بال|فال|كال|لل|ال)/, "");
}

/** Significant content tokens from a row's Arabic translation + original title:
 *  Latin words (entities/acronyms like moderna, mrna, merck, melanoma) and
 *  article-normalized Arabic words. Common stopwords removed. */
export function significantTokens(row: { title: string | null; title_ar: string | null }): Set<string> {
  const text = `${row.title_ar ?? ""}\n${row.title ?? ""}`;
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9-]{2,}/g)) {
    if (!LATIN_STOP.has(m[0])) out.add(m[0]);
  }
  for (const raw of stripArabicMarks(text).split(/[^ء-ي]+/)) {
    if (!raw) continue;
    const w = normAr(raw);
    if (w.length >= 3 && !AR_STOP.has(w) && !AR_STOP.has(raw)) out.add(w);
  }
  return out;
}

/** How many significant tokens two rows share (cross-language via title_ar). */
export function sharedTokenCount(a: RadarRow, b: RadarRow): number {
  const B = significantTokens(b);
  let n = 0;
  for (const t of significantTokens(a)) if (B.has(t)) n++;
  return n;
}

/**
 * Deterministic pre-filter: union-find groups of rows that PLAUSIBLY describe
 * the same development — they share at least `minShared` significant tokens and
 * fall within `windowMs`. Returns only multi-member groups (the bounded set that
 * warrants an LLM confirmation). Different developments about the same company
 * are deliberately NOT split here — that precision is the LLM's job.
 */
export function candidateMergeGroups(reps: RadarRow[], windowMs: number, minShared: number): RadarRow[][] {
  const n = reps.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const toks = reps.map(significantTokens);
  const times = reps.map((r) => Date.parse(r.published_at ?? r.first_seen_at ?? "") || 0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (times[i] && times[j] && Math.abs(times[i] - times[j]) > windowMs) continue;
      let shared = 0;
      for (const x of toks[i]) if (toks[j].has(x)) { shared++; if (shared >= minShared) break; }
      if (shared >= minShared) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, RadarRow[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(reps[i]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// When merging language variants that were classified with different story types
// (e.g. a "stock surge" corporate framing of a trial result), keep the most
// SUBSTANTIVE one — it drives best-source selection for the merged event.
const STORY_SUBSTANCE: StoryType[] = [
  "regulatory_decision", "scientific_study", "public_health", "product_safety_or_recall",
  "product_claim", "guidance_explainer", "product_or_technology_announcement",
  "corporate_business", "general",
];
export function dominantStoryType(members: RadarRow[]): StoryType {
  let best: StoryType = "general";
  let bestRank = STORY_SUBSTANCE.length;
  for (const m of members) {
    const st = (m.esl_story_type as StoryType) ?? "general";
    const rank = STORY_SUBSTANCE.indexOf(st);
    if (rank >= 0 && rank < bestRank) { bestRank = rank; best = st; }
  }
  return best;
}

// ---- L5 evidence gate ----------------------------------------------------
export function isL5Eligible(row: { esl_lane: string | null; esl_evidence_class: string | null }): boolean {
  return row.esl_lane === "L5" && (row.esl_evidence_class === "research" || row.esl_evidence_class === "guidance");
}

// ---- Composite score + diversity ----------------------------------------

export type DayState = {
  laneCounts: Record<string, number>;
  domains: Set<string>;
  countries: Set<string>;
  topicSigs: Set<string>;
  gccCount: number;
  totalSelected: number;
};

export function emptyDayState(): DayState {
  return { laneCounts: {}, domains: new Set(), countries: new Set(), topicSigs: new Set(), gccCount: 0, totalSelected: 0 };
}

const TIER_AUTHORITY = [0, 1.0, 0.85, 0.7, 0.55, 0.35]; // index by tier 1..5

export type ScoredCandidate = {
  rep: RadarRow;
  clusterKey: string;
  memberCount: number;
  lane: Lane;
  storyType: StoryType;
  gcc: boolean;
  tier: number;
  role: SourceRole;
  base: number;
  penalty: number;
  score: number;
};

/** Composite editorial score (0..~1). Transparent weighted signals; diversity
 *  penalties are applied against the current editorial-day state. */
export function scoreCandidate(
  rep: RadarRow,
  members: RadarRow[],
  registry: Map<string, RegistryEntry>,
  day: DayState,
  nowMs: number,
): ScoredCandidate {
  const lane = (rep.esl_lane as Lane) ?? "L1";
  const storyType = (rep.esl_story_type as StoryType) ?? "general";
  const gcc = rep.esl_gcc === true;
  const tier = sourceTier(rep.source_domain, registry);
  const role = sourceRole(rep.source_domain, registry);

  const importance = rep.priority_level === "very_important" ? 1 : rep.priority_level === "important" ? 0.7 : 0.45;
  const authority = TIER_AUTHORITY[Math.min(5, Math.max(1, tier))];
  const pref = ROLE_PREFERENCE[storyType] ?? ROLE_PREFERENCE.general;
  const roleIdx = pref.indexOf(role);
  const suitability = roleIdx >= 0 ? (pref.length - roleIdx) / pref.length : 0.4;
  const usefulness = Math.min(100, Math.max(0, rep.esl_usefulness ?? 50)) / 100;
  const ageH = ageHours(rep.published_at ?? rep.first_seen_at, nowMs);
  const freshness = Math.exp(-ageH / 48); // ~half-life 1.4 days
  const originality = rep.duplicate_status === "already_in_salma" ? 0.1 : rep.duplicate_status === "possible_duplicate" ? 0.6 : 1.0;
  const gccBonus = gcc ? 0.06 : 0;

  // Weighting: reader-usefulness and source authority carry real weight;
  // freshness is a light nudge (a fresher weak-source story must NOT out-rank an
  // otherwise comparable strong-source one on recency alone).
  const base =
    0.26 * importance +
    0.12 * suitability +
    0.18 * authority +
    0.18 * usefulness +
    0.08 * freshness +
    0.12 * originality +
    gccBonus;

  // "Breaking": genuinely major news may override the authority-floor penalty
  // (an important story is sometimes first surfaced by a weak outlet).
  const breaking = rep.priority_level === "very_important" && (rep.priority_score ?? 0) >= 80;

  // Diversity penalties vs today's selected set.
  const sig = titleSignature(rep.title_ar || rep.title);
  const dom = normalizeDomain(rep.source_domain);
  const country = String(rep.country ?? "").trim();
  let penalty = 0;
  if (sig && day.topicSigs.has(sig)) penalty += 0.5; // same topic already today
  if (dom && day.domains.has(dom)) penalty += 0.12; // same source already today
  if (country && country !== "" && day.countries.has(country)) penalty += 0.05;
  const laneCount = day.laneCounts[lane] ?? 0;
  if (laneCount >= 3) penalty += 0.08 * (laneCount - 2); // discourage lane pile-up

  // Authority-floor penalty: a weak-source cluster should need STRONGER
  // justification to consume one of only ~8 daily slots. Not a ban — breaking
  // importance waives it, and credible GCC/local coverage (often legitimately
  // the right local source) is only lightly penalized.
  if (!breaking) {
    if (tier >= 5) penalty += gcc ? 0.05 : 0.14;
    else if (tier === 4) penalty += gcc ? 0 : 0.05;
  }

  return {
    rep, clusterKey: clusterKey(rep), memberCount: members.length,
    lane, storyType, gcc, tier, role,
    base: Number(base.toFixed(4)), penalty: Number(penalty.toFixed(4)),
    score: Number((base - penalty).toFixed(4)),
  };
}

// ---- Balanced selection --------------------------------------------------

export type LaneConfig = {
  // soft floors/ceilings scaled by the effective cap
  ceilings: Partial<Record<string, number>>; // per-lane hard-ish ceiling
  floors: Partial<Record<string, number>>; // per-lane soft floor (aspiration)
  minScore: number; // eligibility floor
  breakingScore: number; // very_important+high score may exceed a soft ceiling
};

export function defaultLaneConfig(cap: number): LaneConfig {
  // Scaled for an ~8/day cap; ceilings prevent an all-clinical day.
  return {
    ceilings: { L1: Math.ceil(cap * 0.55), L2: Math.ceil(cap * 0.4), L3: Math.ceil(cap * 0.45), L4: Math.max(2, Math.round(cap * 0.3)), L5: Math.ceil(cap * 0.55) },
    floors: { L5: 2 },
    minScore: 0.42,
    breakingScore: 0.82,
  };
}

export type SelectionResult = {
  selected: ScoredCandidate[];
  skipped: { cand: ScoredCandidate; reason: string }[];
};

/**
 * Balanced, day-stateful pick. Greedy by score, honoring lane ceilings (a very
 * important high-score story may override a soft ceiling), a soft L5 floor
 * (never forced on dry days), a min-score gate, and the remaining daily cap.
 * `day` reflects what was already selected earlier this editorial day.
 */
// Selection-time near-duplicate backstop. Even after cross-language canonical
// merging (LLM-assisted, imperfect), two candidates can be the same development
// (e.g. a language variant the merge split off). Guard deterministically on
// shared DISTINCTIVE tokens — tokens that are rare across the candidate set
// (entities/specific subjects like "موديرنا"/"melanoma"), NOT common words like
// "الدواء"/"vaccine" that many unrelated stories share. Two candidates that share
// enough distinctive tokens must not both consume a daily slot.
const NEARDUP_MAX_DF = 3;      // a token in > this many candidates is "common", not distinctive
const NEARDUP_MIN_SHARED = 2;  // shared distinctive tokens at/above this → same development

function distinctiveTokenSets(candidates: ScoredCandidate[]): Map<ScoredCandidate, Set<string>> {
  const df = new Map<string, number>();
  const perCand = new Map<ScoredCandidate, Set<string>>();
  for (const c of candidates) {
    const toks = significantTokens(c.rep);
    perCand.set(c, toks);
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const out = new Map<ScoredCandidate, Set<string>>();
  for (const c of candidates) {
    const distinctive = new Set<string>();
    for (const t of perCand.get(c)!) if ((df.get(t) ?? 0) <= NEARDUP_MAX_DF) distinctive.add(t);
    out.set(c, distinctive);
  }
  return out;
}

export function selectBalanced(
  candidates: ScoredCandidate[],
  day: DayState,
  remainingCap: number,
  cfg: LaneConfig,
): SelectionResult {
  const selected: ScoredCandidate[] = [];
  const skipped: { cand: ScoredCandidate; reason: string }[] = [];
  if (remainingCap <= 0) {
    return { selected, skipped: candidates.map((c) => ({ cand: c, reason: "cap_reached" })) };
  }
  // Work on a mutable copy of day counts.
  const laneCounts: Record<string, number> = { ...day.laneCounts };
  const seenTopics = new Set(day.topicSigs);
  const seenDomains = new Set(day.domains);
  const distinctive = distinctiveTokenSets(candidates);
  const selectedDistinctive: Set<string>[] = [];

  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  for (const c of ranked) {
    if (selected.length >= remainingCap) { skipped.push({ cand: c, reason: "cap_reached" }); continue; }
    if (c.score < cfg.minScore) { skipped.push({ cand: c, reason: "low_score" }); continue; }
    const sig = titleSignature(c.rep.title_ar || c.rep.title);
    if (sig && seenTopics.has(sig)) { skipped.push({ cand: c, reason: "duplicate_topic" }); continue; }
    // Near-duplicate of something already picked this run (same development).
    const dset = distinctive.get(c)!;
    if (dset.size) {
      let near = false;
      for (const prev of selectedDistinctive) {
        let shared = 0;
        for (const t of dset) if (prev.has(t)) { if (++shared >= NEARDUP_MIN_SHARED) { near = true; break; } }
        if (near) break;
      }
      if (near) { skipped.push({ cand: c, reason: "near_duplicate" }); continue; }
    }
    const ceiling = cfg.ceilings[c.lane] ?? remainingCap;
    const cur = laneCounts[c.lane] ?? 0;
    // Breaking override keys on the INTRINSIC (pre-diversity-penalty) score, so a
    // genuinely major story isn't blocked by a full lane just because similar
    // stories ran earlier today.
    const breaking = c.rep.priority_level === "very_important" && c.base >= cfg.breakingScore;
    if (cur >= ceiling && !breaking) { skipped.push({ cand: c, reason: "lane_full" }); continue; }
    // accept
    selected.push(c);
    laneCounts[c.lane] = cur + 1;
    if (sig) seenTopics.add(sig);
    if (dset.size) selectedDistinctive.push(dset);
    const dom = normalizeDomain(c.rep.source_domain);
    if (dom) seenDomains.add(dom);
  }

  // Soft Healthy-Life (L5) floor — aim for a couple of credible lifestyle stories
  // a day WITHOUT forcing a quota. Healthy-Life material is almost always low
  // priority and weak-source, so it rarely out-scores breaking medicine; but when
  // credible L5 candidates exist (already past the evidence gate AND above the
  // min-score bar) they should appear in the mix. This promotes the best such L5,
  // displacing only the WEAKEST non-breaking, non-L5 pick, up to the floor. It
  // never manufactures: if no eligible L5 exists, nothing changes (→ select fewer,
  // or none). Quality stays mandatory — the evidence gate ran upstream.
  const floorL5 = cfg.floors.L5 ?? 0;
  if (floorL5 > 0) {
    const isBreaking = (x: ScoredCandidate) => x.rep.priority_level === "very_important" && x.base >= cfg.breakingScore;
    const selectedSet = new Set(selected);
    let l5n = selected.filter((x) => x.lane === "L5").length;
    const l5cands = ranked.filter((x) => x.lane === "L5" && x.score >= cfg.minScore && !selectedSet.has(x));
    for (const cand of l5cands) {
      if (l5n >= floorL5) break;
      const cd = distinctive.get(cand)!;
      const isDup = cd.size > 0 && selectedDistinctive.some((prev) => {
        let s = 0;
        for (const t of cd) if (prev.has(t) && ++s >= NEARDUP_MIN_SHARED) return true;
        return false;
      });
      if (isDup) continue;
      // Weakest displaceable pick: non-L5, non-breaking, lowest score.
      let vi = -1;
      for (let i = 0; i < selected.length; i++) {
        const s = selected[i];
        if (s.lane === "L5" || isBreaking(s)) continue;
        if (vi < 0 || s.score < selected[vi].score) vi = i;
      }
      if (vi < 0) break; // nothing displaceable (all breaking / already L5)
      const victim = selected[vi];
      selected[vi] = cand;
      selectedSet.delete(victim); selectedSet.add(cand);
      // move victim → skipped; remove cand's earlier skip entry.
      const ci = skipped.findIndex((sk) => sk.cand === cand);
      if (ci >= 0) skipped.splice(ci, 1);
      skipped.push({ cand: victim, reason: "l5_floor_displaced" });
      if (cd.size) selectedDistinctive.push(cd);
      l5n++;
    }
  }

  return { selected, skipped };
}
