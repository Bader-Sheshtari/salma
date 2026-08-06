// E1.3D — verified source-text extraction tests (pure, NO live internet).
// Every network call is a mocked RawFetch driven by in-memory HTML fixtures.
// Runs under Node's native TS type stripping (`node fetchSourceText.test.ts`)
// or `deno test`.

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyResolvedAddress,
  classifyContentType,
  extractArticle,
  extractEssentialEntities,
  looksLikeBatchIdentifier,
  fetchSourceText,
  groundedWrite,
  hostnameMatchesDomain,
  isBlockedHostname,
  validateFetchTarget,
  validateResolvedAddresses,
  type DnsResolver,
  type RawFetch,
  type RawResponse,
  type SourceFetchResult,
} from "./fetchSourceText.ts";

// A DNS resolver stub that returns only ordinary public addresses, so the
// existing fetch-orchestration tests exercise the HTTP/redirect/extraction paths
// without the E1.3E DNS layer ever rejecting. Tests that specifically exercise
// the DNS layer pass their own resolver. NO test ever touches live DNS.
const PUBLIC_DNS: DnsResolver = () => Promise.resolve(["93.184.216.34"]);
// Build a resolver that returns a fixed answer for every hostname.
function dnsReturning(...addresses: string[]): DnsResolver {
  return () => Promise.resolve(addresses);
}

// --- mock RawFetch helpers -------------------------------------------------

type Route = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  bytes?: number; // when set, stream this many bytes instead of `body`
  throwName?: string; // when set, reject with an error of this `name`
};

