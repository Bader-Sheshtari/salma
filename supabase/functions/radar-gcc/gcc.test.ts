// GCC Radar V1 — deterministic intelligence tests.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildWhyAr,
  classifyGccItem,
  containsTerm,
  detectLanguage,
  detectOrgs,
  detectSignals,
  detectTopics,
  extractListingLinks,
  gccProviderUri,
  gccScore,
  isHealthRelevant,
  parseFeedItems,
  strategicFlag,
} from "./gccIntel.ts";

// --- Matching safety ---------------------------------------------------------

Deno.test("containsTerm: Arabic proclitics match, word-tails do not", () => {
  assert(containsTerm("أعلنت وزارة الصحة والتأمين الصحي الجديد", "تامين صحي"));
  assert(containsTerm("قرار بالترخيص للمستشفى", "ترخيص"));
  // عمان must NOT match عثمان, and وباء must not match from وباءت
  assert(!containsTerm("قال عثمان إن المشروع مستمر", "عمان"));
  assert(!containsTerm("woman wins award", "oman"));
  assert(!containsTerm("he said it clearly", "ai"));
});

Deno.test("detectLanguage: ISO-639-3 values matching radar conventions", () => {
  assertEquals(detectLanguage("وزارة الصحة تعتمد دواءً جديداً"), "ara");
  assertEquals(detectLanguage("SFDA approves new diabetes drug"), "eng");
});

// --- Healthcare gate ---------------------------------------------------------

Deno.test("health gate: keeps healthcare, drops generic business noise", () => {
  assert(isHealthRelevant("افتتاح مستشفى جديد في الجهراء"));
  assert(isHealthRelevant("Bupa Arabia reports higher health insurance claims"));
  // §31: unrelated business story must be excluded
  assert(!isHealthRelevant("ارتفاع أسعار النفط في الأسواق العالمية"));
  assert(!isHealthRelevant("Kuwait stock exchange index rises 2%"));
  // §26: crime/enforcement news is not healthcare even when it says "drug"
  assert(!isHealthRelevant("Six Suspects Arrested in Four Drug Cases; Marijuana seized"));
  assert(!isHealthRelevant("ضبط شبكة لتهريب المخدرات في المنفذ الحدودي"));
});

// --- Topics / signals / orgs -------------------------------------------------

Deno.test("topics: regulation + pharma detected bilingually", () => {
  const ar = detectTopics("الغذاء والدواء تعلن تسجيل دواء جديد لعلاج السكري");
  assert(ar.includes("regulation") || ar.includes("pharma"));
  const en = detectTopics("SFDA issues new licensing regulation for medical devices");
  assert(en.includes("regulation"));
  assert(en.includes("medtech"));
});

Deno.test("signals: strong signal ordered first", () => {
  const s = detectSignals("وزارة الصحة تعلن سحب دواء من الأسواق");
  assert(s.length > 0);
  assertEquals(s[0], "recall_or_suspension");
});

Deno.test("orgs: canonical bilingual detection without false positives", () => {
  assert(detectOrgs("بوبا العربية تطلق منتجاً جديداً").includes("bupa_arabia"));
  assert(detectOrgs("PureHealth completes acquisition of UK hospital group").includes("purehealth"));
  assertEquals(detectOrgs("اجتماع عادي لمجلس الوزراء"), []);
});

// --- Scoring + strategic -----------------------------------------------------

Deno.test("§31: regulatory change ranks high even from low-traffic official source", () => {
  const c = classifyGccItem({
    title: "الغذاء والدواء السعودية تصدر تعميماً إلزامياً بسحب مستحضر صيدلاني",
    countryCode: "SA",
    authorityTier: 1,
  });
  assert(c.score >= 80, `expected >=80, got ${c.score}`);
  assert(c.strategic);
  assert(c.strategicReasons.includes("official_strong_action"));
});

Deno.test("§31: low-value aggregator story stays low", () => {
  const c = classifyGccItem({
    title: "نصائح عامة للعناية بالبشرة في الصيف لدى بعض العيادات",
    countryCode: "AE",
    authorityTier: 4,
  });
  assert(c.score <= 40, `expected <=40, got ${c.score}`);
  assert(!c.strategic);
});

Deno.test("strategic flag: media-reported acquisition in providers is consolidation", () => {
  const { strategic, reasons } = strategicFlag({
    authorityTier: 3,
    topics: ["hospitals", "investment"],
    signals: ["acquisition"],
  });
  assert(strategic);
  assert(reasons.includes("sector_consolidation"));
});

