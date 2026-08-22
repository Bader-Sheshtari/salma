// Editorial Selection Layer (ESL) — scheduled orchestrator.
//
// Purpose: turn Radar's large ranked pool (~hundreds/day) into a SMALL, balanced,
// high-value DAILY shortlist promoted to Content PENDING for human review. Radar
// discovers; ESL curates; humans approve/publish. NOTHING here auto-publishes.
//
// This function is STATEFUL across the day: it runs a few times daily and each
// run inspects what was already selected/promoted this editorial day (total, lane
// mix, GCC, topics, domains, clusters) and fills only the remaining capacity.
//
// Modes:
//   "shadow" — compute + record every selection/skip decision into the sidecar
//              (radar_editorial_selection, mode='shadow') WITHOUT creating any
//              Content. Used to validate the layer against real Radar data.
//   "live"   — additionally promote each selected candidate through the EXISTING
//              radar prepare pipeline (ingest-news → Writer → Editorial Director →
//              Fidelity), which creates a PENDING Content row. Never publishes.
//
// Determinism: all clustering, source selection, scoring, diversity and balancing
// live in ./esl-core.ts (pure, unit-tested). The ONLY LLM step here is a single
// bounded batched classification of cluster anchors, cached onto
// radar_shadow_articles.esl_* so re-runs are free and the selection math stays a
// transparent, tunable formula — never an LLM black box.
//
// Auth (P0 security fix 2026-08-21): requires the x-ingest-secret header matching
// the INGEST_SECRET function secret — the same internal server-to-server pattern
// ingest-news enforces. verify_jwt=true remains at the gateway, but the anon key
// alone is NOT sufficient. The run_esl() cron function sends both. Promotion
// calls ingest-news with the INGEST_SECRET (op:"esl_promote"), the same trusted
// server-to-server path the admin one-click publish uses — with the exact
// article URL/ids read from the trusted radar_shadow_articles row.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  clusterRows, bestSource, scoreCandidate, selectBalanced, resolveGcc,
  sourceTier, sourceRole, normalizeDomain, defaultLaneConfig, emptyDayState, isL5Eligible,
  candidateMergeGroups, dominantStoryType,
  type RadarRow, type RegistryEntry, type StoryType, type Lane, type DayState, type ScoredCandidate,
} from "./esl-core.ts";
import { isAuthorizedInternal, resolveCap } from "./authz.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Classification model — pinned like radar-rank (NOT the shared writer model).
const CLASSIFY_MODEL = Deno.env.get("ESL_CLASSIFY_MODEL") || "openai/gpt-4o-mini";

function intEnv(name: string, dflt: number): number {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}
// Daily promotion cap — the initial ramp. Configurable; NO auto-timed increase.
const DAILY_CAP = intEnv("ESL_DAILY_CAP", 8);
// How far back the candidate pool reaches (hours). ~30h covers overnight gaps.
const POOL_HOURS = intEnv("ESL_POOL_HOURS", 30);
// Ceiling on LLM classifications per run (bounds cost; leftovers wait a run).
const CLASSIFY_MAX = intEnv("ESL_CLASSIFY_MAX", 60);
// How many days back to treat a cluster as "already handled by us".
const HISTORY_DAYS = intEnv("ESL_HISTORY_DAYS", 3);
// V1.1: Healthy-Life / Quality-of-Life material is not urgent — lifestyle-flagged
// candidates get a LONGER (but bounded) freshness window than breaking medical
// news, so an excellent useful story isn't lost merely for being a few days old.
const L5_POOL_DAYS = intEnv("ESL_L5_POOL_DAYS", 14);
// Bounds for the two pools (see the union in the handler). Lifestyle is capped
// so the intake supply stays bounded and the pool never starves it.
const BREAKING_POOL_MAX = intEnv("ESL_BREAKING_POOL_MAX", 600);
const LIFE_POOL_MAX = intEnv("ESL_LIFE_POOL_MAX", 250);
// Cap on headlines sent to the ONE canonical-merge LLM call (cost discipline;
// generic health tokens can make the ambiguous set large).
const MERGE_LLM_MAX = intEnv("ESL_MERGE_LLM_MAX", 45);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";

// ---- classification -------------------------------------------------------

type Classification = {
  lane: Lane;
  lane_confidence: number;
  story_type: StoryType;
  evidence_class: "research" | "guidance" | "none";
  gcc: boolean;
  usefulness: number; // 0..100
};

const VALID_LANES = new Set(["L1", "L2", "L3", "L4", "L5"]);
const VALID_STORY = new Set([
  "scientific_study", "regulatory_decision", "public_health", "corporate_business",
  "product_or_technology_announcement", "product_safety_or_recall", "product_claim",
  "guidance_explainer", "general",
]);