function headersOf(h: Record<string, string> = {}) {
  const lower = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

async function* chunksOf(text: string): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const size = 64 * 1024;
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function* chunksOfSize(total: number): AsyncGenerator<Uint8Array> {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(65); // "A"
  while (sent < total) {
    const remaining = total - sent;
    yield remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
    sent += chunk.length;
  }
}

// Records every requested URL so call-order / counts can be asserted.
function makeRawFetch(routes: Record<string, Route>, log?: string[]): RawFetch {
  return (url) => {
    log?.push(url);
    const r = routes[url] ?? routes[url.replace(/\/$/, "")] ?? null;
    if (!r) return Promise.reject(Object.assign(new Error("no route"), { name: "TypeError" }));
    if (r.throwName) return Promise.reject(Object.assign(new Error(r.throwName), { name: r.throwName }));
    const res: RawResponse = {
      status: r.status,
      headers: headersOf(r.headers ?? { "content-type": "text/html; charset=utf-8" }),
      body: r.bytes != null ? chunksOfSize(r.bytes) : (r.body != null ? chunksOf(r.body) : null),
    };
    return Promise.resolve(res);
  };
}

// A realistic article page: real body in <article>, surrounded by chrome/ads
// that MUST be stripped. Body is padded well over MIN_TEXT_CHARS.
const ARTICLE_HTML = `<!doctype html><html><head>
  <title>تحذير صحي مهم - مصدر موثوق</title>
  <meta property="og:title" content="تحذير من سحب دفعة دواء ملوّثة">
  <meta property="article:published_time" content="2026-07-15">
  <script>window.dataLayer=[{ secret: "should-not-appear" }];</script>
  <style>.ad{display:none}</style>
</head><body>
  <nav><a href="/">الرئيسية</a> قائمة التنقل يجب أن تُحذف</nav>
  <header>ترويسة الموقع تُحذف أيضاً</header>
  <div class="ad">إعلان ممول يجب حذفه من النص النهائي تماماً</div>
  <div class="cookie">نستخدم ملفات تعريف الارتباط، اضغط للموافقة على الكوكيز.</div>
  <article>
    <h1>تحذير من سحب دفعة دواء بعد رصد تلوث محتمل</h1>
    <p>أعلنت هيئة الغذاء والدواء في الكويت عن سحب دفعة رقم KW-2291 من أحد الأدوية بعد رصد تلوّث محتمل قد يؤثر على سلامة المرضى.</p>
    <p>ودعت الهيئة جميع المرضى الذين حصلوا على الدفعة المذكورة إلى التوقف الفوري عن استخدامها ومراجعة الصيدلية التي صرفت الدواء لاستبداله أو استرداد قيمته.</p>
    <p>وأوضحت أن التحقيقات جارية مع الجهة المصنّعة، وأن عدد العبوات المتأثرة يقارب 1500 عبوة جرى توزيعها خلال الأسبوعين الماضيين في عدة مناطق.</p>
    <p>وأكدت الهيئة أنها ستصدر تحديثاً رسمياً فور انتهاء الفحوص المخبرية، وأن على المرضى عدم القلق طالما التزموا بالتعليمات الرسمية.</p>
  </article>
  <aside>قصص ذات صلة: اقرأ أيضاً عشرة أطعمة صحية</aside>
  <footer>جميع الحقوق محفوظة 2026 حقوق النشر</footer>
</body></html>`;

// A page whose ONLY reliable body lives in JSON-LD articleBody.
const JSONLD_HTML = `<!doctype html><html><head>
  <title>دراسة جديدة</title>
  <script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "NewsArticle",
  "headline": "دراسة محكّمة تربط النوم الكافي بتحسّن المناعة",
  "datePublished": "2026-06-01",
  "articleBody":
    "خلص باحثون في دراسة محكّمة نُشرت في دورية علمية إلى وجود ارتباط بين انتظام النوم وتحسّن مؤشرات المناعة لدى المشاركين. " +
    "وشملت الدراسة عيّنة من 1200 مشارك جرت متابعتهم على مدى عام كامل ضمن تصميم رصدي دقيق. " +
    "وأوضح الباحثون أن النتائج أوّلية وأنها لا تثبت علاقة سببية مباشرة، داعين إلى مزيد من التجارب السريرية للتأكد. " +
    "وأشاروا إلى أن العوامل المؤثرة كثيرة وأن النوم وحده ليس السبب الوحيد لتحسّن المناعة لدى الفئة المدروسة.",
})}</script>
</head><body>
  <div id="app">يتطلب هذا الموقع تفعيل جافاسكربت لعرض المحتوى.</div>
</body></html>`;

// Boilerplate-only: every paragraph is chrome, so nothing editorial survives.
const BOILERPLATE_ONLY_HTML = `<!doctype html><html><head><title>x</title></head><body>
  <article>
    <p>نستخدم ملفات تعريف الارتباط. اضغط للموافقة على الكوكيز.</p>
    <p>اشترك في النشرة البريدية.</p>
    <p>اقرأ أيضاً: مقالات ذات صلة.</p>
  </article>
</body></html>`;

const DOMAIN = "example.com";
const URL_MAIN = `https://www.example.com/news/recall`;

// --- host / URL security ----------------------------------------------------

test("isBlockedHostname blocks loopback, private, link-local, metadata and internal", () => {
  for (const h of [
    "localhost", "app.localhost", "127.0.0.1", "10.0.0.5", "172.16.9.9", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "service.internal", "db.local", "[::1]", "::1",
  ]) {
    assert.ok(isBlockedHostname(h), `should block ${h}`);
  }
});

test("isBlockedHostname allows ordinary public hostnames", () => {
  for (const h of ["example.com", "www.who.int", "sub.moh.gov.kw", "8.example.org"]) {
    assert.ok(!isBlockedHostname(h), `should allow ${h}`);
  }
});

test("hostnameMatchesDomain accepts the domain and its subdomains only", () => {
  assert.ok(hostnameMatchesDomain("example.com", "example.com"));
  assert.ok(hostnameMatchesDomain("www.example.com", "example.com"));
  assert.ok(hostnameMatchesDomain("news.sub.example.com", "example.com"));
  assert.ok(!hostnameMatchesDomain("evil.com", "example.com"));
  assert.ok(!hostnameMatchesDomain("notexample.com", "example.com"));
  assert.ok(!hostnameMatchesDomain("example.com.evil.com", "example.com"));
});

test("validateFetchTarget rejects non-http, blocked hosts and off-domain hosts", () => {
  assert.equal(validateFetchTarget("ftp://example.com/x", DOMAIN).ok, false);
  assert.equal(validateFetchTarget("file:///etc/passwd", DOMAIN).ok, false);
  const priv = validateFetchTarget("http://169.254.169.254/latest/meta-data", DOMAIN);
  assert.deepEqual(priv, { ok: false, reason: "source_domain_mismatch" });
  const off = validateFetchTarget("https://evil.com/x", DOMAIN);
  assert.deepEqual(off, { ok: false, reason: "source_domain_mismatch" });
  const ok = validateFetchTarget("https://www.example.com/a", DOMAIN);
  assert.equal(ok.ok, true);
});

// --- content-type classification -------------------------------------------

test("classifyContentType accepts HTML, rejects PDF and other formats", () => {
  assert.deepEqual(classifyContentType("text/html; charset=utf-8"), { kind: "html" });
  assert.deepEqual(classifyContentType("application/xhtml+xml"), { kind: "html" });
  assert.deepEqual(classifyContentType("application/pdf"), { kind: "reject", reason: "source_pdf_not_supported" });
  assert.deepEqual(classifyContentType("application/json"), { kind: "reject", reason: "source_format_not_supported" });
  assert.deepEqual(classifyContentType("image/png"), { kind: "reject", reason: "source_format_not_supported" });
});

// --- HTML extraction (pure) ------------------------------------------------

test("article content is preferred and chrome/ads/cookie/related are removed", () => {
  const r = extractArticle(ARTICLE_HTML);
  assert.ok(r.ok);
  assert.equal(r.method, "article");
  // Real editorial sentences survive.
  assert.ok(r.text.includes("سحب دفعة رقم KW-2291") || r.text.includes("KW-2291"));
  assert.ok(r.text.includes("التوقف الفوري عن استخدامها"));
  // Chrome / ads / cookie / related / footer are gone.
  assert.ok(!r.text.includes("قائمة التنقل"));
  assert.ok(!r.text.includes("ترويسة الموقع"));
  assert.ok(!r.text.includes("إعلان ممول"));
  assert.ok(!r.text.includes("الكوكيز"));
  assert.ok(!r.text.includes("قصص ذات صلة"));
  assert.ok(!r.text.includes("حقوق النشر"));
  // Script/style content never leaks.
  assert.ok(!r.text.includes("should-not-appear"));
  assert.ok(!r.text.includes("dataLayer"));
});

test("JSON-LD articleBody is used when the DOM body is JS-gated", () => {
  const r = extractArticle(JSONLD_HTML);
  assert.ok(r.ok);
  assert.equal(r.method, "json-ld");
  assert.ok(r.text.includes("عيّنة من 1200 مشارك"));
  assert.equal(r.publishedDate, "2026-06-01");
  assert.ok(!r.text.includes("جافاسكربت")); // the JS-gate placeholder is not the body
});

test("boilerplate-only content is rejected, never surfaced", () => {
  const r = extractArticle(BOILERPLATE_ONLY_HTML);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason === "source_text_unavailable" || r.reason === "source_content_too_short");
});

