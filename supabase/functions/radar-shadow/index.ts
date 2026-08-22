import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Fast News Radar — SHADOW MODE v1 (observation-only).
//
// This function ONLY observes how Event Registry / NewsAPI.ai surfaces
// healthcare articles over time and records minimal metadata into three
// isolated radar_shadow_* tables. It deliberately does NOT:
//   - call the Writer, Editorial Director, or Fidelity repair
//   - insert into content, ingestion_runs, or news_sources
//   - publish anything
//   - touch the existing ingestion pipeline in any way
//
// It reuses the tested Event Registry logic from eventregistry-preflight:
// a single billable getArticlesForTopicPage call bracketed by two free
// /usage info calls, with a broad global multilingual healthcare topicPage.

const ER_HOST = "https://eventregistry.org";

// Small overlap subtracted from the checkpoint so nothing slips between runs;
// the unique index on (provider, provider_uri) absorbs the re-fetched overlap.
const OVERLAP_MS = 5 * 60 * 1000; // 5min

// Articles are ALWAYS stored under this provider (dedup + downstream ranking/ESL
// treat every profile's rows uniformly); only the polling CHECKPOINT is per-profile.
const PROVIDER = "eventregistry";

// ---- Discovery profiles --------------------------------------------------
// Two bounded intake profiles share this one function/table/pipeline:
//   • "medical" (default): the original breaking-health topic page, 72h freshness,
//     run every 2h. UNCHANGED.
//   • "healthy_life" (V1.1): deliberately discovers credible Healthy-Life /
//     Quality-of-Life material (sleep, activity, nutrition, prevention, wellbeing…).
//     Because such stories are not urgent, it uses a LONGER freshness window
//     (~14 days) and its OWN checkpoint, and is scheduled a few times a day. It
//     does NOT lower any editorial standard — the ESL evidence gate + source-tier
//     scoring still decide what is eligible; this only improves the SUPPLY.
// Concepts are canonical English Wikipedia URIs (ER maps them language-agnostically,
// so non-English lifestyle articles surface and cross-language canonical merging
// in the ESL collapses duplicates).

const c = (uri: string, wgt = 40) => ({ uri, wgt, required: false, excluded: false });

type Profile = {
  checkpointKey: string;      // radar_shadow_state row (per-profile polling cursor)
  freshnessHours: number;     // store articles no older than this
  firstRunLookbackMs: number; // lookback when no checkpoint exists yet
  topicPage: Record<string, unknown>;
};

const MEDICAL_TOPIC_PAGE = {
  autoAddArticles: true,
  articleHasDuplicate: "keepAll",
  articleHasEvent: "keepAll",
  articleIsDuplicate: "skipDuplicates",
  maxDaysBack: 7,
  articleTreshWgt: 0,
  eventTreshWgt: 0,
  concepts: [
    c("http://en.wikipedia.org/wiki/Health"),
    c("http://en.wikipedia.org/wiki/Medicine"),
    c("http://en.wikipedia.org/wiki/Public_health"),
    c("http://en.wikipedia.org/wiki/Outbreak"),
    c("http://en.wikipedia.org/wiki/Epidemic"),
    c("http://en.wikipedia.org/wiki/Vaccine"),
    c("http://en.wikipedia.org/wiki/Clinical_trial"),
    c("http://en.wikipedia.org/wiki/Medication"),
    c("http://en.wikipedia.org/wiki/Pharmaceutical_industry"),
    c("http://en.wikipedia.org/wiki/Biotechnology"),
    c("http://en.wikipedia.org/wiki/Medical_device"),
    c("http://en.wikipedia.org/wiki/Hospital"),
    c("http://en.wikipedia.org/wiki/Health_policy"),
    c("http://en.wikipedia.org/wiki/EHealth"),
    c("http://en.wikipedia.org/wiki/Artificial_intelligence_in_healthcare"),
    c("http://en.wikipedia.org/wiki/Food_and_Drug_Administration", 30),
    c("http://en.wikipedia.org/wiki/World_Health_Organization", 30),
  ],
  keywords: [],
  categories: [
    { uri: "news/Health", wgt: 30 },
    { uri: "news/Science", wgt: 10 },
  ],
  sources: [],
  sourceGroups: [],
  sourceLocations: [],
  locations: [],
  langs: [], // empty = ALL languages (global/multilingual)
  restrictToSetConcepts: false,
  restrictToSetCategories: false,
  restrictToSetSources: false,
  restrictToSetLocations: false,
  dataType: ["news"],
};

