import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// GCC RADAR V1 — additive GCC healthcare-intelligence collector.
//
// Fetches REGISTERED GCC sources (gcc_sources: RSS where a real feed exists,
// otherwise tolerant listing-page link extraction) and inserts new items into
// the EXISTING radar_shadow_articles with provider='gcc'. radar-rank, ESL,
// retention, the inbox and Develop Story pick the rows up automatically —
// the audit confirmed nothing downstream filters by provider. Per-item GCC
// intelligence (topics / consequence signals / orgs / strategic flag /
// «لماذا يهم» / gcc_score) is 100% deterministic (gccIntel.ts) and goes into
// the radar_gcc_intel sidecar (ON DELETE CASCADE → retention stays correct).
//
// This function deliberately does NOT: call any LLM, touch news_sources,
// modify radar-rank/ESL/retention, or publish anything (brief §27, §29, §30).

import {
  validateFetchTarget,
  validateResolvedAddresses,
  MAX_REDIRECTS,
  type RawResponse,
} from "../ingest-news/fetchSourceText.ts";
import { denoRawFetch, denoResolveDns } from "../ingest-news/pipeline.ts";
import {
  classifyGccItem,
  detectLanguage,
  extractListingLinks,
  GCC_COUNTRY_LABELS,
  gccProviderUri,
  isHealthRelevant,
  parseFeedItems,
  type FeedItem,
  type GccCountryCode,
} from "./gccIntel.ts";

const PROVIDER = "gcc";
// Generous per-request timeout: GCC government sites (SharePoint-era) are slow
// from the edge region; the run budget still caps the whole pass.
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FEED_BYTES = 3_000_000;
const RUN_BUDGET_MS = 110_000;
const MAX_SOURCES_PER_RUN = intEnv("GCC_RADAR_MAX_SOURCES", 14);
const MAX_ITEMS_PER_SOURCE = 25;
const FIRST_RUN_UNDATED_CAP = 10;      // listing items carry no dates → bounded backfill
const BACKFILL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // brief §28: 14-day max
const COUNTRY_PRIORITY: Record<string, number> = { KW: 0, SA: 1, AE: 2, QA: 3, BH: 4, OM: 5 };

function intEnv(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

type GccSourceRow = {
  id: string;
  name: string;
  name_ar: string | null;
  domain: string;
  country_code: GccCountryCode;
  source_class: string;
  authority_tier: number;
  language: string;
  fetch_method: "rss" | "listing";
  fetch_url: string;
  include_pattern: string | null;
  healthcare_only: boolean;
  active: boolean;
  last_fetch_at: string | null;
  consecutive_failures: number;
};

type PerSourceStat = {
  domain: string;
  ok: boolean;
  returned: number;
  inserted: number;
  filtered: number;
  duplicates: number;
  backfill_skipped: number;
  error?: string;
};

// --- SSRF-safe raw GET (reuses the hardened ingest primitives; accepts
//     XML/HTML/text instead of fetchSourceText's HTML-only article path) -----

async function safeGet(url: string, registeredDomain: string): Promise<
  { ok: true; body: string } | { ok: false; error: string }
> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = validateFetchTarget(currentUrl, registeredDomain);
    if (!target.ok) return { ok: false, error: target.reason };
    const dns = await validateResolvedAddresses(target.url.hostname, denoResolveDns);
    if (!dns.ok) return { ok: false, error: dns.reason };

    let res: RawResponse;
    try {
      res = await denoRawFetch(target.url.href, {
        headers: {
          // Honest-but-browserlike UA: several GCC newsrooms return empty
          // shells to obvious bot UAs. No credentials of any kind are sent.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 SalmaGCC/1.0",
          "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5",
          "Accept-Language": "ar,en;q=0.8",
        },
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_FEED_BYTES,
      });
    } catch (e) {
      const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
      return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "fetch_failed" };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, error: `redirect_without_location_${res.status}` };
      try {
        currentUrl = new URL(location, target.url.href).href;
      } catch {
        return { ok: false, error: "bad_redirect" };
      }
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `http_${res.status}` };

    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct && !/xml|html|text\/plain|rss|atom/.test(ct)) {
      return { ok: false, error: `unsupported_content_type` };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > MAX_FEED_BYTES) return { ok: false, error: "body_too_large" };
        chunks.push(chunk);
      }
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    return { ok: true, body: new TextDecoder("utf-8", { fatal: false }).decode(merged) };
  }
  return { ok: false, error: "too_many_redirects" };
}

// --- Per-source collection ---------------------------------------------------

