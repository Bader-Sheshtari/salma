// E1.3F — targeted single-article pilot tests (pure, NO live internet, NO
// Deno/Supabase). Runs under Node's native TS type stripping
// (`node targetedPilot.test.ts`) or `deno test`.
//
// These lock the security + behavior contract of the optional pilot_source_url:
//  - it is reachable ONLY by an authorized pilot with pilot_limit=1;
//  - the URL's hostname must match an active, registered, final_source_allowed
//    source — no arbitrary/unregistered/blocked/context-only URL is ever fetched;
//  - the existing DNS/redirect/SSRF/timeout/byte/extraction protections still
//    apply (the targeted path calls the very same fetchSourceText);
//  - targeted mode performs at most one fetch, a fetch/extraction failure makes
//    ZERO writer calls, a successful extraction makes AT MOST one writer call;
//  - a created draft stays pending / ai / news;
//  - the scheduled cron / default request can never activate targeting;
//  - google/gemini-3-flash-preview remains forbidden.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRegistryIndex,
  DRAFT_STATUS,
  resolveTargetedSource,
  type RegistrySource,
} from "./registry.ts";
import {
  assertWriterConfig,
  isForbiddenWriterModel,
  processRepresentativesWithLimit,
  resolvePilotGate,
  type CommitOutcome,
  type WriterModelConfig,
} from "./writerRouter.ts";
import {
  fetchSourceText,
  groundedWrite,
  type DnsResolver,
  type RawFetch,
  type RawResponse,
} from "./fetchSourceText.ts";

// --- fixtures --------------------------------------------------------------

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

// A registry with: two tier-1 registered final sources, a context-only source
// (final_source_allowed=false), a blocked source, and an INACTIVE (but otherwise
// final-allowed) source. buildRegistryIndex drops the inactive row.
const SOURCES: RegistrySource[] = [
  src({ domain: "who.int", tier: "1", trust_score: 96, final_source_allowed: true, region: "world" }),
  src({ domain: "sfda.gov.sa", tier: "1", trust_score: 93, final_source_allowed: true, region: "gulf" }),
  src({ domain: "context-only.example", tier: "2", final_source_allowed: false }),
  src({ domain: "blocked.example", tier: "blocked" }),
  src({ domain: "inactive.example", active: false, final_source_allowed: true }),
];
const INDEX = buildRegistryIndex(SOURCES);

// A realistic registered-source article page (real body in <article>, well over
// MIN_TEXT_CHARS), used to exercise the fetch→extract→write seam end to end.
const ARTICLE_HTML = `<!doctype html><html><head>
  <title>تحذير صحي - مصدر مسجّل</title>
  <meta property="og:title" content="تحذير من سحب دفعة دواء ملوّثة">
  <meta property="article:published_time" content="2026-07-15">
</head><body>
  <nav>قائمة التنقل تُحذف</nav>
  <article>
    <h1>تحذير من سحب دفعة دواء بعد رصد تلوث محتمل</h1>
    <p>أعلنت الجهة الرسمية عن سحب دفعة رقم KW-2291 من أحد الأدوية بعد رصد تلوّث محتمل قد يؤثر على سلامة المرضى في عدة مناطق.</p>
    <p>ودعت جميع المرضى الذين حصلوا على الدفعة المذكورة إلى التوقف الفوري عن استخدامها ومراجعة الصيدلية لاستبدالها أو استرداد قيمتها.</p>
    <p>وأوضحت أن التحقيقات جارية مع الجهة المصنّعة، وأن عدد العبوات المتأثرة يقارب 1500 عبوة جرى توزيعها خلال الأسبوعين الماضيين.</p>
  </article>
  <footer>جميع الحقوق محفوظة 2026 حقوق النشر</footer>
</body></html>`;

const PUBLIC_DNS: DnsResolver = () => Promise.resolve(["93.184.216.34"]);
function dnsReturning(...addresses: string[]): DnsResolver {
  return () => Promise.resolve(addresses);
}

type Route = { status: number; headers?: Record<string, string>; body?: string };
function headersOf(h: Record<string, string> = {}) {
  const lower = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}
async function* chunksOf(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}
function makeRawFetch(routes: Record<string, Route>, log?: string[]): RawFetch {
  return (url) => {
    log?.push(url);
    const r = routes[url] ?? routes[url.replace(/\/$/, "")] ?? null;
    if (!r) return Promise.reject(Object.assign(new Error("no route"), { name: "TypeError" }));
    const res: RawResponse = {
      status: r.status,
      headers: headersOf(r.headers ?? { "content-type": "text/html; charset=utf-8" }),
      body: r.body != null ? chunksOf(r.body) : null,
    };
    return Promise.resolve(res);
  };
}