// Healthy-Life: health-anchored lifestyle concepts. Health anchors + a small
// article weight threshold keep it health-focused (not e.g. coffee-market news);
// the ESL evidence gate does the final quality control.
const HEALTHY_LIFE_TOPIC_PAGE = {
  autoAddArticles: true,
  articleHasDuplicate: "keepAll",
  articleHasEvent: "keepAll",
  articleIsDuplicate: "skipDuplicates",
  maxDaysBack: 14,
  articleTreshWgt: 12, // require some topical weight → less off-topic noise
  eventTreshWgt: 0,
  concepts: [
    // health anchors
    c("http://en.wikipedia.org/wiki/Preventive_healthcare", 45),
    c("http://en.wikipedia.org/wiki/Lifestyle_medicine", 45),
    c("http://en.wikipedia.org/wiki/Health_promotion", 40),
    // sleep
    c("http://en.wikipedia.org/wiki/Sleep", 40),
    c("http://en.wikipedia.org/wiki/Sleep_hygiene", 40),
    c("http://en.wikipedia.org/wiki/Insomnia", 30),
    // activity
    c("http://en.wikipedia.org/wiki/Exercise", 40),
    c("http://en.wikipedia.org/wiki/Walking", 35),
    c("http://en.wikipedia.org/wiki/Physical_activity", 40),
    c("http://en.wikipedia.org/wiki/Physical_fitness", 35),
    c("http://en.wikipedia.org/wiki/Sedentary_lifestyle", 40),
    // nutrition
    c("http://en.wikipedia.org/wiki/Nutrition", 40),
    c("http://en.wikipedia.org/wiki/Healthy_diet", 45),
    c("http://en.wikipedia.org/wiki/Mediterranean_diet", 35),
    c("http://en.wikipedia.org/wiki/Health_effects_of_coffee", 30),
    // aging / prevention / mind / everyday health
    c("http://en.wikipedia.org/wiki/Ageing", 30),
    c("http://en.wikipedia.org/wiki/Longevity", 30),
    c("http://en.wikipedia.org/wiki/Psychological_stress", 35),
    c("http://en.wikipedia.org/wiki/Well-being", 35),
    c("http://en.wikipedia.org/wiki/Mental_health", 35),
    c("http://en.wikipedia.org/wiki/Women%27s_health", 30),
    c("http://en.wikipedia.org/wiki/Men%27s_health", 30),
    c("http://en.wikipedia.org/wiki/Travel_medicine", 25),
  ],
  keywords: [],
  categories: [
    { uri: "news/Health", wgt: 30 },
    { uri: "news/Science", wgt: 15 },
  ],
  sources: [],
  sourceGroups: [],
  sourceLocations: [],
  locations: [],
  langs: [],
  restrictToSetConcepts: false,
  restrictToSetCategories: false,
  restrictToSetSources: false,
  restrictToSetLocations: false,
  dataType: ["news"],
};

const PROFILES: Record<string, Profile> = {
  medical: {
    checkpointKey: "eventregistry",
    freshnessHours: 72,
    firstRunLookbackMs: 6 * 60 * 60 * 1000, // 6h
    topicPage: MEDICAL_TOPIC_PAGE,
  },
  healthy_life: {
    checkpointKey: "eventregistry:healthy_life",
    freshnessHours: 14 * 24, // ~14 days — lifestyle is not urgent, but bounded
    firstRunLookbackMs: 10 * 24 * 60 * 60 * 1000, // 10d seed on first run
    topicPage: HEALTHY_LIFE_TOPIC_PAGE,
  },
};

async function erPost(path: string, body: Record<string, unknown>, apiKey: string) {
  const res = await fetch(ER_HOST + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, apiKey }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* leave as text */ }
  return { status: res.status, ok: res.ok, json };
}

// ISO-8601 UTC without milliseconds/Z suffix, as Event Registry's onlyAfterTm expects.
function toErTm(d: Date): string {
  return d.toISOString().slice(0, 19);
}