const CLASSIFY_SYSTEM = `You are Salma's editorial classifier. Salma is a serious Arabic health-news platform for Kuwait and the GCC, written for a broad, educated health-news reader (not a specialist journal audience). For each article (given by title + source), assign structured editorial attributes. Respond with ONLY a JSON array, one object per input in order, each:
{"i":<index>,"lane":"L1|L2|L3|L4|L5","lane_confidence":0..1,"story_type":"<one of the story types below>","evidence_class":"research|guidance|none","gcc":true|false,"usefulness":0..100}

LANES:
- L1 Medical/Clinical: diseases, treatments, drugs, trials, clinical guidelines, medical devices.
- L2 Public Health/Systems: outbreaks, vaccination, ministry/WHO policy, health systems, epidemiology.
- L3 Innovation/Tech: medical AI, biotech, digital health, research breakthroughs, new methods.
- L4 Health Economy/Business: pharma companies, M&A, funding, market/regulatory business, insurance.
- L5 Healthy Life/Quality-of-life: nutrition, sleep, exercise, mental wellbeing, prevention, everyday health.

STORY_TYPE = the true nature of the CLAIM (drives best-source selection). Choose the single most precise:
- "scientific_study": reports an ACTUAL study/trial/peer-reviewed finding with real results. NOT a company merely showcasing or promoting a technology.
- "regulatory_decision": an approval/authorization/ban/label change by a regulator (FDA, EMA, SFDA, ministry).
- "public_health": outbreaks, epidemiology, vaccination campaigns, ministry/WHO public-health action.
- "corporate_business": M&A, funding, earnings, market/company business news.
- "product_or_technology_announcement": a company announcing/showcasing/launching a product, device, or technology WITHOUT real study evidence (conferences, demos, press releases). If it is a company promoting its own tech, use THIS — not scientific_study.
- "product_safety_or_recall": a recall, safety alert, withdrawal, contamination, or adverse-event/safety action on a product.
- "product_claim": an efficacy/health claim about a specific product or intervention.
- "guidance_explainer": evidence-based guidance/explainer from a respected institution or authority.
- "general": credible health news not fitting the above.

evidence_class:
- "research": grounded in a real study, trial, or peer-reviewed/scientific finding.
- "guidance": evidence-based guidance/explainer from a respected institution or health authority.
- "none": neither — opinion, marketing, announcement, or unsupported. (A product/technology announcement with no study is "none", NOT "research".)

L5 QUALITY BAR (critical): serious Salma content only. If an item is a miracle cure, wellness-influencer hype, supplement marketing, weak/fad weight-loss, exaggerated longevity, sensational food-or-disease scare, or a weak observational "X causes Y" leap, set evidence_class:"none" AND usefulness:0. Do NOT lower the bar to fill space.

gcc (STRICT, content-based only): true ONLY when the SUBJECT of the story materially concerns Kuwait, Saudi Arabia, UAE, Qatar, Bahrain, Oman, a GCC institution/regulator, or a GCC healthcare system/company/population. NEVER infer GCC relevance from the language (Arabic), the publisher's location, a Gulf/Arabic domain, or a Gulf outlet merely republishing a global story. Example: "Ebola cases in the DR Congo" published by a Gulf Arabic outlet → gcc:false (the subject is Congo, not the GCC). A UK/US/global approval reported by an Arabic outlet → gcc:false. When in doubt → false.

usefulness (0..100) = EDITORIAL VALUE FOR A BROAD HEALTH-NEWS READER, distinct from raw scientific importance. Ask: "Would a normal educated Salma reader reasonably care about or benefit from understanding this?" Reward meaningful patient/public impact, practical relevance, understandable consequence, broad medical importance, and strong curiosity value. A highly technical, niche journal finding with no clear patient/public consequence should score LOWER even if scientifically legitimate; a genuinely important, understandable medical development scores higher. Hype/pseudoscience → 0. (This does not dumb down medicine — major technical breakthroughs still rate highly; it separates niche abstracts from broadly relevant health news.)`;

/** One bounded batched classification call. Returns a map id → classification for
 *  the anchors it could classify; anchors it couldn't stay unclassified (skipped
 *  this run). Never throws — a failure yields an empty map. */