Deno.test("gccScore is capped at 100 and authority-sensitive", () => {
  const high = gccScore({ authorityTier: 1, topics: ["regulation"], signals: ["mandatory_directive"], orgs: ["sfda"] });
  const low = gccScore({ authorityTier: 4, topics: [], signals: [], orgs: [] });
  assert(high <= 100);
  assert(high > low);
});

// --- Why-it-matters ----------------------------------------------------------

Deno.test("buildWhyAr: strong official action names the actor and the market", () => {
  const why = buildWhyAr({
    countryCode: "KW",
    authorityTier: 1,
    topics: ["regulation"],
    signals: ["mandatory_directive"],
    orgs: ["moh_kw"],
  });
  assert(why.includes("وزارة الصحة الكويتية"));
  assert(why.includes("الكويت"));
  assert(why.includes("تعميم أو قرار مُلزم"));
});

// --- Parsers -----------------------------------------------------------------

Deno.test("parseFeedItems: RSS items with CDATA and entities", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[الهيئة تعتمد دواء &amp; لقاحاً جديداً]]></title>
      <link>https://www.sfda.gov.sa/ar/news/123</link>
      <pubDate>Mon, 06 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>No link item</title></item>
  </channel></rss>`;
  const items = parseFeedItems(xml);
  assertEquals(items.length, 1);
  assertEquals(items[0].url, "https://www.sfda.gov.sa/ar/news/123");
  assert(items[0].title.includes("&"));
  assert(items[0].publishedAt?.startsWith("2026-10-06"));
});

Deno.test("parseFeedItems: Atom entries with href links", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>SFDA approves device</title>
      <link rel="alternate" href="https://example.gov/news/1"/>
      <updated>2026-10-05T08:00:00Z</updated></entry></feed>`;
  const items = parseFeedItems(xml);
  assertEquals(items.length, 1);
  assertEquals(items[0].url, "https://example.gov/news/1");
});

Deno.test("extractListingLinks: same-domain pattern-matched anchors only", () => {
  const html = `
    <a href="/ar/Pages/NewsDetail.aspx?NewsId=30">وزارة الصحة تفتتح مركزاً صحياً جديداً في محافظة الأحمدي</a>
    <a href="/ar/Pages/Aboutus.aspx">من نحن</a>
    <a href="https://evil.example.com/Pages/NewsDetail.aspx?NewsId=31">خبر خارجي عن الوزارة بتفاصيل طويلة</a>
    <a href="/ar/Pages/NewsDetail.aspx?NewsId=30#frag">وزارة الصحة تفتتح مركزاً صحياً جديداً في محافظة الأحمدي</a>
  `;
  const items = extractListingLinks({
    html,
    baseUrl: "https://www.moh.gov.kw/ar/Pages/Media.aspx",
    includePattern: "NewsDetail\\.aspx",
  });
  assertEquals(items.length, 1);
  assert(items[0].url.endsWith("NewsId=30"));
  assert(items[0].title.includes("وزارة الصحة"));
});

Deno.test("extractListingLinks: junk titles are rejected", () => {
  const html = `
    <a href="/ar/Pages/NewsDetail.aspx?NewsId=1">\${formattedDate} \${title}</a>
    <a href="/ar/Pages/NewsDetail.aspx?NewsId=2">أخبار الوزارة محدد حالياً</a>
    <a href="/ar/Pages/NewsDetail.aspx?NewsId=3">Health &amp; Science</a>
    <a href="/ar/Pages/NewsDetail.aspx?NewsId=4">وزارة الصحة تطلق حملة تطعيم موسمية جديدة في جميع المراكز</a>
  `;
  const items = extractListingLinks({
    html,
    baseUrl: "https://www.moh.gov.kw/ar/Pages/Media.aspx",
    includePattern: "NewsDetail\\.aspx",
  });
  assertEquals(items.length, 1);
  assert(items[0].url.endsWith("NewsId=4"));
});

Deno.test("extractListingLinks: invalid pattern fails closed", () => {
  assertEquals(
    extractListingLinks({ html: "<a href='/x'>t</a>", baseUrl: "https://a.com", includePattern: "(" }),
    [],
  );
});

// --- Provider ids ------------------------------------------------------------

Deno.test("gccProviderUri: stable, namespaced, fragment-insensitive", async () => {
  const a = await gccProviderUri("https://x.com/news/1");
  const b = await gccProviderUri("https://x.com/news/1#section");
  const c = await gccProviderUri("https://x.com/news/2");
  assertEquals(a, b);
  assert(a !== c);
  assert(a.startsWith("gcc:"));
  assertEquals(a.length, "gcc:".length + 32);
});
