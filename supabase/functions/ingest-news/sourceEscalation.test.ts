// Primary Source Escalation — deterministic unit tests. Run: node --test sourceEscalation.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  escalate, repSufficient, sameDevelopment, buildQuery, roleTier,
  type EscalationDeps, type EscalationInput, type RegistryEntry,
} from "./sourceEscalation.ts";

const reg = new Map<string, RegistryEntry>(); // empty → domain heuristics only

function deps(over: Partial<EscalationDeps> = {}): EscalationDeps & { calls: { links: number; search: number } } {
  const calls = { links: 0, search: 0 };
  return {
    calls,
    registry: reg,
    fetchOutboundLinks: async (_u: string) => { calls.links++; return over.fetchOutboundLinks ? await over.fetchOutboundLinks(_u) : []; },
    webSearch: async (q: string) => { calls.search++; return over.webSearch ? await over.webSearch(q) : []; },
  } as EscalationDeps & { calls: { links: number; search: number } };
}
function input(over: Partial<EscalationInput> = {}): EscalationInput {
  return {
    discoveryUrl: over.discoveryUrl ?? "https://smallblog.co/x",
    discoveryDomain: over.discoveryDomain ?? "smallblog.co",
    title: over.title ?? "t", titleAr: over.titleAr ?? null,
    storyType: over.storyType ?? "general",
  };
}

test("roleTier: regulator/journal/wire/institution/aggregator", () => {
  assert.deepEqual(roleTier("fda.gov", reg), { role: "regulator", tier: 1 });
  assert.deepEqual(roleTier("nature.com", reg), { role: "journal", tier: 2 });
  assert.deepEqual(roleTier("reuters.com", reg), { role: "wire", tier: 2 });
  assert.deepEqual(roleTier("mayoclinic.org", reg), { role: "institution", tier: 2 });
  assert.equal(roleTier("randomblog.co", reg).tier, 5);
});

test("strong cluster source → existing_best, NO external lookup", async () => {
  const d = deps();
  const res = await escalate(input({ discoveryDomain: "nature.com", discoveryUrl: "https://nature.com/a", storyType: "scientific_study" }), d);
  assert.equal(res.status, "existing_best");
  assert.equal(res.method, "cluster");
  assert.equal(d.calls.links, 0);
  assert.equal(d.calls.search, 0); // no wasted search work
});

test("weak source + stronger CITED (linked) source → upgraded", async () => {
  const d = deps({ fetchOutboundLinks: async () => ["https://www.fda.gov/news/approval-x", "https://ads.example/y"] });
  const res = await escalate(input({ storyType: "regulatory_decision", title: "regulator approves new drug" }), d);
  assert.equal(res.status, "upgraded");
  assert.equal(res.method, "linked");
  assert.equal(res.selected_editorial_source.role, "regulator");
  assert.equal(d.calls.search, 0); // linked short-circuits the search
});

test("weak source + stronger via SEARCH (same development) → upgraded", async () => {
  const d = deps({ webSearch: async () => [{ url: "https://www.fda.gov/melanoma-vaccine", title: "FDA on Moderna Merck melanoma mRNA vaccine trial" }] });
  const res = await escalate(input({ storyType: "regulatory_decision", title: "Moderna Merck melanoma mRNA vaccine passes trial" }), d);
  assert.equal(res.status, "upgraded");
  assert.equal(res.method, "search");
  assert.equal(res.selected_editorial_source.domain, "fda.gov");
});

test("prestigious but DIFFERENT event → rejected (keeps discovery)", async () => {
  // A Nature result about an UNRELATED topic must not replace the story.
  const d = deps({ webSearch: async () => [{ url: "https://nature.com/climate-ocean", title: "Ocean currents and climate variability model" }] });
  const res = await escalate(input({ storyType: "scientific_study", title: "Moderna Merck melanoma mRNA vaccine trial results" }), d);
  assert.equal(res.status, "no_upgrade_found");
  assert.equal(res.selected_editorial_source.domain, "smallblog.co");
});