async function classifyAnchors(anchors: RadarRow[]): Promise<Map<string, Classification>> {
  const out = new Map<string, Classification>();
  if (!anchors.length || !OPENROUTER_KEY) return out;
  const lines = anchors
    .map((r, i) => `${i}. ${String(r.title ?? "").slice(0, 240)} — [${r.source_domain ?? "?"}]`)
    .join("\n");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  let json: Record<string, unknown> | null = null;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: CLASSIFY_SYSTEM },
          { role: "user", content: `Classify these ${anchors.length} articles:\n${lines}` },
        ],
      }),
      signal: ctrl.signal,
    });
    json = await res.json();
  } catch {
    return out; // network / abort → nothing classified this run
  } finally {
    clearTimeout(timer);
  }
  const raw = String((json as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "");
  if (!raw) return out;
  let parsed: unknown;
  try {
    const s = raw.indexOf("["); const e = raw.lastIndexOf("]");
    parsed = JSON.parse(raw.slice(s, e + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    const o = (item ?? {}) as Record<string, unknown>;
    const idx = Number(o.i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= anchors.length) continue;
    const lane = String(o.lane ?? "").toUpperCase();
    const story = String(o.story_type ?? "general");
    if (!VALID_LANES.has(lane)) continue;
    const evidenceRaw = String(o.evidence_class ?? "none");
    const evidence = evidenceRaw === "research" || evidenceRaw === "guidance" ? evidenceRaw : "none";
    out.set(anchors[idx].id, {
      lane: lane as Lane,
      lane_confidence: clamp01(Number(o.lane_confidence)),
      story_type: (VALID_STORY.has(story) ? story : "general") as StoryType,
      evidence_class: evidence,
      gcc: o.gcc === true,
      usefulness: Math.max(0, Math.min(100, Math.round(Number(o.usefulness) || 0))),
    });
  }
  return out;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

/** Persist a classification onto the anchor row's esl_* cache (best-effort). */
async function cacheClassification(admin: SupabaseClient, id: string, c: Classification): Promise<void> {
  await admin.from("radar_shadow_articles").update({
    esl_lane: c.lane,
    esl_story_type: c.story_type,
    esl_evidence_class: c.evidence_class,
    esl_gcc: c.gcc,
    esl_usefulness: c.usefulness,
    esl_classified_at: new Date().toISOString(),
  }).eq("id", id);
}

// ---- cross-language canonical event merge ---------------------------------
// Time window within which two headlines may describe the same development.
const CANON_WINDOW_MS = intEnv("ESL_CANON_WINDOW_HOURS", 72) * 3_600_000;

const CANON_SYSTEM = `You are Salma's event de-duplicator. You are given health-news headlines (Arabic translation + original-language title) that a pre-filter flagged as POSSIBLY the same real-world development (they were published in the same window and share key terms). Decide which ones report the SAME CONCRETE DEVELOPMENT.

SAME development = same entities (companies/institutions/people) AND same medical subject AND the same specific event — e.g. the same trial result, the same regulatory approval, the same recall, the same outbreak update. Different-language reports of the same event ARE the same development (merge them). A market/stock reaction to that same event is still the same development.

DIFFERENT developments must NOT be merged even when they share a company or topic: a trial result vs a partnership vs quarterly earnings vs a different drug/indication are DIFFERENT. When unsure, keep them separate.

Respond with ONLY a JSON array [{"i":<index>,"dev":<integer>}], one object per input in order. Items that are the same development share the same dev integer; every distinct development gets its own integer.`;

/** Bounded LLM confirmation over the ambiguous candidate set. Returns rowId →
 *  dev-group integer. Never throws; empty map on failure (→ no merges). */
async function canonicalizeAmbiguous(groups: RadarRow[][]): Promise<Map<string, number>> {
  const flat = groups.flat().slice(0, MERGE_LLM_MAX); // cost cap on the single call
  const out = new Map<string, number>();
  if (flat.length < 2 || !OPENROUTER_KEY) return out;
  const lines = flat
    .map((r, i) => `${i}. [ar] ${String(r.title_ar ?? "").slice(0, 150)} | [orig] ${String(r.title ?? "").slice(0, 130)} | ${String(r.published_at ?? "").slice(0, 10)}`)
    .join("\n");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  let json: Record<string, unknown> | null = null;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: CANON_SYSTEM },
          { role: "user", content: `Group these ${flat.length} headlines by concrete development:\n${lines}` },
        ],
      }),
      signal: ctrl.signal,
    });
    json = await res.json();
  } catch {
    return out;
  } finally {
    clearTimeout(timer);
  }
  const raw = String((json as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "");
  if (!raw) return out;
  try {
    const s = raw.indexOf("["); const e = raw.lastIndexOf("]");
    const parsed = JSON.parse(raw.slice(s, e + 1));
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const o = (item ?? {}) as Record<string, unknown>;
        const idx = Number(o.i); const dev = Number(o.dev);
        if (Number.isInteger(idx) && idx >= 0 && idx < flat.length && Number.isFinite(dev)) {
          out.set(flat[idx].id, dev);
        }
      }
    }
  } catch { /* ignore → no merges */ }
  return out;
}

/** Stable canonical key for a merged development: the smallest provider_uri
 *  among its members (numeric where possible). Same members → same key. */
function canonKeyFor(members: RadarRow[]): string {
  let best: string | null = null;
  for (const m of members) {
    const u = String(m.provider_uri ?? "").trim();
    if (!u) continue;
    if (best === null) { best = u; continue; }
    const a = Number(u), b = Number(best);
    if (Number.isFinite(a) && Number.isFinite(b)) { if (a < b) best = u; }
    else if (u < best) best = u;
  }
  return `canon:${best ?? members[0]?.id ?? "x"}`;
}

// ---- promotion (live mode only) -------------------------------------------

type EscalationSummary = { status: string; method: string; editorial_domain: string | null; editorial_tier: number | null };
type PromoteResult = { ok: boolean; status: string; content_id: string | null; reason: string | null; escalation?: EscalationSummary | null };

/**
 * Promote one selected candidate through the EXISTING radar prepare pipeline.
 * Mirrors the admin one-click "تحرير في سلمى": latch the radar row to
 * 'processing' (CAS, only from a retryable state), then invoke ingest-news which
 * owns the terminal radar write and creates a PENDING Content row (prepare mode
 * never publishes). Returns the terminal outcome. Never throws.
 */
