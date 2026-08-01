// Controlled-example checks for the deterministic source-registry logic.
//
// Runs on Node's native TypeScript type-stripping (Node >= 22.6 / used here on
// v24): `node supabase/functions/ingest-news/registry.test.ts`. This module is
// intentionally free of Deno/Supabase imports so it is unit-testable in Node.

import test from "node:test";
import assert from "node:assert/strict";
import {
  blockedDomains,
  buildRegistryIndex,
  discoveryDomains,
  failsPrGate,
  hostFromUrl,
  matchSource,
  normalizeHost,
  pickFinalSource,
  registryUsable,
  type Candidate,
  type RegistrySource,
  type RejectionReason,
} from "./registry.ts";

function src(partial: Partial<RegistrySource> & { domain: string }): RegistrySource {
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

const REGISTRY: RegistrySource[] = [
  src({ name: "WHO", domain: "who.int", tier: "1", trust_score: 96, source_type: "official" }),
  src({ name: "MoH Kuwait", domain: "moh.gov.kw", tier: "1", trust_score: 92, region: "kuwait" }),
  src({
    name: "New England Journal of Medicine",
    domain: "nejm.org",
    tier: "1",
    trust_score: 96,
    source_type: "research",
  }),
  src({ name: "Reuters", domain: "reuters.com", tier: "2", trust_score: 78, source_type: "media" }),
  src({
    name: "Discovery-only wire",
    domain: "context-only.example",
    tier: "2",
    trust_score: 70,
    final_source_allowed: false,
  }),
  src({ name: "Spam farm", domain: "spam.example", tier: "blocked", trust_score: 0 }),
  src({
    name: "No-discovery ref",
    domain: "quiet.example",
    tier: "1",
    trust_score: 80,
    discovery_enabled: false,
  }),
];

const index = buildRegistryIndex(REGISTRY);

test("normalizeHost strips scheme, www, path, case", () => {
  assert.equal(normalizeHost("HTTPS://WWW.Who.int/emergencies?x=1"), "who.int");
  assert.equal(normalizeHost("who.int"), "who.int");
  assert.equal(hostFromUrl("https://www.who.int/news/item/123"), "who.int");
  // A subdomain is preserved by normalization (matching walks up separately).
  assert.equal(normalizeHost("apps.who.int"), "apps.who.int");
});

test("matchSource walks up parent domains (apps.who.int -> who.int)", () => {
  assert.equal(matchSource("apps.who.int", index)?.name, "WHO");
  assert.equal(matchSource("who.int", index)?.tier, "1");
  assert.equal(matchSource("unknown-aggregator.example", index), null);
});

test("WHO health alert = high-trust Tier 1 final source", () => {
  const candidates: Candidate[] = [
    { url: "https://www.who.int/news/item/alert", source: matchSource("who.int", index) },
  ];
  const pick = pickFinalSource(candidates, true);
  assert.ok(pick.chosen);
  assert.equal(pick.chosen.source?.tier, "1");
  assert.equal(pick.chosen.source?.trust_score, 96);
});

test("blocked-only candidates are rejected", () => {
  const candidates: Candidate[] = [
    { url: "https://spam.example/x", source: matchSource("spam.example", index) },
  ];
  const pick = pickFinalSource(candidates, true);
  assert.equal(pick.chosen, null);
  assert.equal(pick.reason, "weak_or_unverified_source");
});

test("Tier 2 aggregator yields to the Tier 1 original", () => {
  const candidates: Candidate[] = [
    { url: "https://reuters.com/health/x", source: matchSource("reuters.com", index) },
    { url: "https://who.int/news/item/original", source: matchSource("who.int", index) },
  ];
  const pick = pickFinalSource(candidates, true);
  assert.equal(pick.chosen?.source?.name, "WHO");
});

test("weak unregistered aggregator yields to a registered Tier 1", () => {
  const candidates: Candidate[] = [
    { url: "https://random-egypt-aggregator.example/a", source: null },
    { url: "https://moh.gov.kw/news/b", source: matchSource("moh.gov.kw", index) },
  ];
  const pick = pickFinalSource(candidates, true);
  assert.equal(pick.chosen?.source?.name, "MoH Kuwait");
});

test("final_source_allowed=false may only be context, not final", () => {
  const candidates: Candidate[] = [
    { url: "https://context-only.example/a", source: matchSource("context-only.example", index) },
  ];
  const pick = pickFinalSource(candidates, true);
  assert.equal(pick.chosen, null);
  assert.equal(pick.reason, "stronger_primary_source_required");
});

test("registry unavailable falls back to the first real candidate", () => {
  const candidates: Candidate[] = [
    { url: "https://any-source.example/a", source: null },
  ];
  const pick = pickFinalSource(candidates, false);
  assert.equal(pick.chosen?.url, "https://any-source.example/a");
  assert.equal(pick.reason, null);
});

test("PR gate: high institutional-PR + low editorial value is rejected", () => {
  // Ministry conference: promotional, no concrete public impact.
  assert.equal(failsPrGate(30, 70), true);
  // Inauguration WITH service details: editorial value high enough -> keep.
  assert.equal(failsPrGate(55, 70), false);
  // Genuine story with low PR score -> keep.
  assert.equal(failsPrGate(30, 40), false);
});

test("discoveryDomains ranks Tier 1 first and excludes blocked/disabled", () => {
  const domains = discoveryDomains(REGISTRY);
  assert.equal(domains[0], "who.int"); // tier 1, highest trust
  assert.ok(!domains.includes("spam.example")); // blocked
  assert.ok(!domains.includes("quiet.example")); // discovery_enabled = false
  assert.ok(domains.includes("moh.gov.kw"));
});

test("blockedDomains lists only active blocked sources", () => {
  assert.deepEqual(blockedDomains(REGISTRY), ["spam.example"]);
});

// ---------------------------------------------------------------------------
// Controlled ingestion simulation. `evaluate` mirrors the decision order in
// index.ts processItem() exactly — model reject -> PR-gate backstop -> build
// candidates limited to REAL citations -> pickFinalSource — over mocked search
// citations, so we can assert end-to-end selection without Deno/network.
// ---------------------------------------------------------------------------

// Mirrors index.ts dedupeKeyFromUrl (host + path), used to dedupe candidates.
function dedupeKeyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

type MockDraft = {
  editorial_value_score: number;
  institutional_pr_score: number;
  rejection_reason: RejectionReason | null;
  candidateUrls: string[];
};

type EvalResult =
  | { accepted: true; chosen: Candidate }
  | { accepted: false; reason: RejectionReason };

function evaluate(
  draft: MockDraft,
  realCitations: Set<string>,
  idx: Map<string, RegistrySource>,
): EvalResult {
  if (draft.rejection_reason) return { accepted: false, reason: draft.rejection_reason };
  if (failsPrGate(draft.editorial_value_score, draft.institutional_pr_score))
    return { accepted: false, reason: "ceremonial_or_promotional" };

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const url of draft.candidateUrls) {
    const k = dedupeKeyFromUrl(url);
    // Anti-fabrication: only URLs the plugin actually returned are usable.
    if (!k || !realCitations.has(url) || seen.has(k)) continue;
    seen.add(k);
    candidates.push({ url, source: matchSource(hostFromUrl(url), idx) });
  }
  const pick = pickFinalSource(candidates, true);
  if (!pick.chosen) return { accepted: false, reason: pick.reason };
  return { accepted: true, chosen: pick.chosen };
}