test("a too-short editorial body is rejected as content_too_short", () => {
  const html = `<html><body><article><p>خبر قصير جداً لا يكفي.</p></article></body></html>`;
  const r = extractArticle(html);
  assert.deepEqual(r, { ok: false, reason: "source_content_too_short" });
});

// --- essential-entity extraction (deterministic) ---------------------------

test("essential entities come only from the source text (org present, batch, country, sample)", () => {
  const ents = extractEssentialEntities(
    "أعلنت هيئة الغذاء والدواء في الكويت سحب دفعة رقم KW-2291 وشملت المتابعة 1500 عبوة.",
    { sourceName: "هيئة الغذاء والدواء" },
  );
  assert.ok(ents.includes("هيئة الغذاء والدواء"));
  assert.ok(ents.includes("الكويت"));
  assert.ok(ents.includes("KW-2291"));
});

test("an org name absent from the source text is NOT added as an essential entity", () => {
  const ents = extractEssentialEntities("نص لا يذكر اسم الجهة إطلاقاً.", { sourceName: "منظمة الصحة العالمية" });
  assert.ok(!ents.includes("منظمة الصحة العالمية"));
});

test("a clearly-delimited medicine/product name is extracted (Arabic + English)", () => {
  const ar = extractEssentialEntities("أصدرت الجهة تحذيراً بشأن دواء «بانادول اكسترا» بعد رصد خلل.");
  assert.ok(ar.includes("بانادول اكسترا"));

  const en = extractEssentialEntities("FDA announces a recall of Metformin USP due to a possible impurity.");
  assert.ok(en.includes("Metformin"));
});

