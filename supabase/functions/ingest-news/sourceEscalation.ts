// Primary Source Escalation V1 — PURE core + injectable orchestrator.
//
// Runs ONLY after the ESL selects a cluster for promotion (≤ the daily cap), so
// search volume is bounded to a handful of stories a day. Radar discovers a story
// (often via a weak/secondary outlet); before the Writer runs, we make a BOUNDED,
// story-type-aware attempt to find a STRONGER, more appropriate source for the
// SAME concrete development. Discovery source ≠ final editorial source.
//
// Ladder (short-circuits early; at most one web search):
//   A. rep sufficiency — the ESL already picked the best CLUSTER source; if it is
//      already strong/appropriate for the story type, stop (existing_best).
//   B. linked/cited — outbound links in the discovery article to a stronger,
//      appropriate source (cited → same development).
//   C. targeted search — ONE bounded web search on the specific development;
//      validate every candidate refers to the SAME development before accepting.
// Never blocks: no stronger validated source → keep the discovery source
// (no_upgrade_found); any error → escalation_failed, discovery source preserved.
// The Writer/Fidelity safeguards are unchanged.

export type StoryType =
  | "scientific_study" | "regulatory_decision" | "public_health" | "corporate_business"
  | "product_or_technology_announcement" | "product_safety_or_recall" | "product_claim"
  | "guidance_explainer" | "general";

export type SourceRole =
  | "regulator" | "journal" | "institution" | "wire" | "specialist_media"
  | "company" | "secondary_media";

export type EscalationStatus = "existing_best" | "upgraded" | "no_upgrade_found" | "escalation_failed";
export type EscalationMethod = "cluster" | "linked" | "search" | "none";

export type SourceRef = { url: string; domain: string; role: SourceRole; tier: number };

export type EscalationResult = {
  status: EscalationStatus;
  method: EscalationMethod;
  discovery_source: SourceRef;
  selected_editorial_source: SourceRef;
  supporting_url: string | null; // independent context (e.g. a wire alongside a company/journal primary)
  upgrade_reason: string;        // short, structured — never prose
};

export type RegistryEntry = { domain: string; source_type: string; tier: string };

// ---- domain → role + tier -------------------------------------------------

const REGULATOR = new Set([
  "fda.gov", "ema.europa.eu", "who.int", "cdc.gov", "nih.gov", "ecdc.europa.eu",
  "mhra.gov.uk", "moh.gov.kw", "sfda.gov.sa", "mohap.gov.ae", "moph.gov.qa",
  "hsa.gov.sg", "tga.gov.au", "gov.uk", "nhs.uk", "canada.ca",
]);
const JOURNAL = new Set([
  "nature.com", "nejm.org", "thelancet.com", "jamanetwork.com", "bmj.com",
  "science.org", "cell.com", "annals.org", "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov", "doi.org", "springer.com", "sciencedirect.com",
]);
const WIRE = new Set(["reuters.com", "apnews.com", "afp.com", "bloomberg.com"]);
const INSTITUTION = new Set([
  "mayoclinic.org", "health.harvard.edu", "hopkinsmedicine.org", "clevelandclinic.org",
  "cochrane.org", "medlineplus.gov", "health.gov", "cancer.gov", "heart.org",
]);
const SPECIALIST = new Set([
  "statnews.com", "medpagetoday.com", "endpts.com", "fiercebiotech.com",
  "fiercepharma.com", "medscape.com", "biopharmadive.com",
]);
const MAJOR_MEDIA = new Set([
  "bbc.com", "bbc.co.uk", "theguardian.com", "nytimes.com", "washingtonpost.com",
  "ft.com", "aljazeera.com", "cnn.com",
]);

export function normalizeDomain(d: string | null | undefined): string {
  return String(d ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0];
}
export function domainOf(url: string | null | undefined): string {
  const raw = String(url ?? "").trim();
  try { return normalizeDomain(new URL(raw).hostname); } catch { return normalizeDomain(raw); }
}

/** Does `domain` end at a registered suffix in `set` (so sub.fda.gov matches fda.gov)? */
function inSet(domain: string, set: Set<string>): boolean {
  if (set.has(domain)) return true;
  for (const s of set) if (domain.endsWith("." + s)) return true;
  return false;
}