test("study → journal preferred over major media", async () => {
  const d = deps({ webSearch: async () => [
    { url: "https://bbc.com/skin-cancer", title: "Skin cancer vaccine melanoma Moderna news" },
    { url: "https://nature.com/mel-vax", title: "Personalized mRNA melanoma vaccine Moderna Merck trial" },
  ] });
  const res = await escalate(input({ storyType: "scientific_study", title: "Moderna Merck melanoma mRNA vaccine trial" }), d);
  assert.equal(res.selected_editorial_source.domain, "nature.com"); // journal, not bbc secondary_media
});

test("regulator story → regulator preferred over wire", async () => {
  const d = deps({ webSearch: async () => [
    { url: "https://reuters.com/fda-approval", title: "FDA approves weekly insulin Britain drug" },
    { url: "https://www.fda.gov/insulin", title: "FDA weekly insulin approval Britain" },
  ] });
  const res = await escalate(input({ storyType: "regulatory_decision", title: "Britain weekly insulin approval" }), d);
  assert.equal(res.selected_editorial_source.role, "regulator");
});

test("multi-source: journal primary + independent wire kept as supporting context", async () => {
  const d = deps({ webSearch: async () => [
    { url: "https://nature.com/mel", title: "melanoma mRNA vaccine Moderna Merck trial results" },
    { url: "https://reuters.com/mel", title: "Moderna Merck melanoma vaccine trial Reuters" },
  ] });
  const res = await escalate(input({ storyType: "scientific_study", title: "Moderna Merck melanoma vaccine trial" }), d);
  assert.equal(res.selected_editorial_source.domain, "nature.com");
  assert.equal(res.supporting_url, "https://reuters.com/mel");
});

test("recall → regulator/official recall notice preferred", async () => {
  const d = deps({ webSearch: async () => [
    { url: "https://someaggregator.co/recall", title: "Clear Eyes drops recall contamination" },
    { url: "https://www.fda.gov/recall-clear-eyes", title: "FDA recall Clear Eyes eye drops contamination" },
  ] });
  const res = await escalate(input({ storyType: "product_safety_or_recall", title: "Clear Eyes eye drops recalled contamination" }), d);
  assert.equal(res.status, "upgraded");
  assert.equal(res.selected_editorial_source.role, "regulator");
});

test("no stronger source found → discovery preserved (never blocks)", async () => {
  const d = deps({ webSearch: async () => [{ url: "https://otherblog.co/z", title: "unrelated wellness tips article" }] });
  const res = await escalate(input({ storyType: "regulatory_decision", title: "regulator approves drug" }), d);
  assert.equal(res.status, "no_upgrade_found");
  assert.equal(res.selected_editorial_source.url, "https://smallblog.co/x");
});

test("escalation error → escalation_failed, discovery preserved (promotion stays safe)", async () => {
  const d = deps({ webSearch: async () => { throw new Error("search down"); } });
  const res = await escalate(input({ storyType: "regulatory_decision", title: "regulator approves drug" }), d);
  assert.equal(res.status, "escalation_failed");
  assert.equal(res.selected_editorial_source.domain, "smallblog.co");
});

test("repSufficient + sameDevelopment + buildQuery units", () => {
  assert.equal(repSufficient({ role: "journal", tier: 2 }, "scientific_study"), true);
  assert.equal(repSufficient({ role: "secondary_media", tier: 5 }, "scientific_study"), false);
  assert.equal(repSufficient({ role: "specialist_media", tier: 3 }, "scientific_study"), false); // not a target role
  assert.equal(sameDevelopment("FDA Moderna melanoma vaccine", ["Moderna melanoma vaccine trial", null]), true);
  assert.equal(sameDevelopment("Ocean climate model", ["Moderna melanoma vaccine"], 2), false);
  assert.ok(buildQuery("Britain weekly insulin", "regulatory_decision").includes("fda.gov"));
});