test("product-name extraction stays conservative — no free-form guessing", () => {
  // No drug/product keyword + quotes and no "recall of X" phrasing → nothing is
  // invented (a wrong product name is worse than none).
  const ents = extractEssentialEntities("أعلنت الجهة عن مستجدات صحية عامة دون تفاصيل عن أي منتج بعينه.");
  assert.deepEqual(ents, []);
});

// --- lot/batch identifier shape guard (false-positive regression) -----------
// FDA-style recall wording ("lot number displayed on the label") must never turn
// the ordinary verb after "lot/batch" into a mustPreserve essential entity.

test("'lot number displayed on the label' does not add 'displayed'", () => {
  const ents = extractEssentialEntities("FDA notes the product can be identified by the lot number displayed on the label.");
  assert.ok(!ents.includes("displayed"));
  assert.ok(!ents.some((e) => e.toLowerCase() === "displayed"));
});

test("'lot number printed on the carton' does not add 'printed'", () => {
  const ents = extractEssentialEntities("The lot number printed on the carton identifies the affected units.");
  assert.ok(!ents.some((e) => e.toLowerCase() === "printed"));
});

test("'batch number shown below' does not add 'shown'", () => {
  const ents = extractEssentialEntities("Consumers should check the batch number shown below on the packaging.");
  assert.ok(!ents.some((e) => e.toLowerCase() === "shown"));
});

test("other ordinary words after lot/batch wording are rejected", () => {
  for (const w of ["located", "found", "listed", "provided", "appearing"]) {
    const ents = extractEssentialEntities(`See the lot number ${w} on the label for details.`);
    assert.ok(!ents.some((e) => e.toLowerCase() === w), `unexpectedly kept "${w}"`);
  }
});

test("genuine lot/batch identifiers are still extracted", () => {
  assert.ok(extractEssentialEntities("Affected: lot number 25202 recalled.").includes("25202"));
  assert.ok(extractEssentialEntities("Affected: lot AB12C recalled.").includes("AB12C"));
  assert.ok(extractEssentialEntities("Affected: batch AB-123 recalled.").includes("AB-123"));
  assert.ok(extractEssentialEntities("Affected: lot 25A recalled.").includes("25A"));
  assert.ok(extractEssentialEntities("Affected: batch ABC123/4 recalled.").includes("ABC123/4"));
  // The Arabic-batch fixture identifier is unaffected.
  assert.ok(extractEssentialEntities("سحب دفعة رقم KW-2291 من الدواء.").includes("KW-2291"));
});

test("looksLikeBatchIdentifier accepts codes and rejects sentence words", () => {
  for (const ok of ["25202", "AB12C", "AB-123", "25A", "ABC123/4", "KW-2291", "AB", "XYZ"]) {
    assert.ok(looksLikeBatchIdentifier(ok), `should accept "${ok}"`);
  }
  for (const bad of ["displayed", "printed", "shown", "located", "found", "listed", "provided", "appearing"]) {
    assert.ok(!looksLikeBatchIdentifier(bad), `should reject "${bad}"`);
  }
});