Deno.serve(async (req) => {
  // P0 security: internal collector spending real Event Registry quota — the
  // pg_cron wrapper authenticates with the same x-ingest-secret / INGEST_SECRET
  // pattern as ingest-news. The public anon key satisfies the gateway's
  // verify_jwt but never this check. Fails closed if the secret is unset.
  const ingestSecret = Deno.env.get("INGEST_SECRET") ?? "";
  if (!ingestSecret || req.headers.get("x-ingest-secret") !== ingestSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startedAt = new Date();
  const apiKey = Deno.env.get("EVENTREGISTRY_API_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!apiKey || !supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: "Missing EVENTREGISTRY_API_KEY or Supabase service env" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const trigger = req.method === "POST" ? "manual" : "manual";
  const supabase = createClient(supabaseUrl, serviceKey);

  // 0) Select the discovery profile (default 'medical' → unchanged behavior).
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const profileName = (body as { profile?: unknown }).profile === "healthy_life" ? "healthy_life" : "medical";
  const profile = PROFILES[profileName];
  const topicPage = profile.topicPage;

  // OBSERVABILITY (health monitoring): write a run-log row 'running' BEFORE any
  // work, tagged with the profile (medical | healthy_life). A crash leaves a
  // visible stale record (pipeline_health). Best-effort — run_id is nullable, so
  // even if this insert fails the collection still proceeds; the row is finalized
  // at both the success and failure exits below.
  let shadowRunId: string | null = null;
  try {
    const { data: runIns } = await supabase
      .from("radar_shadow_runs")
      .insert({ trigger, profile: profileName, status: "running", started_at: startedAt.toISOString() })
      .select("id").single();
    shadowRunId = (runIns?.id as string | null) ?? null;
  } catch { /* monitoring must not break collection */ }

  // 1) Read this profile's polling checkpoint (UTC). Advance only on success.
  const { data: stateRow } = await supabase
    .from("radar_shadow_state")
    .select("last_poll_tm")
    .eq("provider", profile.checkpointKey)
    .maybeSingle();

  const checkpointBefore: string | null = stateRow?.last_poll_tm ?? null;
  const lookbackFrom = checkpointBefore
    ? new Date(new Date(checkpointBefore).getTime() - OVERLAP_MS)
    : new Date(startedAt.getTime() - profile.firstRunLookbackMs);
  const onlyAfterTm = toErTm(lookbackFrom);

  let usageInfo: unknown = null;
  let returnedCount = 0;
  let insertedCount = 0;
  let duplicateCount = 0;
  let staleSkipped = 0;
  const languagesSet = new Set<string>();
  let errorMsg: string | null = null;
  let status = "success";

  try {
    // 2) Usage BEFORE (free info call) — captured for the report if available.
    const usageBefore = await erPost("/api/v1/usage", {}, apiKey);

    // 3) The single billable call: getArticlesForTopicPage with inline definition.
    const articleReq = {
      resultType: "articles",
      articlesCount: 100,
      articlesSortBy: "date",
      articleBodyLen: 0,
      includeArticleLocation: true,
      includeArticleEventUri: true,
      includeSourceLocation: true,
      includeSourceTitle: true,
      onlyAfterTm,
      topicPage: JSON.stringify(topicPage),
    };
    const artRes = await erPost("/api/v1/article/getArticlesForTopicPage", articleReq, apiKey);

    // 4) Usage AFTER (free info call).
    const usageAfter = await erPost("/api/v1/usage", {}, apiKey);
    usageInfo = { before: usageBefore.json ?? null, after: usageAfter.json ?? null };

    const artJson = (artRes.json ?? {}) as Record<string, unknown>;
    const articlesObj = (artJson.articles ?? {}) as Record<string, unknown>;
    const results: Record<string, unknown>[] = Array.isArray(articlesObj.results)
      ? (articlesObj.results as Record<string, unknown>[])
      : [];
    errorMsg = (artJson.error as string | null) ?? (articlesObj.error as string | null) ?? null;
    returnedCount = results.length;

    if (!artRes.ok || errorMsg) {
      status = "failure";
      if (!errorMsg) errorMsg = `provider HTTP ${artRes.status}`;
    } else {
      const freshnessCutoff = Date.now() - profile.freshnessHours * 60 * 60 * 1000;

      // Normalize + freshness-filter the returned set.
      type Norm = {
        provider_uri: string;
        event_uri: string | null;
        title: string | null;
        url: string | null;
        source_title: string | null;
        source_domain: string | null;
        language: string | null;
        country: string | null;
        published_at: string | null;
        provider_seen_at: string | null;
      };
      const fresh: Norm[] = [];
      for (const r of results) {
        const lang = r?.lang ?? null;
        if (lang) languagesSet.add(lang);

        const pubStr: string | null = r?.dateTimePub ?? r?.dateTime ?? null;
        const pubMs = pubStr ? Date.parse(pubStr) : NaN;
        if (!Number.isNaN(pubMs) && pubMs < freshnessCutoff) {
          staleSkipped++;
          continue;
        }
        const providerUri = r?.uri ? String(r.uri) : null;
        if (!providerUri) continue; // cannot dedupe without a stable id

        const country = r?.source?.location?.country?.label?.eng
          ?? r?.source?.location?.country?.label
          ?? r?.location?.country?.label?.eng
          ?? r?.location?.country?.label
          ?? null;

        fresh.push({
          provider_uri: providerUri,
          event_uri: r?.eventUri ? String(r.eventUri) : null,
          title: typeof r?.title === "string" ? r.title : (r?.title ?? null),
          url: r?.url ?? null,
          source_title: r?.source?.title ?? null,
          source_domain: r?.source?.uri ?? null,
          language: lang,
          country: typeof country === "string" ? country : null,
          published_at: pubStr,
          provider_seen_at: r?.dateTimeAdded ?? null,
        });
      }

      // Dedupe against already-stored provider articles.
      const candidateUris = [...new Set(fresh.map((f) => f.provider_uri))];
      let existing = new Set<string>();
      if (candidateUris.length > 0) {
        const { data: existingRows } = await supabase
          .from("radar_shadow_articles")
          .select("provider_uri")
          .eq("provider", PROVIDER)
          .in("provider_uri", candidateUris);
        existing = new Set((existingRows ?? []).map((e) => (e as { provider_uri: string }).provider_uri));
      }

      // Run row was created 'running' before work; reuse its id for articles.
      const runId: string | null = shadowRunId;

      const seenInBatch = new Set<string>();
      const toInsert = fresh
        .filter((f) => {
          if (existing.has(f.provider_uri) || seenInBatch.has(f.provider_uri)) {
            duplicateCount++;
            return false;
          }
          seenInBatch.add(f.provider_uri);
          return true;
        })
        .map((f) => ({ ...f, provider: PROVIDER, run_id: runId }));

      if (toInsert.length > 0) {
        const { error: insErr, count } = await supabase
          .from("radar_shadow_articles")
          .insert(toInsert, { count: "exact" });
        if (insErr) throw insErr;
        insertedCount = count ?? toInsert.length;
      }

      // Advance this profile's checkpoint only after a successful run.
      const checkpointAfter = startedAt.toISOString();
      await supabase.from("radar_shadow_state").upsert(
        { provider: profile.checkpointKey, last_poll_tm: checkpointAfter, updated_at: new Date().toISOString() },
        { onConflict: "provider" },
      );

      // Finalize the run row (best-effort; skip if the running-insert failed).
      if (runId) {
        await supabase.from("radar_shadow_runs").update({
          status: "success",
          finished_at: new Date().toISOString(),
          checkpoint_before: checkpointBefore,
          checkpoint_after: checkpointAfter,
          returned_count: returnedCount,
          inserted_count: insertedCount,
          duplicate_count: duplicateCount,
          stale_skipped_count: staleSkipped,
          languages: [...languagesSet],
          usage_info: usageInfo,
        }).eq("id", runId);
      }

      return new Response(JSON.stringify({
        ok: true,
        mode: "shadow",
        profile: profileName,
        run_id: runId,
        checkpoint_before: checkpointBefore,
        checkpoint_after: checkpointAfter,
        onlyAfterTm,
        returned: returnedCount,
        inserted: insertedCount,
        duplicates: duplicateCount,
        stale_skipped: staleSkipped,
        languages: [...languagesSet],
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }
  } catch (e) {
    status = "failure";
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  // Failure path: finalize the pre-created run row WITHOUT advancing the
  // checkpoint (best-effort; insert a fallback row if the running-insert failed).
  {
    const failPayload = {
      trigger,
      profile: profileName,
      status,
      finished_at: new Date().toISOString(),
      checkpoint_before: checkpointBefore,
      checkpoint_after: null,
      returned_count: returnedCount,
      inserted_count: insertedCount,
      duplicate_count: duplicateCount,
      stale_skipped_count: staleSkipped,
      languages: [...languagesSet],
      usage_info: usageInfo,
      error: errorMsg,
    };
    if (shadowRunId) await supabase.from("radar_shadow_runs").update(failPayload).eq("id", shadowRunId);
    else await supabase.from("radar_shadow_runs").insert({ ...failPayload, started_at: startedAt.toISOString() });
  }

  return new Response(JSON.stringify({
    ok: false,
    mode: "shadow",
    status,
    error: errorMsg,
    checkpoint_before: checkpointBefore,
    checkpoint_after: null,
    onlyAfterTm,
    returned: returnedCount,
  }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
});
