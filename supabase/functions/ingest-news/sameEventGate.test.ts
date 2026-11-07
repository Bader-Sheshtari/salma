// Same-event gate (owner mandate 2026-11-07): an escalated source may replace
// the selected story ONLY when confirmed to cover the SAME specific news
// event. These tests pin the gate's contract:
//   - the Wisconsin measles regression (incident of 2026-11-07): a stale CDC
//     wastewater-surveillance report must NOT replace an infant-death story;
//   - a legitimate OLDER primary document (e.g. the original study a fresh
//     story reports on) IS accepted — there is no age cutoff in code;
//   - different_event / unconfirmed / errors / unfetchable all preserve the
//     original story via the existing discovery_fallback path.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  parseSameEventVerdict,
  sameEventPrompt,
  sameDevelopment,
  type SameEventVerdict,
} from "./sourceEscalation.ts";
import { resolveAnalysisSource, type SameEventCheck } from "./pipeline.ts";
import type { EscalationResult } from "./sourceEscalation.ts";
import type { SourceFetchResult, SourceText } from "./fetchSourceText.ts";

// ---- fixtures ---------------------------------------------------------------

const DISCOVERY_URL = "https://www.wuwm.com/wisconsin-infant-dies-from-measles";
const CDC_URL = "https://www.cdc.gov/mmwr/volumes/75/wr/mm7527a1.htm";

const WISCONSIN_TITLES = {
  title: "After a Wisconsin infant dies from measles, health officials urge people to get vaccinated",
  titleAr: "بعد وفاة رضيع في ويسكونسن بسبب الحصبة، مسؤولو الصحة يحثون الناس على التطعيم",
};

const CDC_WASTEWATER: SourceText = {
  ok: true,
  title: "Genotype-Specific Detection of Measles Virus Using Wastewater Surveillance — Wisconsin, February 2026",
  text: "During February 2026, wastewater surveillance in Wisconsin detected measles virus genotype D8 before a case was identified…",
  method: "direct",
  publishedDate: "2026-07-16",
  charCount: 1200,
  wordCount: 200,
  finalUrl: CDC_URL,
  mustPreserve: [],
} as unknown as SourceText;

function upgraded(primaryUrl: string, supportingUrl: string | null = null): EscalationResult {
  return {
    status: "upgraded",
    method: "search",
    discovery_source: { url: DISCOVERY_URL, domain: "wuwm.com", role: "secondary_media", tier: 5 },
    selected_editorial_source: { url: primaryUrl, domain: "cdc.gov", role: "regulator", tier: 1 },
    supporting_url: supportingUrl,
    upgrade_reason: "stronger regulator via search (tier 1)",
  };
}

function fetchMap(map: Record<string, SourceText | null>): (url: string) => Promise<SourceFetchResult> {
  return (url) => {
    const hit = map[url];
    return Promise.resolve(hit ? hit : ({ ok: false, reason: "source_fetch_failed" } as SourceFetchResult));
  };
}

const always = (v: SameEventVerdict): SameEventCheck => () => Promise.resolve(v);

// ---- verdict parser -----------------------------------------------------------

Deno.test("parseSameEventVerdict: exact tokens, noise tolerance, strictness", () => {
  assertEquals(parseSameEventVerdict("SAME_EVENT"), "same_event");
  assertEquals(parseSameEventVerdict("  same_event\n"), "same_event");
  assertEquals(parseSameEventVerdict("Answer: DIFFERENT_EVENT"), "different_event");
  // Ambiguous/empty/prose answers are never accepted as confirmation.
  assertEquals(parseSameEventVerdict("SAME_EVENT or DIFFERENT_EVENT"), "unconfirmed");
  assertEquals(parseSameEventVerdict(""), "unconfirmed");
  assertEquals(parseSameEventVerdict(null), "unconfirmed");
  assertEquals(parseSameEventVerdict("probably the same story"), "unconfirmed");
});

Deno.test("sameEventPrompt: carries titles, dates and the dates-as-evidence rule (no cutoff)", () => {
  const p = sameEventPrompt({
    discoveryTitle: WISCONSIN_TITLES.title,
    discoveryTitleAr: WISCONSIN_TITLES.titleAr,
    candidateTitle: CDC_WASTEWATER.title,
    candidateExcerpt: CDC_WASTEWATER.text.slice(0, 600),
    candidatePublishedDate: CDC_WASTEWATER.publishedDate,
    nowIso: "2026-11-07",
  });
  assert(p.user.includes(WISCONSIN_TITLES.title));
  assert(p.user.includes(WISCONSIN_TITLES.titleAr));
  assert(p.user.includes("2026-07-16"));
  assert(p.user.includes("2026-11-07"));
  assert(p.system.includes("NOT enough"));
  assert(p.system.toLowerCase().includes("never as an age cutoff"));
  assert(p.system.includes("even if it was published earlier"));
});