test("genuine company/medicine/product entities remain unaffected by the guard", () => {
  // Org present in source + English product name via "recall of …" are untouched.
  const ents = extractEssentialEntities(
    "U.S. Food & Drug Administration announces a recall of Metformin USP due to a possible impurity in lot number displayed on the label.",
    { sourceName: "U.S. Food & Drug Administration" },
  );
  assert.ok(ents.includes("U.S. Food & Drug Administration"));
  assert.ok(ents.includes("Metformin"));
  assert.ok(!ents.some((e) => e.toLowerCase() === "displayed"));
  // Arabic quoted product name is unaffected.
  assert.ok(extractEssentialEntities("تحذير بشأن دواء «بانادول اكسترا».").includes("بانادول اكسترا"));
});

// --- fetch orchestration (mocked) ------------------------------------------

test("a valid registered-source article is fetched and extracted", async () => {
  const log: string[] = [];
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, body: ARTICLE_HTML } }, log);
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, sourceName: "هيئة الغذاء والدواء", rawFetch, resolveDns: PUBLIC_DNS });
  assert.ok(r.ok);
  assert.equal(r.method, "article");
  assert.ok(r.charCount > 250 && r.wordCount > 40);
  assert.ok(r.mustPreserve.includes("KW-2291"));
  assert.equal(log.length, 1); // exactly one HTTP request
});

test("a redirect to another domain is blocked (domain mismatch)", async () => {
  const rawFetch = makeRawFetch({
    [URL_MAIN]: { status: 302, headers: { location: "https://evil.com/steal" } },
  });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS });
  assert.deepEqual(r, { ok: false, reason: "source_domain_mismatch" });
});

test("a redirect within the same registered domain is followed and extracted", async () => {
  const finalUrl = "https://www.example.com/news/recall-final";
  const rawFetch = makeRawFetch({
    [URL_MAIN]: { status: 301, headers: { location: "/news/recall-final" } },
    [finalUrl]: { status: 200, body: ARTICLE_HTML },
  });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS });
  assert.ok(r.ok);
  assert.equal(r.finalUrl, finalUrl);
});

test("a redirect to a private/metadata IP is blocked", async () => {
  const rawFetch = makeRawFetch({
    [URL_MAIN]: { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } },
  });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS });
  assert.deepEqual(r, { ok: false, reason: "source_domain_mismatch" });
});

test("an initial private-IP URL is blocked before any body is read", async () => {
  const r = await fetchSourceText({
    url: "http://127.0.0.1:8080/admin",
    registeredDomain: "127.0.0.1",
    rawFetch: makeRawFetch({}),
    resolveDns: PUBLIC_DNS,
  });
  assert.deepEqual(r, { ok: false, reason: "source_domain_mismatch" });
});

test("an oversized response is stopped and rejected", async () => {
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, bytes: 5000 } });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS, maxBytes: 1000 });
  assert.deepEqual(r, { ok: false, reason: "source_fetch_failed" });
});

test("a timeout is surfaced as source_fetch_timeout", async () => {
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, throwName: "TimeoutError" } });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS });
  assert.deepEqual(r, { ok: false, reason: "source_fetch_timeout" });
});

test("a non-timeout network error is source_fetch_failed", async () => {
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, throwName: "TypeError" } });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS });
  assert.deepEqual(r, { ok: false, reason: "source_fetch_failed" });
});

test("a PDF content type is detected without OCR and rejected", async () => {
  const rawFetch = makeRawFetch({
    [URL_MAIN]: { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF-1.7 ..." },
  });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS });
  assert.deepEqual(r, { ok: false, reason: "source_pdf_not_supported" });
});