function sourceItems(source: GccSourceRow, body: string): FeedItem[] {
  if (source.fetch_method === "rss") return parseFeedItems(body, MAX_ITEMS_PER_SOURCE);
  return extractListingLinks({
    html: body,
    baseUrl: source.fetch_url,
    includePattern: source.include_pattern ?? "/news/",
    cap: MAX_ITEMS_PER_SOURCE,
  });
}

Deno.serve(async (req) => {
  // Same authorization model as radar-shadow: the gateway's verify_jwt admits
  // any project JWT, so the real gate is the internal cron secret.
  const ingestSecret = Deno.env.get("INGEST_SECRET") ?? "";
  if (!ingestSecret || req.headers.get("x-ingest-secret") !== ingestSecret) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const started = Date.now();
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: { limit?: unknown; domains?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is the cron default
  }
  const limitRaw = Number(body.limit);
  const sourceCap = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), MAX_SOURCES_PER_RUN)
    : MAX_SOURCES_PER_RUN;
  const onlyDomains = Array.isArray(body.domains)
    ? body.domains.filter((d): d is string => typeof d === "string")
    : null;

  const { data: runRow, error: runErr } = await admin
    .from("gcc_radar_runs")
    .insert({ status: "running" })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return new Response(JSON.stringify({ error: "run_insert_failed" }), { status: 500 });
  }
  const runId = runRow.id as string;

  const totals = {
    returned: 0,
    inserted: 0,
    duplicates: 0,
    filtered: 0,
    backfillSkipped: 0,
  };
  const perSource: PerSourceStat[] = [];

  try {
    const { data: sources, error: srcErr } = await admin
      .from("gcc_sources")
      .select(
        "id,name,name_ar,domain,country_code,source_class,authority_tier,language,fetch_method,fetch_url,include_pattern,healthcare_only,active,last_fetch_at,consecutive_failures",
      )
      .eq("active", true);
    if (srcErr) throw new Error(`sources_load_failed: ${srcErr.message}`);

    // STALE-FIRST, with country priority (Kuwait first — brief §22) only as the
    // tiebreaker. Staleness must dominate: with a per-run source cap, a country
    // ordering as the primary key would let the first two countries' sources
    // permanently fill the cap and starve the rest of the registry.
    const queue = ((sources ?? []) as GccSourceRow[])
      .filter((s) => !onlyDomains || onlyDomains.includes(s.domain))
      .sort((a, b) => {
        const fa = a.last_fetch_at ? Date.parse(a.last_fetch_at) : 0;
        const fb = b.last_fetch_at ? Date.parse(b.last_fetch_at) : 0;
        if (fa !== fb) return fa - fb;
        const ca = COUNTRY_PRIORITY[a.country_code] ?? 9;
        const cb = COUNTRY_PRIORITY[b.country_code] ?? 9;
        return ca - cb;
      })
      .slice(0, sourceCap);

    for (const source of queue) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      const stat: PerSourceStat = {
        domain: source.domain,
        ok: false,
        returned: 0,
        inserted: 0,
        filtered: 0,
        duplicates: 0,
        backfill_skipped: 0,
      };
      perSource.push(stat);
      const firstRun = !source.last_fetch_at;
      const nowIso = new Date().toISOString();

      const fetched = await safeGet(source.fetch_url, source.domain);
      if (!fetched.ok) {
        stat.error = fetched.error;
        await admin.from("gcc_sources").update({
          last_fetch_at: nowIso,
          last_fetch_ok: false,
          last_error: fetched.error,
          consecutive_failures: (source.consecutive_failures ?? 0) + 1,
        }).eq("id", source.id);
        continue;
      }

      let items = sourceItems(source, fetched.body);
      stat.returned = items.length;
      totals.returned += items.length;

      // Healthcare gate for general-interest sources (brief §26).
      if (!source.healthcare_only) {
        const kept = items.filter((it) => isHealthRelevant(it.title));
        stat.filtered = items.length - kept.length;
        totals.filtered += stat.filtered;
        items = kept;
      }

      // Backfill guard (§28): never store items older than 14 days; undated
      // listing items are capped hard on a source's FIRST run.
      const cutoff = Date.now() - BACKFILL_WINDOW_MS;
      const dated = items.filter((it) => {
        if (!it.publishedAt) return true;
        const ok = Date.parse(it.publishedAt) >= cutoff;
        if (!ok) {
          stat.backfill_skipped += 1;
          totals.backfillSkipped += 1;
        }
        return ok;
      });
      let candidates = dated;
      if (firstRun) {
        const undated = dated.filter((it) => !it.publishedAt);
        if (undated.length > FIRST_RUN_UNDATED_CAP) {
          const allowed = new Set(undated.slice(0, FIRST_RUN_UNDATED_CAP).map((it) => it.url));
          candidates = dated.filter((it) => it.publishedAt || allowed.has(it.url));
          const dropped = dated.length - candidates.length;
          stat.backfill_skipped += dropped;
          totals.backfillSkipped += dropped;
        }
      }

      if (candidates.length > 0) {
        const uris = await Promise.all(candidates.map((it) => gccProviderUri(it.url)));
        const urls = candidates.map((it) => it.url);

        // Dedupe: our own provider ids + cross-provider URL check, so a story
        // Event Registry already surfaced is not stored twice.
        const [seenOwn, seenUrl] = await Promise.all([
          admin.from("radar_shadow_articles").select("provider_uri")
            .eq("provider", PROVIDER).in("provider_uri", uris),
          admin.from("radar_shadow_articles").select("url").in("url", urls),
        ]);
        const ownSet = new Set((seenOwn.data ?? []).map((r) => r.provider_uri as string));
        const urlSet = new Set((seenUrl.data ?? []).map((r) => r.url as string));

        for (let i = 0; i < candidates.length; i++) {
          const item = candidates[i];
          const uri = uris[i];
          if (ownSet.has(uri) || urlSet.has(item.url)) {
            stat.duplicates += 1;
            totals.duplicates += 1;
            continue;
          }
          ownSet.add(uri);
          urlSet.add(item.url);

          const language = detectLanguage(item.title);
          const { data: inserted, error: insErr } = await admin
            .from("radar_shadow_articles")
            .insert({
              provider: PROVIDER,
              provider_uri: uri,
              title: item.title,
              url: item.url,
              source_title: source.name_ar ?? source.name,
              source_domain: source.domain,
              language,
              country: GCC_COUNTRY_LABELS[source.country_code],
              published_at: item.publishedAt,
            })
            .select("id")
            .single();
          if (insErr || !inserted) {
            // Unique-index race with a concurrent run — count as duplicate.
            stat.duplicates += 1;
            totals.duplicates += 1;
            continue;
          }

          const intel = classifyGccItem({
            title: item.title,
            countryCode: source.country_code,
            authorityTier: source.authority_tier,
          });
          await admin.from("radar_gcc_intel").insert({
            radar_article_id: inserted.id,
            source_id: source.id,
            country_code: source.country_code,
            topics: intel.topics,
            signals: intel.signals,
            orgs: intel.orgs,
            authority_tier: source.authority_tier,
            strategic: intel.strategic,
            strategic_reasons: intel.strategicReasons,
            gcc_score: intel.score,
            why_ar: intel.whyAr,
          });
          stat.inserted += 1;
          totals.inserted += 1;
        }
      }

      stat.ok = true;
      const newestItemTs = candidates
        .map((it) => (it.publishedAt ? Date.parse(it.publishedAt) : NaN))
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => b - a)[0];
      await admin.from("gcc_sources").update({
        last_fetch_at: nowIso,
        last_fetch_ok: true,
        last_error: null,
        consecutive_failures: 0,
        ...(stat.inserted > 0 || Number.isFinite(newestItemTs)
          ? { last_item_at: Number.isFinite(newestItemTs) ? new Date(newestItemTs).toISOString() : nowIso }
          : {}),
      }).eq("id", source.id);
    }

    await admin.from("gcc_radar_runs").update({
      status: "success",
      finished_at: new Date().toISOString(),
      sources_attempted: perSource.length,
      sources_ok: perSource.filter((s) => s.ok).length,
      returned_count: totals.returned,
      inserted_count: totals.inserted,
      duplicate_count: totals.duplicates,
      filtered_count: totals.filtered,
      backfill_skipped: totals.backfillSkipped,
      per_source: perSource,
    }).eq("id", runId);

    return new Response(
      JSON.stringify({
        ok: true,
        run_id: runId,
        sources_attempted: perSource.length,
        sources_ok: perSource.filter((s) => s.ok).length,
        ...totals,
        per_source: perSource,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("gcc_radar_runs").update({
      status: "failure",
      finished_at: new Date().toISOString(),
      sources_attempted: perSource.length,
      sources_ok: perSource.filter((s) => s.ok).length,
      returned_count: totals.returned,
      inserted_count: totals.inserted,
      duplicate_count: totals.duplicates,
      filtered_count: totals.filtered,
      backfill_skipped: totals.backfillSkipped,
      per_source: perSource,
      error: message,
    }).eq("id", runId);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
