// DEVELOP STORY V2 — Authoritative Source Network (pure module).
//
// Code-level source intelligence: which KINDS of sources should be preferred
// for which kinds of claims, plus deterministic routing signals (literature /
// trials / regulatory / GCC) and the adaptive research-depth decision.
//
// Deliberately NOT registry-backed: active news_sources rows feed Radar
// discovery, ESL and the escalation registry, so classifications here live
// entirely in code (owner adjustment #1) — zero impact on Radar behavior.
// For domains outside this map, sourceEscalation's roleTier() heuristics
// remain the fallback via roleToClass().

import type { SourceRole } from "../ingest-news/sourceEscalation.ts";

export type SourceClass =
  | "primary_study"
  | "systematic_review"
  | "trial_registry"
  | "regulator"
  | "public_health_agency"
  | "guideline_body"
  | "gcc_ministry"
  | "institution"
  | "wire"
  | "secondary_media"
  | "company_pr";

export type ClaimDomain =
  | "drug_regulatory"
  | "clinical_trial"
  | "scientific"
  | "medicine_disease"
  | "gcc_health"
  | "general";

export const CLASS_LABELS_AR: Record<SourceClass, string> = {
  primary_study: "دراسة محكّمة",
  systematic_review: "مراجعة منهجية",
  trial_registry: "سجل تجارب سريرية",
  regulator: "جهة تنظيمية",
  public_health_agency: "هيئة صحة عامة",
  guideline_body: "جهة إرشادات طبية",
  gcc_ministry: "وزارة/هيئة صحية خليجية",
  institution: "مؤسسة طبية",
  wire: "وكالة أنباء",
  secondary_media: "مصدر إخباري",
  company_pr: "بيان شركة",
};

/** Classes that count as PRIMARY evidence for external factual claims. */
export const PRIMARY_CLASSES: ReadonlySet<SourceClass> = new Set([
  "primary_study",
  "systematic_review",
  "trial_registry",
  "regulator",
  "public_health_agency",
  "guideline_body",
  "gcc_ministry",
]);

type DomainEntry = { cls: SourceClass; tier: number };

/** Fixed authoritative-domain map (registrable domains). Editable in code
 *  without schema work; everything else falls back to roleToClass(). */
export const AUTHORITATIVE_DOMAINS: Record<string, DomainEntry> = {
  // International regulators / agencies
  "fda.gov": { cls: "regulator", tier: 1 },
  "ema.europa.eu": { cls: "regulator", tier: 1 },
  "mhra.gov.uk": { cls: "regulator", tier: 1 },
  "who.int": { cls: "public_health_agency", tier: 1 },
  "cdc.gov": { cls: "public_health_agency", tier: 1 },
  "ecdc.europa.eu": { cls: "public_health_agency", tier: 1 },
  "nih.gov": { cls: "public_health_agency", tier: 1 },
  // Registries / literature
  "clinicaltrials.gov": { cls: "trial_registry", tier: 1 },
  "pubmed.ncbi.nlm.nih.gov": { cls: "primary_study", tier: 1 },
  "ncbi.nlm.nih.gov": { cls: "primary_study", tier: 1 },
  "cochrane.org": { cls: "systematic_review", tier: 1 },
  // Journals (primary literature)
  "nature.com": { cls: "primary_study", tier: 1 },
  "nejm.org": { cls: "primary_study", tier: 1 },
  "thelancet.com": { cls: "primary_study", tier: 1 },
  "jamanetwork.com": { cls: "primary_study", tier: 1 },
  "bmj.com": { cls: "primary_study", tier: 1 },
  "science.org": { cls: "primary_study", tier: 1 },
  "doi.org": { cls: "primary_study", tier: 1 },
  // Guidelines / consensus
  "nice.org.uk": { cls: "guideline_body", tier: 1 },
  "uptodate.com": { cls: "guideline_body", tier: 2 },
  // GCC / Kuwait authorities
  "moh.gov.kw": { cls: "gcc_ministry", tier: 1 },
  "moh.gov.sa": { cls: "gcc_ministry", tier: 1 },
  "sfda.gov.sa": { cls: "regulator", tier: 1 },
  "mohap.gov.ae": { cls: "gcc_ministry", tier: 1 },
  "doh.gov.ae": { cls: "gcc_ministry", tier: 1 },
  "dha.gov.ae": { cls: "gcc_ministry", tier: 1 },
  "moph.gov.qa": { cls: "gcc_ministry", tier: 1 },
  "moh.gov.bh": { cls: "gcc_ministry", tier: 1 },
  "moh.gov.om": { cls: "gcc_ministry", tier: 1 },
  "hamad.qa": { cls: "institution", tier: 2 },
};

/** Map a sourceEscalation heuristic role onto the richer class vocabulary. */
export function roleToClass(role: SourceRole): SourceClass {
  switch (role) {
    case "regulator":
      return "regulator";
    case "journal":
      return "primary_study";
    case "institution":
      return "institution";
    case "wire":
      return "wire";
    case "company":
      return "company_pr";
    case "specialist_media":
    case "secondary_media":
    default:
      return "secondary_media";
  }
}

/** Registrable-domain match against the authoritative map. */
export function classifyDomain(domain: string): DomainEntry | null {
  const d = (domain ?? "").toLowerCase();
  if (!d) return null;
  if (AUTHORITATIVE_DOMAINS[d]) return AUTHORITATIVE_DOMAINS[d];
  for (const key of Object.keys(AUTHORITATIVE_DOMAINS)) {
    if (d === key || d.endsWith("." + key)) return AUTHORITATIVE_DOMAINS[key];
  }
  return null;
}