test("an unsupported content type is rejected", async () => {
  const rawFetch = makeRawFetch({
    [URL_MAIN]: { status: 200, headers: { "content-type": "application/json" }, body: "{}" },
  });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS });
  assert.deepEqual(r, { ok: false, reason: "source_format_not_supported" });
});

test("a redirect loop beyond the cap is rejected", async () => {
  const rawFetch = makeRawFetch({
    "https://www.example.com/a": { status: 302, headers: { location: "/b" } },
    "https://www.example.com/b": { status: 302, headers: { location: "/a" } },
  });
  const r = await fetchSourceText({ url: "https://www.example.com/a", registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS });
  assert.deepEqual(r, { ok: false, reason: "source_fetch_failed" });
});

// --- DNS-resolution SSRF layer (E1.3E, mocked resolver — never live DNS) ----

test("classifyResolvedAddress: loopback/RFC1918/link-local/CGNAT/ULA are private", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.12.9", "192.168.1.10", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(classifyResolvedAddress(ip), "private", ip);
  }
});

test("classifyResolvedAddress: unspecified/doc/benchmark/multicast are unsafe", () => {
  for (const ip of ["0.0.0.0", "192.0.2.5", "198.51.100.7", "203.0.113.9", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::", "ff02::1", "2001:db8::1", "not-an-ip"]) {
    assert.equal(classifyResolvedAddress(ip), "unsafe", ip);
  }
});

test("classifyResolvedAddress: ordinary public addresses are safe", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) {
    assert.equal(classifyResolvedAddress(ip), "safe", ip);
  }
});

test("classifyResolvedAddress: IPv4-mapped IPv6 is classified by the embedded IPv4", () => {
  assert.equal(classifyResolvedAddress("::ffff:127.0.0.1"), "private");
  assert.equal(classifyResolvedAddress("::ffff:169.254.169.254"), "private");
  assert.equal(classifyResolvedAddress("::ffff:93.184.216.34"), "safe");
});

test("validateResolvedAddresses: an empty answer fails closed", async () => {
  const r = await validateResolvedAddresses("host.example.com", dnsReturning());
  assert.deepEqual(r, { ok: false, reason: "source_dns_resolution_failed" });
});

test("validateResolvedAddresses: a throwing resolver fails closed", async () => {
  const r = await validateResolvedAddresses("host.example.com", () => Promise.reject(new Error("SERVFAIL")));
  assert.deepEqual(r, { ok: false, reason: "source_dns_resolution_failed" });
});

test("validateResolvedAddresses: a mixed public+private answer is blocked (private wins)", async () => {
  const r = await validateResolvedAddresses("rebind.example.com", dnsReturning("93.184.216.34", "10.0.0.5"));
  assert.deepEqual(r, { ok: false, reason: "source_private_address" });
});

test("validateResolvedAddresses: an all-public answer is allowed", async () => {
  const r = await validateResolvedAddresses("host.example.com", dnsReturning("93.184.216.34", "8.8.8.8"));
  assert.deepEqual(r, { ok: true });
});

test("fetchSourceText: an allowed host resolving to 127.0.0.1 is blocked (private_address)", async () => {
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, body: ARTICLE_HTML } });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: dnsReturning("127.0.0.1") });
  assert.deepEqual(r, { ok: false, reason: "source_private_address" });
});

test("fetchSourceText: allowed host resolving to 10.x/172.16.12/192.168/169.254/CGNAT is blocked", async () => {
  for (const ip of ["10.1.2.3", "172.16.12.4", "192.168.9.9", "169.254.169.254", "100.100.0.1"]) {
    const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, body: ARTICLE_HTML } });
    const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: dnsReturning(ip) });
    assert.deepEqual(r, { ok: false, reason: "source_private_address" }, ip);
  }
});

test("fetchSourceText: allowed host resolving to an unsafe IPv6 is blocked", async () => {
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, body: ARTICLE_HTML } });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: dnsReturning("ff02::1") });
  assert.deepEqual(r, { ok: false, reason: "source_unsafe_resolved_address" });
});