test("SIM: official conference participation is rejected (PR gate)", () => {
  const citations = new Set(["https://moh.gov.kw/news/minister-attends-conference"]);
  const result = evaluate(
    {
      editorial_value_score: 25,
      institutional_pr_score: 75,
      rejection_reason: null,
      candidateUrls: ["https://moh.gov.kw/news/minister-attends-conference"],
    },
    citations,
    index,
  );
  assert.equal(result.accepted, false);
  assert.equal((result as { reason: string }).reason, "ceremonial_or_promotional");
});

test("SIM: official safety alert is accepted from a Tier 1 source", () => {
  const citations = new Set(["https://who.int/news/item/drug-safety-alert"]);
  const result = evaluate(
    {
      editorial_value_score: 88,
      institutional_pr_score: 10,
      rejection_reason: null,
      candidateUrls: ["https://who.int/news/item/drug-safety-alert"],
    },
    citations,
    index,
  );
  assert.equal(result.accepted, true);
  assert.equal((result as { chosen: Candidate }).chosen.source?.tier, "1");
});

test("SIM: inauguration WITH patient-access details keeps only substantive info", () => {
  const citations = new Set(["https://moh.gov.kw/news/new-clinic-opens-booking"]);
  // Real access details raise editorial value above the PR-gate threshold, so
  // the substantive item is kept (the model strips the ceremonial wording).
  const kept = evaluate(
    {
      editorial_value_score: 60,
      institutional_pr_score: 65,
      rejection_reason: null,
      candidateUrls: ["https://moh.gov.kw/news/new-clinic-opens-booking"],
    },
    citations,
    index,
  );
  assert.equal(kept.accepted, true);
  // A bare ribbon-cutting with no service info stays rejected.
  const bare = evaluate(
    {
      editorial_value_score: 20,
      institutional_pr_score: 70,
      rejection_reason: null,
      candidateUrls: ["https://moh.gov.kw/news/new-clinic-opens-booking"],
    },
    citations,
    index,
  );
  assert.equal(bare.accepted, false);
});

test("SIM: a Tier 2 story selects the matching Tier 1 primary source", () => {
  const citations = new Set([
    "https://reuters.com/health/study-coverage",
    "https://nejm.org/doi/original-study",
  ]);
  const result = evaluate(
    {
      editorial_value_score: 80,
      institutional_pr_score: 15,
      rejection_reason: null,
      candidateUrls: [
        "https://reuters.com/health/study-coverage",
        "https://nejm.org/doi/original-study",
      ],
    },
    citations,
    index,
  );
  assert.equal(result.accepted, true);
  assert.equal((result as { chosen: Candidate }).chosen.source?.name, "New England Journal of Medicine");
});

test("SIM: a blocked source is rejected", () => {
  const citations = new Set(["https://spam.example/clickbait"]);
  const result = evaluate(
    {
      editorial_value_score: 90,
      institutional_pr_score: 5,
      rejection_reason: null,
      candidateUrls: ["https://spam.example/clickbait"],
    },
    citations,
    index,
  );
  assert.equal(result.accepted, false);
  assert.equal((result as { reason: string }).reason, "weak_or_unverified_source");
});

test("SIM: registry unavailability yields no usable registry (no drafts)", () => {
  // index.ts aborts the run (creating no drafts) whenever registryUsable is false.
  assert.equal(registryUsable(false, 0), false); // load query failed
  assert.equal(registryUsable(false, 5), false); // failed even if a stale count leaks
  assert.equal(registryUsable(true, 0), false); // loaded but empty -> cannot verify
  assert.equal(registryUsable(true, 5), true); // healthy
});