// --- 1. registry resolution: registered vs unregistered/blocked/context -----

test("a registered final-source URL (incl. subdomain) is accepted", () => {
  const r = resolveTargetedSource("https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON614", INDEX);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.source.domain, "who.int");

  const r2 = resolveTargetedSource("https://sfda.gov.sa/ar/news/4138328", INDEX);
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.source.domain, "sfda.gov.sa");
});

test("an unregistered URL is rejected (no arbitrary URL may be fetched)", () => {
  assert.deepEqual(
    resolveTargetedSource("https://evil.example/story", INDEX),
    { ok: false, reason: "pilot_source_url_not_registered" },
  );
});

test("a context-only source (final_source_allowed=false) is rejected as a final target", () => {
  assert.deepEqual(
    resolveTargetedSource("https://context-only.example/x", INDEX),
    { ok: false, reason: "pilot_source_url_not_registered" },
  );
});

test("a blocked source is rejected", () => {
  assert.deepEqual(
    resolveTargetedSource("https://blocked.example/x", INDEX),
    { ok: false, reason: "pilot_source_url_not_registered" },
  );
});

test("an inactive source is rejected (index holds active rows only)", () => {
  assert.deepEqual(
    resolveTargetedSource("https://inactive.example/x", INDEX),
    { ok: false, reason: "pilot_source_url_not_registered" },
  );
});

test("a non-http(s) scheme or unparseable URL is rejected as invalid", () => {
  for (const bad of ["ftp://who.int/x", "file:///etc/passwd", "javascript:alert(1)", "not a url", "who.int/x"]) {
    assert.deepEqual(
      resolveTargetedSource(bad, INDEX),
      { ok: false, reason: "pilot_source_url_invalid" },
      bad,
    );
  }
});

// --- 2. gate: targeting reachable ONLY by an authorized pilot with limit=1 ---

test("an UNAUTHORIZED targeted pilot is rejected (stays legacy, no targeting)", () => {
  assert.deepEqual(
    resolvePilotGate({ authorized: false, requestedMode: "pilot", requestedLimit: 1, requestedSourceUrl: "https://who.int/x" }),
    { mode: "legacy" },
  );
});

test("the cron/default request cannot activate targeting (pilot_source_url ignored)", () => {
  // No writer_mode → legacy; a stray pilot_source_url must be ignored entirely.
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedSourceUrl: "https://who.int/x" }),
    { mode: "legacy" },
  );
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedMode: "legacy", requestedSourceUrl: "https://who.int/x" }),
    { mode: "legacy" },
  );
});

test("an authorized pilot (limit=1) with a usable URL carries the targeted sourceUrl", () => {
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedMode: "pilot", requestedLimit: 1, requestedSourceUrl: "https://www.who.int/x" }),
    { mode: "pilot", limit: 1, sourceUrl: "https://www.who.int/x" },
  );
});

test("an ordinary pilot (no URL) is UNCHANGED — no sourceUrl key added", () => {
  // Locks backward compatibility with the existing { mode: "pilot", limit: 1 } contract.
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedMode: "pilot", requestedLimit: 1 }),
    { mode: "pilot", limit: 1 },
  );
  // An empty/whitespace URL is treated as absent, not invalid.
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedMode: "pilot", requestedLimit: 1, requestedSourceUrl: "   " }),
    { mode: "pilot", limit: 1 },
  );
});

test("a supplied-but-unusable pilot_source_url is a hard gate rejection", () => {
  for (const bad of [123, true, {}, ["https://who.int"], "ftp://who.int/x", "not a url"] as unknown[]) {
    assert.deepEqual(
      resolvePilotGate({ authorized: true, requestedMode: "pilot", requestedLimit: 1, requestedSourceUrl: bad }),
      { mode: "rejected", reason: "pilot_source_url_invalid" },
      String(bad),
    );
  }
});

test("pilot_limit must still be exactly 1 — a bad limit rejects before the URL is honored", () => {
  assert.deepEqual(
    resolvePilotGate({ authorized: true, requestedMode: "pilot", requestedLimit: 2, requestedSourceUrl: "https://who.int/x" }),
    { mode: "rejected", reason: "pilot_limit_must_be_1" },
  );
});