/** Role + numeric tier for a domain. Registry (news_sources) wins; else heuristics. */
export function roleTier(domain: string | null | undefined, registry: Map<string, RegistryEntry>): { role: SourceRole; tier: number } {
  const d = normalizeDomain(domain);
  if (!d) return { role: "secondary_media", tier: 5 };
  const reg = registry.get(d);
  if (reg) {
    if (reg.tier === "blocked") return { role: "secondary_media", tier: 5 };
    if (reg.source_type === "official") return { role: "regulator", tier: 1 };
    if (reg.source_type === "research") return { role: "journal", tier: 2 };
    if (reg.source_type === "medical_institution" || reg.source_type === "reference") return { role: "institution", tier: 2 };
    if (reg.source_type === "media") return { role: "secondary_media", tier: reg.tier === "1" ? 3 : 4 };
  }
  if (inSet(d, REGULATOR)) return { role: "regulator", tier: 1 };
  if (inSet(d, JOURNAL)) return { role: "journal", tier: 2 };
  if (inSet(d, WIRE)) return { role: "wire", tier: 2 };
  if (inSet(d, INSTITUTION)) return { role: "institution", tier: 2 };
  if (inSet(d, SPECIALIST)) return { role: "specialist_media", tier: 3 };
  if (inSet(d, MAJOR_MEDIA)) return { role: "secondary_media", tier: 3 };
  return { role: "secondary_media", tier: 5 };
}

// ---- story-type escalation targets ---------------------------------------
// Preferred source ROLES for the editorial claim (not just highest tier), and a
// query hint that biases the ONE web search toward the right authority.

// `hint` biases the ONE web search toward the story type's PRIMARY domains using
// site: operators (the search engine surfaces mainstream news otherwise). Every
// candidate is still validated as the same development before it can win.
type Target = { roles: SourceRole[]; hint: string };
const TARGETS: Record<StoryType, Target> = {
  regulatory_decision: { roles: ["regulator", "wire"], hint: "site:fda.gov OR site:ema.europa.eu OR site:gov.uk OR site:mhra.gov.uk OR site:sfda.gov.sa" },
  scientific_study: { roles: ["journal", "institution"], hint: "site:nature.com OR site:nejm.org OR site:thelancet.com OR site:science.org OR site:jamanetwork.com OR site:bmj.com OR site:pubmed.ncbi.nlm.nih.gov" },
  public_health: { roles: ["regulator", "institution", "wire"], hint: "site:who.int OR site:cdc.gov OR site:ecdc.europa.eu" },
  corporate_business: { roles: ["wire", "company"], hint: "site:reuters.com OR site:apnews.com OR site:bloomberg.com" },
  product_or_technology_announcement: { roles: ["wire", "journal", "institution", "company"], hint: "site:reuters.com OR site:apnews.com OR site:nature.com" },
  product_safety_or_recall: { roles: ["regulator", "company"], hint: "site:fda.gov OR site:sfda.gov.sa OR site:ema.europa.eu" },
  product_claim: { roles: ["regulator", "journal", "wire"], hint: "site:fda.gov OR site:nature.com OR site:reuters.com" },
  guidance_explainer: { roles: ["institution", "regulator", "journal"], hint: "site:mayoclinic.org OR site:health.harvard.edu OR site:nih.gov OR site:cochrane.org OR site:medlineplus.gov OR site:who.int" },
  general: { roles: ["wire", "journal", "regulator", "institution"], hint: "site:reuters.com OR site:apnews.com OR site:who.int OR site:nature.com" },
};

/** The ESL already picked the best cluster source. Is it already strong AND
 *  appropriate for the story type, so no external lookup is worthwhile? */
export function repSufficient(disc: { role: SourceRole; tier: number }, storyType: StoryType): boolean {
  if (disc.tier <= 2) return true; // already a strong primary/authority/journal/wire
  const roles = (TARGETS[storyType] ?? TARGETS.general).roles;
  return roles.includes(disc.role) && disc.tier <= 3;
}

/** A candidate role is an appropriate escalation target for this story type. */
export function isTargetRole(role: SourceRole, storyType: StoryType): boolean {
  return (TARGETS[storyType] ?? TARGETS.general).roles.includes(role);
}

/** Bounded, structured search query for the SPECIFIC development. */
export function buildQuery(title: string | null | undefined, storyType: StoryType): string {
  const t = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const hint = (TARGETS[storyType] ?? TARGETS.general).hint;
  return hint ? `${t} ${hint}` : t;
}

// ---- same-development validation -----------------------------------------
// A prestigious domain must NOT replace the story unless it refers to the SAME
// concrete development. Deterministic significant-token overlap across the
// discovery title(s) (original + Arabic) and the candidate title — entities and
// specific subjects, common words stripped.

