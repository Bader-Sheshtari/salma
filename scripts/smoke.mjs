#!/usr/bin/env node
// Launch Hardening V1 — production smoke tests.
//
// Usage:  node scripts/smoke.mjs [baseUrl]
// Default baseUrl: https://salma-azure.vercel.app
//
// High-value routes only; read-only except one deliberately INVALID analytics
// POST (the endpoint must answer 204 and write nothing). Exits non-zero on
// the first hard failure so CI/cron can alert.

const BASE = (process.argv[2] ?? "https://salma-azure.vercel.app").replace(/\/$/, "");
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}: ${e.message}`);
  }
}

const get = (path, opts = {}) =>
  fetch(BASE + path, { redirect: "manual", headers: { "User-Agent": "salma-smoke" }, ...opts });

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

await check("homepage 200 + Arabic shell", async () => {
  const r = await get("/");
  expect(r.status === 200, `status ${r.status}`);
  const html = await r.text();
  expect(html.includes("سلمى"), "brand missing");
  expect((r.headers.get("content-security-policy") ?? "").includes("default-src 'self'"), "CSP missing");
  expect(r.headers.get("x-content-type-options") === "nosniff", "nosniff missing");
});

await check("an article page renders", async () => {
  const home = await (await get("/")).text();
  const m = home.match(/href="(\/article\/[^"]+)"/);
  expect(m, "no article link on homepage");
  const r = await get(m[1]);
  expect(r.status === 200, `status ${r.status}`);
  const html = await r.text();
  expect(html.includes("og:title") || html.includes("NewsArticle"), "article metadata missing");
});

await check("search page 200 + noindex", async () => {
  const r = await get("/search?q=%D8%A7%D9%84%D8%B5%D8%AD%D8%A9");
  expect(r.status === 200, `status ${r.status}`);
  const html = await r.text();
  expect(html.includes("noindex"), "search not noindex");
});

await check("a category page renders", async () => {
  const r = await get("/category/kuwait");
  expect(r.status === 200, `status ${r.status}`);
});

await check("privacy page renders", async () => {
  const r = await get("/privacy");
  expect(r.status === 200, `status ${r.status}`);
});

await check("unknown route returns 404", async () => {
  const r = await get("/definitely-not-a-page-xyz");
  expect(r.status === 404, `status ${r.status}`);
});

await check("unauthenticated admin redirects to login", async () => {
  const r = await get("/admin/analytics");
  expect(r.status === 307 || r.status === 302, `status ${r.status}`);
  expect((r.headers.get("location") ?? "").includes("/admin/login"), "not redirected to login");
});

await check("analytics endpoint fails safely (invalid payload → 204, no error)", async () => {
  const r = await fetch(BASE + "/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "salma-smoke" },
    body: "{}",
  });
  expect(r.status === 204, `status ${r.status}`);
});

await check("sitemap + robots respond", async () => {
  const s = await get("/sitemap.xml");
  expect(s.status === 200, `sitemap ${s.status}`);
  const b = await get("/robots.txt");
  expect(b.status === 200, `robots ${b.status}`);
});

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed against ${BASE}`);
  process.exit(1);
}
console.log(`\nall smoke checks passed against ${BASE}`);