test("fetchSourceText: a DNS failure yields zero fetches and no source text", async () => {
  const log: string[] = [];
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, body: ARTICLE_HTML } }, log);
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: dnsReturning() });
  assert.deepEqual(r, { ok: false, reason: "source_dns_resolution_failed" });
  assert.equal(log.length, 0); // rejected before any socket was opened
});

test("fetchSourceText: a normal host resolving only to public addresses is allowed", async () => {
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, body: ARTICLE_HTML } });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: dnsReturning("93.184.216.34") });
  assert.ok(r.ok);
});

test("fetchSourceText: DNS is re-validated after a same-domain redirect", async () => {
  // The first hop resolves public; the redirect target (still on-domain) is what
  // rebinds to a private address. A per-hop DNS check catches it; a one-shot
  // check on only the initial URL would not. The resolver flips on the 2nd call.
  const finalUrl = "https://www.example.com/news/recall-final";
  const rawFetch = makeRawFetch({
    [URL_MAIN]: { status: 301, headers: { location: "/news/recall-final" } },
    [finalUrl]: { status: 200, body: ARTICLE_HTML },
  });
  let call = 0;
  const flipping: DnsResolver = () => Promise.resolve([call++ === 0 ? "93.184.216.34" : "10.0.0.7"]);
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: flipping });
  assert.deepEqual(r, { ok: false, reason: "source_private_address" });
});

test("fetchSourceText: a DNS failure means the writer is never reached", async () => {
  // groundedWrite over a DNS-failing fetch performs NO write (paid call).
  let writes = 0;
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, body: ARTICLE_HTML } });
  const out = await groundedWrite({
    fetchSource: () => fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: dnsReturning("10.0.0.1") }),
    write: () => { writes++; return Promise.resolve("wrote"); },
  });
  assert.deepEqual(out, { ok: false, reason: "source_private_address" });
  assert.equal(writes, 0);
});

// --- discovery-fabrication isolation ---------------------------------------

test("verified text contains only source material — a discovery fabrication cannot appear", async () => {
  const fabricated = "المشروب يسبب المرض وأصاب 4823 شخصاً"; // exists only in a hypothetical discovery draft
  const rawFetch = makeRawFetch({ [URL_MAIN]: { status: 200, body: ARTICLE_HTML } });
  const r = await fetchSourceText({ url: URL_MAIN, registeredDomain: DOMAIN, rawFetch, resolveDns: PUBLIC_DNS });
  assert.ok(r.ok);
  assert.ok(!r.text.includes("4823"));
  assert.ok(!r.text.includes("المشروب يسبب المرض"));
  assert.ok(!fabricated.split(" ").every((w) => r.text.includes(w)));
});

// --- groundedWrite sequencing ----------------------------------------------

test("groundedWrite performs exactly one fetch and one write on success", async () => {
  let writes = 0;
  const good: SourceFetchResult = {
    ok: true, title: "t", text: "x".repeat(300), method: "article", publishedDate: null,
    charCount: 300, wordCount: 1, finalUrl: URL_MAIN, mustPreserve: [],
  };
  const out = await groundedWrite({
    fetchSource: () => Promise.resolve(good),
    write: () => { writes++; return Promise.resolve("wrote"); },
  });
  assert.deepEqual(out, { ok: true, value: "wrote" });
  assert.equal(writes, 1);
});

test("groundedWrite performs NO write when source extraction fails", async () => {
  let writes = 0;
  const out = await groundedWrite({
    fetchSource: () => Promise.resolve({ ok: false, reason: "source_text_unavailable" }),
    write: () => { writes++; return Promise.resolve("wrote"); },
  });
  assert.deepEqual(out, { ok: false, reason: "source_text_unavailable" });
  assert.equal(writes, 0); // the writer (a paid call) never runs on a fetch failure
});