const STOP_EN = new Set(["the", "a", "an", "of", "to", "in", "for", "and", "on", "with", "new", "study", "says", "after", "over", "as", "by", "is", "are", "at", "its", "from", "health", "news"]);
const STOP_AR = new Set(["في", "من", "على", "عن", "الى", "مع", "بعد", "قبل", "هذا", "هذه", "التي", "الذي", "بين", "حول", "خلال", "ضد", "او", "ما"]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const s = String(text ?? "");
  for (const m of s.toLowerCase().matchAll(/[a-z][a-z0-9-]{2,}/g)) if (!STOP_EN.has(m[0])) out.add(m[0]);
  for (const raw of s.replace(/[ً-ْٰـ]/g, "").split(/[^ء-ي]+/)) {
    if (!raw) continue;
    const w = raw.replace(/^(وال|بال|فال|كال|لل|ال)/, "");
    if (w.length >= 3 && !STOP_AR.has(w) && !STOP_AR.has(raw)) out.add(w);
  }
  return out;
}

/** True when the candidate title shares enough significant tokens with the
 *  discovery title(s) to be the same development. Cross-language entities
 *  (moderna, mrna, fda…) usually survive in the original-language title. */
export function sameDevelopment(candidateTitle: string, discoveryTitles: (string | null | undefined)[], minShared = 2): boolean {
  const cand = tokenize(candidateTitle);
  if (cand.size === 0) return false;
  const disc = new Set<string>();
  for (const t of discoveryTitles) for (const tok of tokenize(String(t ?? ""))) disc.add(tok);
  let shared = 0;
  for (const t of cand) if (disc.has(t)) { if (++shared >= minShared) return true; }
  return false;
}

// ---- orchestrator (injectable I/O) ----------------------------------------

export type EscalationInput = {
  discoveryUrl: string;
  discoveryDomain: string;
  title: string | null;       // original-language discovery title (entity-bearing)
  titleAr: string | null;     // Arabic translation, if any
  storyType: StoryType;
};

export type EscalationDeps = {
  registry: Map<string, RegistryEntry>;
  // Outbound links found in the discovery article (SSRF-safe fetch upstream).
  fetchOutboundLinks: (url: string) => Promise<string[]>;
  // ONE bounded web search → citations (url + title). Called at most once.
  webSearch: (query: string) => Promise<{ url: string; title: string }[]>;
};

function ref(url: string, registry: Map<string, RegistryEntry>): SourceRef {
  const domain = domainOf(url);
  const rt = roleTier(domain, registry);
  return { url, domain, role: rt.role, tier: rt.tier };
}

export async function escalate(input: EscalationInput, deps: EscalationDeps): Promise<EscalationResult> {
  const discovery = ref(input.discoveryUrl, deps.registry);
  const titles = [input.title, input.titleAr];
  const base = (status: EscalationStatus, method: EscalationMethod, selected: SourceRef, reason: string, supporting: string | null = null): EscalationResult =>
    ({ status, method, discovery_source: discovery, selected_editorial_source: selected, supporting_url: supporting, upgrade_reason: reason });

  // STEP A — the ESL's best cluster source is already strong/appropriate.
  if (repSufficient(discovery, input.storyType)) {
    return base("existing_best", "cluster", discovery, `discovery already ${discovery.role} (tier ${discovery.tier})`);
  }

  // STEP B — a stronger, appropriate source CITED in the discovery article.
  try {
    const links = await deps.fetchOutboundLinks(input.discoveryUrl);
    let best: SourceRef | null = null;
    for (const url of links) {
      const r = ref(url, deps.registry);
      if (r.tier < discovery.tier && isTargetRole(r.role, input.storyType)) {
        if (!best || r.tier < best.tier) best = r;
      }
    }
    if (best) return base("upgraded", "linked", best, `cited ${best.role} source (tier ${best.tier})`);
  } catch { /* fall through to search */ }

  // STEP C — ONE bounded targeted search for THIS development.
  try {
    const cites = await deps.webSearch(buildQuery(input.title || input.titleAr, input.storyType));
    let best: SourceRef | null = null;
    let supporting: string | null = null;
    for (const c of cites) {
      const r = ref(c.url, deps.registry);
      if (r.role === "wire" && !supporting && sameDevelopment(c.title, titles)) supporting = c.url; // independent context
      if (r.tier >= discovery.tier) continue;          // must be stronger
      if (!isTargetRole(r.role, input.storyType)) continue;
      if (!sameDevelopment(c.title, titles)) continue; // SAME development only
      if (!best || r.tier < best.tier) best = r;
    }
    if (best) {
      // Don't list the chosen primary as its own supporting source.
      if (supporting && domainOf(supporting) === best.domain) supporting = null;
      return base("upgraded", "search", best, `stronger ${best.role} via search (tier ${best.tier})`, supporting);
    }
  } catch {
    return base("escalation_failed", "none", discovery, "escalation error — discovery source preserved");
  }

  return base("no_upgrade_found", "none", discovery, "no stronger validated source found");
}