async function promote(admin: SupabaseClient, rep: RadarRow, categorySlug: string | null, clusterKey: string, storyType: string): Promise<PromoteResult> {
  if (!INGEST_SECRET) return { ok: false, status: "failed", content_id: null, reason: "no_ingest_secret" };
  if (!rep.url) return { ok: false, status: "failed", content_id: null, reason: "no_url" };

  // 1) Idempotency latch — only a genuinely retryable row (never attempted or a
  //    prior pre-Content failure) may start a run. 0 rows → someone/something
  //    already owns it; skip silently.
  const { data: latched, error: latchErr } = await admin
    .from("radar_shadow_articles")
    .update({ publish_status: "processing", publish_authorized_at: new Date().toISOString(), publish_error: null })
    .eq("id", rep.id)
    .or("publish_status.is.null,publish_status.eq.failed,and(publish_status.eq.needs_review,published_content_id.is.null)")
    .select("id");
  if (latchErr) return { ok: false, status: "failed", content_id: null, reason: "latch_error" };
  if (!latched || latched.length === 0) return { ok: false, status: "skipped", content_id: null, reason: "not_latchable" };

  // 2) Invoke ingest-news prepare pipeline (server-to-server, ingest secret).
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ingest-news`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ingest-secret": INGEST_SECRET },
      body: JSON.stringify({
        op: "esl_promote",
        writer_mode: "pilot",
        pilot_limit: 1,
        pilot_source_url: rep.url,
        radar_authorized_source: true,
        radar_article_id: rep.id,
        radar_publish_mode: "prepare", // create PENDING Content; never publish
        radar_category_slug: categorySlug ?? rep.expected_category_slug ?? null,
        radar_provider: rep.provider ?? null,
        radar_provider_uri: rep.provider_uri ?? null,
        radar_source_title: rep.source_title ?? null,
        radar_source_lang: rep.language ?? null,
        // Primary Source Escalation facts (used by ingest-news before the Writer).
        esl_cluster_key: clusterKey,
        esl_story_type: storyType,
        esl_title: rep.title ?? null,
        esl_title_ar: rep.title_ar ?? null,
      }),
    });
    const data = await res.json().catch(() => null) as
      | { ok?: boolean; radar_publish?: { status?: string; content_id?: string; reason?: string };
          source_escalation?: { status?: string; method?: string; selected_editorial_source?: { domain?: string; tier?: number } } | null }
      | null;
    if (!res.ok || !data || data.ok === false) {
      // ingest-news owns the terminal radar write; reconcile so we don't leave
      // the row stuck in 'processing' if the write never landed.
      await releaseIfStuck(admin, rep.id, "ingest_invoke_failed");
      return { ok: false, status: "failed", content_id: null, reason: "ingest_invoke_failed" };
    }
    const esc = data.source_escalation
      ? {
          status: String(data.source_escalation.status ?? ""),
          method: String(data.source_escalation.method ?? ""),
          editorial_domain: data.source_escalation.selected_editorial_source?.domain ?? null,
          editorial_tier: data.source_escalation.selected_editorial_source?.tier ?? null,
        }
      : null;
    const rp = data.radar_publish ?? null;
    // prepare mode success = a real PENDING Content row exists (status 'draft').
    if (rp && rp.status === "draft" && rp.content_id) {
      return { ok: true, status: "draft", content_id: rp.content_id, reason: null, escalation: esc };
    }
    // Any other outcome (failed / no content) — Writer/Fidelity did not produce a
    // clean Content row. Do NOT publish anything; record and move on.
    return { ok: false, status: rp?.status ?? "failed", content_id: rp?.content_id ?? null, reason: rp?.reason ?? "no_content" };
  } catch {
    await releaseIfStuck(admin, rep.id, "unexpected_error");
    return { ok: false, status: "failed", content_id: null, reason: "unexpected_error" };
  }
}

/** If the row is still 'processing' (ingest-news never wrote a terminal state),
 *  release it to retryable 'failed'. Best-effort. */
async function releaseIfStuck(admin: SupabaseClient, id: string, reason: string): Promise<void> {
  try {
    await admin.from("radar_shadow_articles")
      .update({ publish_status: "failed", publish_error: reason })
      .eq("id", id).eq("publish_status", "processing");
  } catch { /* ignore */ }
}

// ---- day state ------------------------------------------------------------

function editorialDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function daysAgoISODate(d: Date, days: number): string {
  return new Date(d.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

// ---- handler --------------------------------------------------------------

Deno.serve(async (req) => {
  // P0 security: internal function — require the cron secret before ANYTHING
  // else (mode/cap parsing included). The public anon key satisfies the
  // gateway's verify_jwt but never this check, so anon callers can neither
  // trigger runs nor reach live mode.
  if (!isAuthorizedInternal(req.headers.get("x-ingest-secret"), INGEST_SECRET)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return Response.json({ ok: false, error: "missing service env" }, { status: 500 });
  }
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const mode: "shadow" | "live" = (body as { mode?: unknown }).mode === "live" ? "live" : "shadow";
  // Caller cap may only LOWER the server-side daily cap (hard max = ESL_DAILY_CAP,
  // default 8) — see authz.ts resolveCap.
  const cap = resolveCap((body as { cap?: unknown }).cap, DAILY_CAP);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = new Date();
  const editorialDay = editorialDayOf(now);
  const runId = now.toISOString();
  const nowMs = now.getTime();

  // OBSERVABILITY (health monitoring): write a run-log row 'running' BEFORE any
  // work, so a crash mid-run leaves a visible stale record (pipeline_health
  // flags it). Best-effort: a monitoring-write failure must NEVER change ESL
  // behaviour (no auto-publish, no corrupted selection). Finalized below.
  let eslRunId: string | null = null;
  try {
    const { data: runIns } = await admin
      .from("radar_esl_runs")
      .insert({ job: "radar-editorial-select", mode, editorial_day: editorialDay, status: "running", cap, started_at: now.toISOString() })
      .select("id").single();
    eslRunId = (runIns?.id as string | null) ?? null;
  } catch { /* monitoring must not break the run */ }
  const finalizeEsl = async (status: string, f: Record<string, unknown>): Promise<void> => {
    if (!eslRunId) return;
    try {
      await admin.from("radar_esl_runs")
        .update({ status, finished_at: new Date().toISOString(), duration_ms: Date.now() - now.getTime(), ...f })
        .eq("id", eslRunId);
    } catch { /* monitoring must not break the run */ }
  };

  try {
  // --- 1) Day state: what THIS MODE already selected/promoted today ---------
  // MODE-ISOLATED: a shadow run reads prior SHADOW selections for the editorial
  // day (so the 3 daily shadow runs simulate live's stateful fill-remaining
  // behavior), a live run reads prior LIVE promotions. Shadow state can never
  // reduce live capacity and vice versa. Already-covered-by-Content protection is
  // handled separately (matched_content_id + the pool's publish_status filter),
  // so it stays correct regardless of mode.
  const { data: todayRows } = await admin
    .from("radar_editorial_selection")
    .select("lane,gcc,chosen_source_domain,cluster_key,promotion_status,selected")
    .eq("editorial_day", editorialDay).eq("mode", mode).eq("selected", true);
  const today = todayRows ?? [];

  const day: DayState = emptyDayState();
  let promotedToday = 0;
  for (const r of today) {
    const lane = String(r.lane ?? "");
    if (lane) day.laneCounts[lane] = (day.laneCounts[lane] ?? 0) + 1;
    const dom = normalizeDomain(r.chosen_source_domain as string | null);
    if (dom) day.domains.add(dom);
    if (r.gcc === true) day.gccCount++;
    const ck = String(r.cluster_key ?? "");
    if (ck.startsWith("t:")) day.topicSigs.add(ck.slice(2)); // carry topic dedup across runs
    day.totalSelected++;
    if (r.promotion_status === "promoted") promotedToday++;
  }
  const remainingCap = Math.max(0, cap - (mode === "live" ? promotedToday : day.totalSelected));

  // Clusters THIS MODE already selected recently (this + prior days) — never pick
  // the same event twice. Mode-isolated for the same reason as the day-state
  // above: shadow dedupes against shadow history, live against live history.
  const { data: recentRows } = await admin
    .from("radar_editorial_selection")
    .select("cluster_key")
    .gte("editorial_day", daysAgoISODate(now, HISTORY_DAYS))
    .eq("mode", mode)
    .eq("selected", true);
  const seenClusters = new Set<string>((recentRows ?? []).map((r) => String(r.cluster_key ?? "")).filter(Boolean));

  if (remainingCap <= 0) {
    // Healthy no-op: today's cap is already met. Record it as a clean run.
    await finalizeEsl("success", { remaining_cap: 0, pool_size: 0, clusters: 0, selected: 0, promoted: 0, promotion_failed: 0 });
    return Response.json({ ok: true, mode, editorial_day: editorialDay, run_id: runId, cap, remaining_cap: 0, note: "cap_reached_for_today", promoted_today: promotedToday });
  }

  // --- 2) Source registry ---------------------------------------------------
  const { data: regRows } = await admin
    .from("news_sources")
    .select("domain,source_type,tier,trust_score,active")
    .eq("active", true);
  const registry = new Map<string, RegistryEntry>();
  for (const r of regRows ?? []) {
    const d = normalizeDomain(r.domain as string);
    if (d) registry.set(d, { domain: d, source_type: String(r.source_type), tier: String(r.tier), trust_score: (r.trust_score as number) ?? null });
  }

  // --- 3) Candidate pool ----------------------------------------------------
  // Ranked, fresh, not yet handled by the publish pipeline, not already in Salma.
  // Important+ OR flagged lifestyle (cheap proxy to also catch credible L5 that
  // ranked Low). publish_status IS NULL excludes rows already promoted/failed —
  // which also means a failed candidate is not retried every run.
  // TWO bounded pools, unioned — because Healthy-Life material is far more
  // numerous but LOW priority, a single priority-ordered query (capped by the
  // server at 1000 rows) would starve it. So:
  //   • breaking pool: important+ within the SHORT window, priority-ordered;
  //   • lifestyle pool: lifestyle-flagged within the LONG (L5) window, FRESHEST
  //     first, bounded to a modest size (keeps intake supply bounded, not a
  //     firehose, and guarantees lifestyle is actually represented for the ESL).
  const POOL_FIELDS = "id,provider,provider_uri,event_uri,title,title_ar,url,source_title,source_domain,language,country,published_at,first_seen_at,priority_score,priority_level,expected_category_slug,duplicate_status,matched_content_id,esl_lane,esl_story_type,esl_evidence_class,esl_gcc,esl_usefulness,publish_status";
  const sinceBreakingISO = new Date(nowMs - POOL_HOURS * 3_600_000).toISOString();
  const sinceL5ISO = new Date(nowMs - L5_POOL_DAYS * 86_400_000).toISOString();
  const { data: breakingRows } = await admin
    .from("radar_shadow_articles")
    .select(POOL_FIELDS)
    .not("ranked_at", "is", null)
    .is("publish_status", null)
    .neq("duplicate_status", "already_in_salma")
    .in("priority_level", ["important", "very_important"])
    .gte("first_seen_at", sinceBreakingISO)
    .order("priority_score", { ascending: false, nullsFirst: false })
    .limit(BREAKING_POOL_MAX);
  const { data: lifeRows } = await admin
    .from("radar_shadow_articles")
    .select(POOL_FIELDS)
    .not("ranked_at", "is", null)
    .is("publish_status", null)
    .neq("duplicate_status", "already_in_salma")
    .eq("expected_category_slug", "lifestyle")
    .gte("first_seen_at", sinceL5ISO)
    .order("first_seen_at", { ascending: false })
    .limit(LIFE_POOL_MAX);
  // Union, de-duplicated by id (a row can satisfy both).
  const seenPoolIds = new Set<string>();
  const poolRows: Record<string, unknown>[] = [];
  for (const r of [...(breakingRows ?? []), ...(lifeRows ?? [])]) {
    const id = String(r.id);
    if (!seenPoolIds.has(id)) { seenPoolIds.add(id); poolRows.push(r); }
  }

  const rows: RadarRow[] = poolRows
    .filter((r) => r.url)
    .map((r) => ({
      id: String(r.id),
      provider: (r.provider as string | null) ?? null,
      provider_uri: (r.provider_uri as string | null) ?? null,
      event_uri: (r.event_uri as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      title_ar: (r.title_ar as string | null) ?? null, // radar-rank fills a headline translation for many rows
      url: (r.url as string | null) ?? null,
      source_title: (r.source_title as string | null) ?? null,
      source_domain: (r.source_domain as string | null) ?? null,
      language: (r.language as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      published_at: (r.published_at as string | null) ?? null,
      first_seen_at: String(r.first_seen_at ?? new Date(nowMs).toISOString()),
      priority_score: (r.priority_score as number | null) ?? null,
      priority_level: (r.priority_level as string | null) ?? null,
      expected_category_slug: (r.expected_category_slug as string | null) ?? null,
      duplicate_status: (r.duplicate_status as string | null) ?? null,
      matched_content_id: (r.matched_content_id as string | null) ?? null,
      esl_lane: (r.esl_lane as string | null) ?? null,
      esl_story_type: (r.esl_story_type as string | null) ?? null,
      esl_evidence_class: (r.esl_evidence_class as string | null) ?? null,
      esl_gcc: (r.esl_gcc as boolean | null) ?? null,
      esl_usefulness: (r.esl_usefulness as number | null) ?? null,
    }));

  // --- 4) Cluster (deterministic) ------------------------------------------
  const clusters = clusterRows(rows);

  // Skip clusters we've already covered (our own history) or that an existing
  // Content row already covers (matched_content_id on any member).
  type Cluster = { key: string; members: RadarRow[]; anchor: RadarRow };
  const active: Cluster[] = [];
  const clusterSkips: { key: string; reason: string; rep: RadarRow }[] = [];
  for (const [key, members] of clusters) {
    if (seenClusters.has(key)) { clusterSkips.push({ key, reason: "already_covered", rep: members[0] }); continue; }
    if (members.some((m) => m.matched_content_id)) { clusterSkips.push({ key, reason: "already_covered", rep: members[0] }); continue; }
    // Provisional anchor = strongest-tier member (deterministic; freshest breaks
    // ties). This is the row we classify; the story-level attributes it yields are
    // source-independent and reused for whichever best-source rep we finally pick.
    const anchor = pickAnchor(members, registry);
    active.push({ key, members, anchor });
  }

  // --- 5) Classify anchors (bounded, cached) -------------------------------
  // Spend the LLM budget where it matters: most on the highest-priority news
  // (so the strongest stories are always classified first), but RESERVE a slice
  // for lifestyle-flagged Low candidates so credible L5 is never starved of
  // classification by a busy news day. Leftovers wait for the next run.
  const unclassified = active.filter((c) => !c.anchor.esl_lane);
  const isHigh = (r: RadarRow) => r.priority_level === "very_important" || r.priority_level === "important";
  const byPriority = (a: Cluster, b: Cluster) => (b.anchor.priority_score ?? 0) - (a.anchor.priority_score ?? 0);
  const byFresh = (a: Cluster, b: Cluster) =>
    (Date.parse(b.anchor.first_seen_at ?? "") || 0) - (Date.parse(a.anchor.first_seen_at ?? "") || 0);
  const highPool = unclassified.filter((c) => isHigh(c.anchor)).sort(byPriority);
  const lifePool = unclassified.filter((c) => !isHigh(c.anchor)).sort(byFresh); // lifestyle-Low proxy
  const lifeQuota = Math.min(lifePool.length, Math.round(CLASSIFY_MAX * 0.25));
  const highTake = Math.min(highPool.length, CLASSIFY_MAX - lifeQuota);
  const needClassify = [...highPool.slice(0, highTake), ...lifePool.slice(0, CLASSIFY_MAX - highTake)]
    .map((c) => c.anchor)
    .slice(0, CLASSIFY_MAX);
  if (needClassify.length) {
    const cls = await classifyAnchors(needClassify);
    for (const anchor of needClassify) {
      const c = cls.get(anchor.id);
      if (!c) continue;
      // GCC guard: gate the classifier's gcc flag on an actual in-headline GCC
      // subject signal (never language/publisher). Downgrade-only.
      const guarded = { ...c, gcc: resolveGcc(c.gcc, anchor.title_ar, anchor.title) };
      anchor.esl_lane = guarded.lane; anchor.esl_story_type = guarded.story_type; anchor.esl_evidence_class = guarded.evidence_class;
      anchor.esl_gcc = guarded.gcc; anchor.esl_usefulness = guarded.usefulness;
      await cacheClassification(admin, anchor.id, guarded);
    }
  }

  // --- 5b) Cross-language canonical event merge ----------------------------
  // Event Registry ids are language-scoped, so the same development appears under
  // different event_uris per language and never clusters. Merge it into ONE
  // candidate so it consumes ONE daily slot. Bounded + cached: a deterministic
  // pre-filter (shared Arabic-title tokens + time window) gathers only ambiguous
  // reps; a single LLM call confirms same-vs-different development; the decision
  // is cached on the rows (esl_canonical_key) so re-runs never re-pay for it.
  const classifiedActive = active.filter((c) => c.anchor.esl_lane);
  const preGroups = candidateMergeGroups(classifiedActive.map((c) => c.anchor), CANON_WINDOW_MS, 2);
  let canonMap = new Map<string, number>();
  let canonLLMItems = 0;
  if (preGroups.length && preGroups.some((g) => g.some((r) => !r.esl_canonical_key))) {
    canonMap = await canonicalizeAmbiguous(preGroups);
    canonLLMItems = Math.min(MERGE_LLM_MAX, preGroups.reduce((n, g) => n + g.length, 0));
  }
  const mergeKeyOf = (c: Cluster): string => {
    if (c.anchor.esl_canonical_key) return c.anchor.esl_canonical_key; // cached decision
    const dev = canonMap.get(c.anchor.id);
    return dev !== undefined ? `dev:${dev}` : c.key; // this run's LLM group, else stand-alone
  };
  const byMergeKey = new Map<string, Cluster[]>();
  for (const c of classifiedActive) {
    const k = mergeKeyOf(c);
    (byMergeKey.get(k) ?? byMergeKey.set(k, []).get(k)!).push(c);
  }
  // Unclassified clusters pass through untouched (they become 'unclassified' in step 6).
  const merged: Cluster[] = active.filter((c) => !c.anchor.esl_lane);
  let crossLangMerges = 0;
  let slotsPrevented = 0;
  for (const [mk, grp] of byMergeKey) {
    if (grp.length === 1) { merged.push(grp[0]); continue; }
    const members = grp.flatMap((g) => g.members);
    const canonKey = mk.startsWith("canon:") ? mk : canonKeyFor(members);
    const domStory = dominantStoryType(members); // keep the most substantive framing
    const donor = members
      .filter((m) => (m.esl_story_type as StoryType) === domStory && m.esl_lane)
      .sort((a, b) => (b.esl_usefulness ?? 0) - (a.esl_usefulness ?? 0))[0] ?? pickAnchor(members, registry);
    merged.push({ key: canonKey, members, anchor: { ...donor, esl_story_type: domStory, esl_canonical_key: canonKey } });
    crossLangMerges++;
    slotsPrevented += grp.length - 1;
    for (const m of members) m.esl_canonical_key = canonKey;
    await admin.from("radar_shadow_articles")
      .update({ esl_canonical_key: canonKey, esl_canonicalized_at: new Date().toISOString() })
      .in("id", members.map((m) => m.id));
  }

  // --- 6) Best source + score per (possibly merged) cluster ----------------
  const scored: ScoredCandidate[] = [];
  for (const c of merged) {
    const a = c.anchor;
    if (!a.esl_lane) { clusterSkips.push({ key: c.key, reason: "unclassified", rep: a }); continue; }
    // Editorial quality floor: hype/pseudoscience were marked usefulness 0 +
    // evidence none by the classifier — never select them.
    if ((a.esl_usefulness ?? 0) === 0 && (a.esl_evidence_class ?? "none") === "none") {
      clusterSkips.push({ key: c.key, reason: "editorial_exclude", rep: a }); continue;
    }
    const storyType = (a.esl_story_type as StoryType) ?? "general";
    // Best source across ALL members (a merge can reveal a stronger source than
    // the weak outlet that first surfaced one language variant).
    const rep = bestSource(c.members, storyType, registry);
    // Carry the story-level classification onto the chosen representative row.
    const repScored: RadarRow = {
      ...rep,
      esl_lane: a.esl_lane, esl_story_type: a.esl_story_type,
      esl_evidence_class: a.esl_evidence_class, esl_gcc: a.esl_gcc, esl_usefulness: a.esl_usefulness,
    };
    // L5 evidence gate: only research-based or institution-guidance L5 qualifies.
    if (repScored.esl_lane === "L5" && !isL5Eligible(repScored)) {
      clusterSkips.push({ key: c.key, reason: "evidence_failed", rep: repScored }); continue;
    }
    const sc = scoreCandidate(repScored, c.members, registry, day, nowMs);
    sc.clusterKey = c.key; // canonical/event/title key — used for dedup + audit
    scored.push(sc);
    // Audit the merged-away language variants as members of this one cluster.
    if (c.key.startsWith("canon:")) {
      for (const m of c.members) {
        if (m.id !== rep.id) clusterSkips.push({ key: c.key, reason: "merged_duplicate", rep: m });
      }
    }
  }

  // --- 7) Balanced, stateful selection -------------------------------------
  const cfg = defaultLaneConfig(cap);
  const { selected, skipped } = selectBalanced(scored, day, remainingCap, cfg);

  // --- 8) Record decisions + (live) promote --------------------------------
  const selectionRows: Record<string, unknown>[] = [];
  const promotions: { key: string; status: string; content_id: string | null }[] = [];

  for (const c of selected) {
    const row: Record<string, unknown> = baseSelectionRow(editorialDay, runId, mode, c, true);
    row.selection_reason = selectionReason(c);
    if (mode === "live") {
      const pr = await promote(admin, c.rep, c.rep.expected_category_slug ?? null, c.clusterKey, c.storyType);
      row.promotion_status = pr.ok ? "promoted" : "failed";
      row.promoted_content_id = pr.content_id;
      if (pr.escalation) {
        row.esc_status = pr.escalation.status;
        row.esc_method = pr.escalation.method;
        row.esc_editorial_domain = pr.escalation.editorial_domain;
        row.esc_editorial_tier = pr.escalation.editorial_tier;
      }
      if (!pr.ok) row.skip_reason = `promotion_${pr.status}:${pr.reason ?? ""}`.slice(0, 200);
      promotions.push({ key: c.clusterKey, status: pr.ok ? "promoted" : `failed:${pr.reason}`, content_id: pr.content_id });
      // Reflect this pick in the running day-state so LATER picks in THIS run stay
      // balanced against it (selectBalanced already did within its own set, but a
      // failed promotion should still not free capacity for a duplicate topic).
    } else {
      row.promotion_status = "shadow";
    }
    selectionRows.push(row);
  }

  // Record the notable skips too (audit "why not"). ALWAYS keep the meaningful
  // reasons (merged_duplicate / evidence_failed / editorial_exclude /
  // already_covered) — the 'unclassified' backlog is large and would otherwise
  // crowd them out, so it is capped to a small sample.
  const importantSkips = clusterSkips.filter((s) => s.reason !== "unclassified");
  const unclassifiedSample = clusterSkips.filter((s) => s.reason === "unclassified").slice(0, 20);
  for (const s of [...importantSkips, ...unclassifiedSample]) {
    selectionRows.push(skipRow(editorialDay, runId, mode, s.rep, s.key, s.reason, registry));
  }
  for (const s of skipped.slice(0, 120)) {
    const row = baseSelectionRow(editorialDay, runId, mode, s.cand, false);
    row.skip_reason = s.reason;
    row.promotion_status = null;
    selectionRows.push(row);
  }

  if (selectionRows.length) {
    // Insert in chunks to stay well within payload limits.
    for (let i = 0; i < selectionRows.length; i += 200) {
      await admin.from("radar_editorial_selection").insert(selectionRows.slice(i, i + 200));
    }
  }

  const laneMix: Record<string, number> = {};
  for (const c of selected) laneMix[c.lane] = (laneMix[c.lane] ?? 0) + 1;

  // Finalize the run-log. 'partial' when a live run had promotion failures
  // (some selected stories didn't reach PENDING Content); else 'success'.
  const promotedN = mode === "live" ? promotions.filter((p) => p.status === "promoted").length : 0;
  const promoFailedN = mode === "live" ? promotions.filter((p) => p.status !== "promoted").length : 0;
  await finalizeEsl(promoFailedN > 0 ? "partial" : "success", {
    remaining_cap: remainingCap, pool_size: rows.length, clusters: clusters.size,
    selected: selected.length, promoted: promotedN, promotion_failed: promoFailedN,
  });

  return Response.json({
    ok: true,
    mode,
    editorial_day: editorialDay,
    run_id: runId,
    cap,
    remaining_cap: remainingCap,
    promoted_today_before: promotedToday,
    pool_size: rows.length,
    event_clusters: clusters.size,
    active_clusters: active.length,
    classified_this_run: needClassify.length,
    canon: {
      ambiguous_groups: preGroups.length,
      llm_items: canonLLMItems,
      cross_language_merges: crossLangMerges,
      duplicate_slots_prevented: slotsPrevented,
      clusters_after_merge: merged.length,
    },
    scored: scored.length,
    selected: selected.length,
    selected_lane_mix: laneMix,
    selected_gcc: selected.filter((c) => c.gcc).length,
    promotions: mode === "live" ? promotions : undefined,
    skips: {
      already_covered: clusterSkips.filter((s) => s.reason === "already_covered").length,
      merged_duplicate: clusterSkips.filter((s) => s.reason === "merged_duplicate").length,
      unclassified: clusterSkips.filter((s) => s.reason === "unclassified").length,
      editorial_exclude: clusterSkips.filter((s) => s.reason === "editorial_exclude").length,
      evidence_failed: clusterSkips.filter((s) => s.reason === "evidence_failed").length,
      low_score: skipped.filter((s) => s.reason === "low_score").length,
      duplicate_topic: skipped.filter((s) => s.reason === "duplicate_topic").length,
      near_duplicate: skipped.filter((s) => s.reason === "near_duplicate").length,
      l5_floor_displaced: skipped.filter((s) => s.reason === "l5_floor_displaced").length,
      lane_full: skipped.filter((s) => s.reason === "lane_full").length,
      cap_reached: skipped.filter((s) => s.reason === "cap_reached").length,
    },
  });
  } catch (eslErr) {
    // Top-level guard: any uncaught error finalizes the run-log as 'failed' with
    // a concise message (previously the ESL had NO top-level try/catch, so a
    // crash was invisible). Editorial safety is unchanged — a failed run simply
    // created no Content; nothing is auto-published.
    await finalizeEsl("failed", { error: (eslErr instanceof Error ? eslErr.message : String(eslErr)).slice(0, 500) });
    return Response.json({ ok: false, error: "esl_run_failed" }, { status: 500 });
  }
});

// ---- row builders ---------------------------------------------------------

/** Strongest-tier member as the classification anchor; freshest breaks ties. */
function pickAnchor(members: RadarRow[], registry: Map<string, RegistryEntry>): RadarRow {
  return [...members].sort((a, b) => {
    const ta = sourceTier(a.source_domain, registry), tb = sourceTier(b.source_domain, registry);
    if (ta !== tb) return ta - tb; // lower tier number = stronger
    const pa = Date.parse(a.published_at ?? a.first_seen_at ?? "") || 0;
    const pb = Date.parse(b.published_at ?? b.first_seen_at ?? "") || 0;
    return pb - pa;
  })[0];
}

function baseSelectionRow(day: string, runId: string, mode: string, c: ScoredCandidate, selected: boolean): Record<string, unknown> {
  return {
    editorial_day: day,
    run_id: runId,
    mode,
    cluster_key: c.clusterKey,
    radar_article_id: c.rep.id,
    lane: c.lane,
    story_type: c.storyType,
    evidence_class: c.rep.esl_evidence_class,
    gcc: c.gcc,
    source_tier: c.tier,
    source_role: c.role,
    chosen_source_domain: normalizeDomain(c.rep.source_domain),
    chosen_source_title: c.rep.source_title,
    composite_score: c.score,
    selected,
  };
}

function skipRow(day: string, runId: string, mode: string, rep: RadarRow, key: string, reason: string, registry: Map<string, RegistryEntry>): Record<string, unknown> {
  return {
    editorial_day: day,
    run_id: runId,
    mode,
    cluster_key: key,
    radar_article_id: rep.id,
    lane: rep.esl_lane,
    story_type: rep.esl_story_type,
    evidence_class: rep.esl_evidence_class,
    gcc: rep.esl_gcc === true,
    source_tier: sourceTier(rep.source_domain, registry),
    source_role: sourceRole(rep.source_domain, registry),
    chosen_source_domain: normalizeDomain(rep.source_domain),
    chosen_source_title: rep.source_title,
    composite_score: null,
    selected: false,
    skip_reason: reason,
    promotion_status: null,
  };
}

/** Concise, human-readable rationale (not a prose blob). */
function selectionReason(c: ScoredCandidate): string {
  const parts = [
    `${c.lane}/${c.storyType}`,
    `tier${c.tier}·${c.role}`,
    `score ${c.score.toFixed(2)}`,
    c.memberCount > 1 ? `${c.memberCount} sources` : "single source",
  ];
  if (c.gcc) parts.push("GCC");
  if (c.rep.priority_level === "very_important") parts.push("high-importance");
  return parts.join(" · ");
}