// ---- the incident, pinned ----------------------------------------------------

Deno.test("regression (Wisconsin measles): weak token guard passes, gate must catch it", async () => {
  // Document WHY the gate exists: the deterministic guard sees wisconsin+measles
  // and calls this the same development — exactly the 2026-11-07 incident.
  assert(sameDevelopment(CDC_WASTEWATER.title, [WISCONSIN_TITLES.title, WISCONSIN_TITLES.titleAr]));
  // The gate rejects the substitution and preserves the selected story.
  const r = await resolveAnalysisSource(upgraded(CDC_URL), DISCOVERY_URL, always("different_event"), {
    fetch: fetchMap({ [CDC_URL]: CDC_WASTEWATER }),
  });
  assertEquals(r.kind, "discovery_fallback");
  assertEquals(r.url, DISCOVERY_URL);
  assertEquals(r.primaryUrl, CDC_URL); // provenance preserved, never silently dropped
  assertEquals(r.gate?.primary, "different_event");
});

Deno.test("legitimate older primary: same_event verdict accepts it — no age cutoff in code", async () => {
  // A 4-month-old original study that a fresh story is directly about.
  const OLD_STUDY = { ...CDC_WASTEWATER, publishedDate: "2026-07-01" } as SourceText;
  const r = await resolveAnalysisSource(upgraded(CDC_URL), DISCOVERY_URL, always("same_event"), {
    fetch: fetchMap({ [CDC_URL]: OLD_STUDY }),
  });
  assertEquals(r.kind, "primary");
  assertEquals(r.url, CDC_URL);
  assertEquals(r.gate?.primary, "same_event");
});

// ---- fail-safe contract --------------------------------------------------------

Deno.test("unconfirmed verdict preserves the selected story", async () => {
  const r = await resolveAnalysisSource(upgraded(CDC_URL), DISCOVERY_URL, always("unconfirmed"), {
    fetch: fetchMap({ [CDC_URL]: CDC_WASTEWATER }),
  });
  assertEquals(r.kind, "discovery_fallback");
  assertEquals(r.gate?.primary, "unconfirmed");
});

Deno.test("check that throws counts as unconfirmed — never accepts, never crashes", async () => {
  const throwing: SameEventCheck = () => Promise.reject(new Error("boom"));
  const r = await resolveAnalysisSource(upgraded(CDC_URL), DISCOVERY_URL, throwing, {
    fetch: fetchMap({ [CDC_URL]: CDC_WASTEWATER }),
  });
  assertEquals(r.kind, "discovery_fallback");
  assertEquals(r.gate?.primary, "unconfirmed");
});

Deno.test("unfetchable primary behaves as before (fallback), gate records it", async () => {
  const r = await resolveAnalysisSource(upgraded(CDC_URL), DISCOVERY_URL, always("same_event"), {
    fetch: fetchMap({}),
  });
  assertEquals(r.kind, "discovery_fallback");
  assertEquals(r.gate?.primary, "unfetchable");
});

Deno.test("confirmed supporting source is used when the primary fails the gate", async () => {
  const WIRE_URL = "https://www.reuters.com/wisconsin-measles-infant-death";
  const WIRE: SourceText = { ...CDC_WASTEWATER, title: "Wisconsin reports infant death from measles", finalUrl: WIRE_URL } as SourceText;
  const perUrl: SameEventCheck = (fetched) =>
    Promise.resolve(fetched.finalUrl === WIRE_URL ? "same_event" : "different_event");
  const r = await resolveAnalysisSource(upgraded(CDC_URL, WIRE_URL), DISCOVERY_URL, perUrl, {
    fetch: fetchMap({ [CDC_URL]: CDC_WASTEWATER, [WIRE_URL]: WIRE }),
  });
  assertEquals(r.kind, "supporting");
  assertEquals(r.url, WIRE_URL);
  assertEquals(r.primaryUrl, CDC_URL);
  assertEquals(r.gate?.primary, "different_event");
  assertEquals(r.gate?.supporting, "same_event");
});

Deno.test("supporting that also fails the gate preserves the selected story", async () => {
  const WIRE_URL = "https://www.reuters.com/some-other-measles-roundup";
  const WIRE: SourceText = { ...CDC_WASTEWATER, title: "Measles roundup", finalUrl: WIRE_URL } as SourceText;
  const r = await resolveAnalysisSource(upgraded(CDC_URL, WIRE_URL), DISCOVERY_URL, always("different_event"), {
    fetch: fetchMap({ [CDC_URL]: CDC_WASTEWATER, [WIRE_URL]: WIRE }),
  });
  assertEquals(r.kind, "discovery_fallback");
  assertEquals(r.url, DISCOVERY_URL);
  assertEquals(r.gate?.supporting, "different_event");
});