// ---- Claim-domain detection (deterministic, no LLM) ------------------------

const DRUG_REGULATORY_CUES = [
  "fda", "ema", "mhra", "sfda", "approval", "approves", "approved", "authorization",
  "recall", "موافقة", "اعتماد", "ترخيص", "سحب", "هيئة الغذاء والدواء", "هيئة الدواء",
  "إدارة الغذاء والدواء", "وكالة الأدوية",
];
const TRIAL_CUES = [
  "clinical trial", "phase 1", "phase 2", "phase 3", "phase i", "phase ii", "phase iii",
  "enrollment", "placebo", "randomized", "تجربة سريرية", "تجارب سريرية", "المرحلة الأولى",
  "المرحلة الثانية", "المرحلة الثالثة", "عقار تجريبي", "علاج تجريبي",
];
const SCIENTIFIC_CUES = [
  "study", "studies", "researchers", "peer-reviewed", "meta-analysis", "journal",
  "دراسة", "دراسات", "باحثون", "الباحثون", "مجلة علمية", "تحليل تلوي", "مراجعة منهجية",
  "عينة", "sample size", "cohort", "observational",
];
const GCC_CUES = [
  "kuwait", "saudi", "uae", "qatar", "bahrain", "oman", "الكويت", "السعودية",
  "الإمارات", "قطر", "البحرين", "عمان", "وزارة الصحة", "الهيئة العامة للغذاء",
];
const NCT_RE = /NCT\d{8}/i;

export function detectClaimDomains(text: string, profile: string): Set<ClaimDomain> {
  const t = (text ?? "").toLowerCase();
  const out = new Set<ClaimDomain>();
  const hit = (cues: string[]) => cues.some((c) => t.includes(c));
  // NB: regulation_or_service is NOT a drug-regulatory signal by itself — a
  // ministry SERVICE story (vaccination campaign, digital service) must stay
  // standard depth. Only explicit drug/approval cues or a safety alert deepen.
  if (hit(DRUG_REGULATORY_CUES) || profile === "safety_alert") {
    out.add("drug_regulatory");
  }
  if (hit(TRIAL_CUES) || NCT_RE.test(text ?? "")) out.add("clinical_trial");
  if (hit(SCIENTIFIC_CUES) || profile === "research_study") out.add("scientific");
  if (hit(GCC_CUES)) out.add("gcc_health");
  out.add(out.size === 0 ? "general" : "medicine_disease");
  return out;
}

// ---- Adaptive research depth (owner adjustment #2) --------------------------
//
// Depth is adaptive BY DEFAULT: evidence-heavy topics automatically research
// deeper; «بحث معمّق» in the UI is only an optional override.
export function adaptiveDepth(domains: Set<ClaimDomain>): "standard" | "deep" {
  if (domains.has("scientific") || domains.has("clinical_trial") || domains.has("drug_regulatory")) {
    return "deep";
  }
  return "standard";
}

export type DepthCaps = {
  webFetches: number;     // verified full-text fetches of web sources
  literature: number;     // PubMed items kept
  trials: number;         // ClinicalTrials items kept
  extraSearches: number;  // extra class-targeted web searches
  corpusChars: number;    // frozen grounding corpus bound
};

export function depthCaps(depth: "standard" | "deep"): DepthCaps {
  return depth === "deep"
    ? { webFetches: 7, literature: 6, trials: 3, extraSearches: 2, corpusChars: 42_000 }
    : { webFetches: 4, literature: 4, trials: 2, extraSearches: 1, corpusChars: 28_000 };
}

// ---- Routing: which retrievers run ------------------------------------------

export function shouldSearchLiterature(domains: Set<ClaimDomain>, depth: string): boolean {
  return domains.has("scientific") || domains.has("clinical_trial") || depth === "deep";
}
export function shouldSearchTrials(domains: Set<ClaimDomain>): boolean {
  return domains.has("clinical_trial");
}
export function shouldSearchOpenFda(domains: Set<ClaimDomain>): boolean {
  return domains.has("drug_regulatory");
}

/** Extra targeted web-search hints per claim domain (site: operators). */
export const DOMAIN_SEARCH_HINTS: Record<ClaimDomain, string | null> = {
  drug_regulatory: "site:fda.gov OR site:ema.europa.eu OR site:sfda.gov.sa OR site:mhra.gov.uk",
  clinical_trial: "site:clinicaltrials.gov OR site:nejm.org OR site:thelancet.com",
  scientific: "site:pubmed.ncbi.nlm.nih.gov OR site:nature.com OR site:nejm.org OR site:cochrane.org",
  gcc_health: "site:moh.gov.kw OR site:moh.gov.sa OR site:sfda.gov.sa OR site:mohap.gov.ae OR site:moph.gov.qa",
  medicine_disease: "site:who.int OR site:cdc.gov OR site:nih.gov",
  general: null,
};

// ---- Evidence ranking helper -------------------------------------------------
//
// Multi-factor, never one opaque score: primary-ness, tier, recency. Used
// only to ORDER and CAP what enters the brief — source role is preserved on
// every item, and secondary sources are kept as context, never discarded.
export function rankEvidence<T extends {
  is_primary: boolean;
  tier: number | null;
  published_date: string | null;
}>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    const ta = a.tier ?? 5, tb = b.tier ?? 5;
    if (ta !== tb) return ta - tb;
    return (b.published_date ?? "").localeCompare(a.published_date ?? "");
  });
}
