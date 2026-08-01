// Pure source-registry logic for the news-ingestion agent (E1.1).
//
// This module has NO Deno/Supabase imports on purpose: it holds the
// deterministic source-ranking and editorial-gate helpers so they can be unit
// tested in isolation (see registry.test.ts). index.ts wires these into the run.

export type SourceTier = "1" | "2" | "3" | "blocked";

export type RegistrySource = {
  name: string;
  domain: string;
  region: string;
  source_type: string;
  tier: SourceTier;
  trust_score: number;
  discovery_enabled: boolean;
  final_source_allowed: boolean;
  active: boolean;
};

// The canonical set of rejection reasons the audit log accepts.
export const REJECTION_REASONS = [
  "ceremonial_or_promotional",
  "no_concrete_public_impact",
  "generic_institutional_announcement",
  "memorandum_without_deliverables",
  "official_activity_without_news_value",
  "weak_or_unverified_source",
  "stronger_primary_source_required",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export function isRejectionReason(v: unknown): v is RejectionReason {
  return typeof v === "string" && (REJECTION_REASONS as readonly string[]).includes(v);
}

/**
 * Normalize a host exactly like the DB `normalize_host` function and the admin
 * action: lowercase, drop scheme, a leading "www.", and any path/port/query.
 * Returns "" when nothing usable remains.
 */
export function normalizeHost(input: string): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/:?#].*$/, "");
}

/** Extract the normalized host from a full URL string (or "" if unparseable). */
export function hostFromUrl(url: string): string {
  try {
    return normalizeHost(new URL(url).host);
  } catch {
    return normalizeHost(url);
  }
}

/** Index active registry sources by normalized domain for O(1) lookups. */
export function buildRegistryIndex(sources: RegistrySource[]): Map<string, RegistrySource> {
  const map = new Map<string, RegistrySource>();
  for (const s of sources) {
    if (!s.active) continue;
    const key = normalizeHost(s.domain);
    if (key) map.set(key, s);
  }
  return map;
}

/**
 * Match a host to a registry source, walking up parent domains so that e.g.
 * `apps.who.int` matches `who.int`. A more specific subdomain row (emro.who.int)
 * wins over its parent because it is tried first.
 */
export function matchSource(
  host: string,
  index: Map<string, RegistrySource>,
): RegistrySource | null {
  let h = normalizeHost(host);
  while (h) {
    const hit = index.get(h);
    if (hit) return hit;
    const dot = h.indexOf(".");
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return null;
}

const TIER_RANK: Record<string, number> = { "1": 1, "2": 2, "3": 3 };
/** Lower is better. Unknown (unregistered) ranks below tier 3; blocked is excluded upstream. */
export function tierRank(source: RegistrySource | null): number {
  if (!source) return 4;
  return TIER_RANK[source.tier] ?? 4;
}

export type Candidate = { url: string; source: RegistrySource | null };
export type FinalPick =
  | { chosen: Candidate; reason: null }
  | { chosen: null; reason: RejectionReason };

/**
 * Choose the strongest usable final source among the candidate URLs behind a
 * story. Rules:
 *  - blocked sources are never used;
 *  - a Tier-1 primary (ministry/regulator/journal) beats a Tier-2/3 or an
 *    unregistered aggregator;
 *  - sources flagged final_source_allowed = false may only be context, not final;
 *  - when the registry is unavailable we fall back to the first real candidate.
 */
export function pickFinalSource(candidates: Candidate[], registryAvailable: boolean): FinalPick {
  if (candidates.length === 0) return { chosen: null, reason: "weak_or_unverified_source" };
  if (!registryAvailable) return { chosen: candidates[0], reason: null };

  const nonBlocked = candidates.filter((c) => c.source?.tier !== "blocked");
  if (nonBlocked.length === 0) return { chosen: null, reason: "weak_or_unverified_source" };

  // Eligible as FINAL: unregistered (unknown) or explicitly final-allowed.
  const eligible = nonBlocked.filter((c) => !c.source || c.source.final_source_allowed);
  if (eligible.length === 0) return { chosen: null, reason: "stronger_primary_source_required" };

  eligible.sort((a, b) => {
    const t = tierRank(a.source) - tierRank(b.source);
    if (t !== 0) return t;
    return (b.source?.trust_score ?? 0) - (a.source?.trust_score ?? 0);
  });
  return { chosen: eligible[0], reason: null };
}

/**
 * Deterministic backstop over the model's own editorial judgement: an
 * institutional PR release with high promotional score and low editorial value
 * is rejected even if the model tried to keep it.
 */
export function failsPrGate(editorialValue: number, institutionalPr: number): boolean {
  return institutionalPr >= 60 && editorialValue < 40;
}

/**
 * The registry is only usable when the load query succeeded AND returned at
 * least one active source. Anything else (query error, empty set) means we
 * cannot verify sources — the caller must fail safe (no drafts) rather than
 * silently accepting unverified citations.
 */
export function registryUsable(ok: boolean, sourceCount: number): boolean {
  return ok && sourceCount > 0;
}

/** Active domains the discovery step should target (tier-1 first, blocked excluded). */
export function discoveryDomains(sources: RegistrySource[], limit = 40): string[] {
  return sources
    .filter((s) => s.active && s.discovery_enabled && s.tier !== "blocked")
    .sort((a, b) => tierRank(a) - tierRank(b) || b.trust_score - a.trust_score)
    .map((s) => normalizeHost(s.domain))
    .filter((d): d is string => !!d)
    .slice(0, limit);
}

/** Active blocked domains the discovery step should avoid. */
export function blockedDomains(sources: RegistrySource[]): string[] {
  return sources
    .filter((s) => s.active && s.tier === "blocked")
    .map((s) => normalizeHost(s.domain))
    .filter((d): d is string => !!d);
}