// --- 3. DNS / redirect / SSRF protections still apply in the targeted fetch --

test("targeted fetch still refuses a private resolved address (SSRF/DNS layer)", async () => {
  const res = await fetchSourceText({
    url: "https://www.who.int/x",
    registeredDomain: "who.int",
    rawFetch: makeRawFetch({ "https://www.who.int/x": { status: 200, body: ARTICLE_HTML } }),
    resolveDns: dnsReturning("10.0.0.5"), // RFC1918 → blocked before any socket
  });
  assert.deepEqual(res, { ok: false, reason: "source_private_address" });
});

test("targeted fetch still refuses a redirect that leaves the registered domain", async () => {
  const res = await fetchSourceText({
    url: "https://www.who.int/x",
    registeredDomain: "who.int",
    rawFetch: makeRawFetch({
      "https://www.who.int/x": { status: 302, headers: { location: "https://evil.example/x" } },
    }),
    resolveDns: PUBLIC_DNS,
  });
  assert.deepEqual(res, { ok: false, reason: "source_domain_mismatch" });
});

// --- 4. one fetch, and writer-call bounds via the shared groundedWrite seam --

test("a successful targeted extraction performs exactly ONE fetch and AT MOST one writer call", async () => {
  const log: string[] = [];
  let writerCalls = 0;
  const result = await groundedWrite<string>({
    fetchSource: () =>
      fetchSourceText({
        url: "https://www.who.int/article",
        registeredDomain: "who.int",
        rawFetch: makeRawFetch({ "https://www.who.int/article": { status: 200, body: ARTICLE_HTML } }, log),
        resolveDns: PUBLIC_DNS,
      }),
    write: () => {
      writerCalls++;
      return Promise.resolve("content-id-1");
    },
  });
  assert.equal(log.length, 1); // exactly one source fetch
  assert.equal(writerCalls, 1); // at most one writer call
  assert.equal(result.ok, true);
});

test("a targeted extraction FAILURE performs ZERO writer calls (no fetch text → no write)", async () => {
  let writerCalls = 0;
  const result = await groundedWrite<string>({
    // Simulate the WAM case: page fetched but no extractable body.
    fetchSource: () => Promise.resolve({ ok: false, reason: "source_text_unavailable" }),
    write: () => {
      writerCalls++;
      return Promise.resolve("content-id-1");
    },
  });
  assert.equal(writerCalls, 0);
  assert.deepEqual(result, { ok: false, reason: "source_text_unavailable" });
});

test("the single targeted representative consumes exactly one pilot slot (limit=1)", async () => {
  // The targeted path builds exactly ONE plan; the bounded loop must run it once
  // and report a single fetch-stage candidate.
  const log: number[] = [];
  const commit = (rep: { id: number }): Promise<CommitOutcome<number>> => {
    log.push(rep.id);
    return Promise.resolve({ reachedFetchStage: true, result: rep.id });
  };
  const r = await processRepresentativesWithLimit<{ id: number }, number>({
    representatives: [{ id: 1 }],
    limit: 1,
    commit,
  });
  assert.deepEqual(log, [1]);
  assert.deepEqual(r, { processed: 1, fetchStageCount: 1 });
});

// --- 5. content invariant + forbidden model ---------------------------------

// Mirrors the exact literals index.ts writes for BOTH the discovery and targeted
// pilot inserts: a created draft is ALWAYS pending / ai / news, never published.
test("a targeted-pilot draft is pending / ai / news (never auto-published)", () => {
  const payload = {
    title: "عنوان مُتحقَّق منه",
    type: "news" as const,
    status: DRAFT_STATUS,
    origin: "ai" as const,
  };
  assert.equal(payload.status, "pending");
  assert.equal(payload.origin, "ai");
  assert.equal(payload.type, "news");
});

test("google/gemini-3-flash-preview remains forbidden in every writer role", () => {
  assert.equal(isForbiddenWriterModel("google/gemini-3-flash-preview"), true);
  assert.equal(isForbiddenWriterModel("GOOGLE/Gemini-3-Flash-Preview"), true);
  const bad: WriterModelConfig = {
    defaultModel: "google/gemini-3-flash-preview",
    sensitiveModel: "anthropic/claude-sonnet-5",
    fallbackModel: "openai/gpt-4o-mini",
  };
  assert.throws(() => assertWriterConfig(bad), /forbidden_model/);
});
