// Salma news-ingestion agent — runs entirely inside Supabase (Deno).
//
// Auth (verify_jwt is disabled; this function does its own checks):
//   - Cron path: pg_cron -> run_news_ingestion() sends header
//     `x-ingest-secret` matching the INGEST_SECRET function secret.
//   - Manual path: the admin UI invokes this function with the admin's
//     session JWT in the Authorization header; we verify role = 'admin'.
//
// Required function secrets: OPENROUTER_API_KEY, INGEST_SECRET.
// Optional: OPENROUTER_MODEL. SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  blockedDomains,
  buildRegistryIndex,
  type Candidate,
  discoveryDomains,
  failsPrGate,
  hostFromUrl,
  isRejectionReason,
  matchSource,
  pickFinalSource,
  type RegistrySource,
  type RejectionReason,
  registryUsable,
} from "./registry.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-oss-20b:free";
// Bumped when the editorial prompt/decision schema changes; recorded per decision.
const PROMPT_VERSION = "e1.1";

// Fallback set, used only if the categories table can't be read. The live list
// is fetched from the DB per run so admin-created categories work too.
const FALLBACK_CATEGORIES = [
  "kuwait",
  "gulf",
  "world",
  "health-economy",
  "lifestyle",
  "investigations",
];

async function fetchCategorySlugs(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from("categories").select("slug").order("sort_order");
  const slugs = (data as { slug: string }[] | null)?.map((c) => c.slug) ?? [];
  return slugs.length > 0 ? slugs : FALLBACK_CATEGORIES;
}

// Loads the active source registry fresh at the start of every run. Never
// throws: returns `ok: false` when the query itself failed, so the caller can
// fail safe (abort the run, create no drafts) instead of silently weakening
// source verification.
async function loadRegistry(
  db: SupabaseClient,
): Promise<{ sources: RegistrySource[]; index: Map<string, RegistrySource>; ok: boolean }> {
  try {
    const { data, error } = await db
      .from("news_sources")
      .select(
        "name,domain,region,source_type,tier,trust_score,discovery_enabled,final_source_allowed,active",
      )
      .eq("active", true);
    if (error || !data) return { sources: [], index: new Map(), ok: false };
    const sources = data as RegistrySource[];
    return { sources, index: buildRegistryIndex(sources), ok: true };
  } catch {
    return { sources: [], index: new Map(), ok: false };
  }
}

// Thrown when the source registry cannot be loaded/verified. Surfaced to the
// admin as a clear operational error; the run creates no drafts.
class RegistryUnavailableError extends Error {
  constructor() {
    super("source registry unavailable — ingestion aborted, no drafts created");
    this.name = "RegistryUnavailableError";
  }
}

const REGION_LABELS: Record<string, string> = {
  kuwait: "الكويت",
  gulf: "دول الخليج (السعودية، الإمارات، قطر، البحرين، عُمان)",
  mena: "الشرق الأوسط وشمال أفريقيا",
  world: "العالم",
};

type Citation = { url: string; title: string };
type WebChatResult = { content: string; citations: Citation[] };

type Policy = {
  block_topics: string[];
  priority_topics: string[];
  trusted_sources: string[];
  regions: string[];
};

type RunStats = { found: number; kept: number; filtered: number; duplicates: number };

type Draft = {
  title: string;
  excerpt: string;
  body: string;
  category_slug: string;
  read_minutes: number;
  relevance_score: number;
  original_title: string;
  source_url: string;
  // E1.1 editorial-selection fields (model-supplied, then code-verified).
  primary_source_url: string;
  secondary_source_urls: string[];
  published_date: string | null;
  editorial_value_score: number;
  institutional_pr_score: number;
  rejection_reason: RejectionReason | null;
};

// One audit row per candidate story considered in a run.
type Decision = {
  title: string;
  source_domain: string | null;
  source_url: string | null;
  source_tier: string | null;
  source_trust_score: number | null;
  editorial_value_score: number | null;
  institutional_pr_score: number | null;
  accepted: boolean;
  rejection_reason: string | null;
};

// ---- OpenRouter web-search client ---------------------------------------

async function chatWeb(
  messages: { role: string; content: string }[],
  options: { temperature?: number; maxTokens?: number; maxResults?: number } = {},
): Promise<WebChatResult> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://salma.health",
      "X-Title": "Salma",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
      plugins: [{ id: "web", max_results: options.maxResults ?? 6 }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter web request failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  const citations: Citation[] = [];
  for (const a of annotations) {
    const c = a?.url_citation;
    if (c?.url) citations.push({ url: String(c.url), title: String(c.title ?? "") });
  }
  return { content: message.content ?? "", citations };
}

// ---- Helpers ------------------------------------------------------------

function dedupeKeyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return null;
  }
}

// Fetches the real article page and extracts its OpenGraph/Twitter cover
// image. Returns null on any failure so ingestion never blocks on images.
async function fetchCoverImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SalmaBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200000);
    const patterns = [
      /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) {
        try {
          return new URL(m[1].trim(), url).href;
        } catch {
          continue;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function slugify(input: string): string {
  return (
    input
      .trim()
      .replace(/[\u064B-\u065F\u0610-\u061A]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .toLowerCase() || "news"
  );
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in response");
  return JSON.parse(text.slice(start, end + 1));
}

function buildSystem(policy: Policy, validCategories: string[]): string {
  const block = policy.block_topics.length
    ? policy.block_topics.map((t) => `- ${t}`).join("\n")
    : "- (لا قيود إضافية)";
  const priority = policy.priority_topics.length
    ? policy.priority_topics.map((t) => `- ${t}`).join("\n")
    : "- (لا أولويات محددة)";

  return `أنت محرّر صحي في منصة "سلمى" الإخبارية الكويتية. تتلقى نتائج بحث حقيقية من الإنترنت (مع روابطها) وتحوّلها إلى مسودّات أخبار صحية بالعربية الفصحى.

قواعد صارمة:
- استخدم فقط المعلومات الموجودة في نتائج البحث المرفقة. لا تختلق أي حقائق أو أرقام أو أسماء.
- لا تختلق روابط. انسخ رابط المصدر (source_url) حرفياً من نتائج البحث التي اعتمدت عليها لكل خبر.
- ترجم وبسّط المحتوى لقارئ عام في الكويت والخليج مع الحفاظ على الدقة.
- استبعِد تماماً أي خبر يتناول المواضيع التالية (سياسة "ما يجب تجنّبه"):
${block}
- أعطِ الأولوية للمواضيع التالية:
${priority}
- صنّف كل خبر إلى أحد الأقسام: ${validCategories.join(", ")}.
- relevance_score: رقم 0-100 يقيس مدى أهمية الخبر لقارئ صحي في الكويت/الخليج.

التقييم التحريري (مهم — ثقة المصدر لا تعني القيمة التحريرية):
- editorial_value_score: رقم 0-100 يقيس القيمة الخبرية الحقيقية للقارئ (تطوّر ملموس ذو أثر عام).
- institutional_pr_score: رقم 0-100 يقيس مدى كون الخبر مجرّد دعاية مؤسسية أو مراسم بلا مضمون.
- عادةً ارفض (institutional_pr مرتفع، editorial_value منخفض): المشاركة في مؤتمرات، رعاية فعاليات، الزيارات والاستقبالات الرسمية، اجتماعات التعاون العامة، الجوائز والتهاني والبروتوكول، الافتتاحات دون معلومات خدمية، مذكرات التفاهم دون مخرجات، التصريحات حول المسؤولين، عبارات الالتزام العامة.
- لكن لا ترفض بناءً على الكلمات المفتاحية وحدها: تحقّق أولاً من وجود تطوّر ملموس يهمّ الجمهور (لائحة أو قرار تنظيمي، تحذير أو سحب دواء، إطلاق خدمة مع تفاصيل الوصول، تغيير يمسّ المرضى أو الأهلية أو التكلفة أو السعة أو أوقات الانتظار، بيانات صحة عامة جديدة، نتيجة سريرية أو بحثية، نتيجة قابلة للقياس، مواعيد أو أماكن أو حجز أو شروط أهلية مفيدة).
- إذا وُجدت معلومة مفيدة داخل بيان دعائي: استخرج المضمون الجوهري واحذف العبارات المراسمية، ولا ترفض الخبر.
- يجب أن يجيب كل خبر مقبول عن: ما الذي تغيّر، من المتأثّر، لماذا يهمّ الآن، ما الحقيقة أو الإجراء المفيد.
- decision: "accept" أو "reject". عند الرفض، اضبط rejection_reason بأحد القيم التالية فقط: ceremonial_or_promotional, no_concrete_public_impact, generic_institutional_announcement, memorandum_without_deliverables, official_activity_without_news_value, weak_or_unverified_source, stronger_primary_source_required.
- المصادر: primary_source_url هو الرابط الأصلي الأقوى (جهة تنظيمية أو وزارة أو جامعة أو مستشفى أو دورية علمية) وليس مجمِّع أخبار ضعيف. secondary_source_urls روابط داعمة إضافية. published_date تاريخ النشر الأصلي إن توفّر (YYYY-MM-DD) وإلا اتركه فارغاً. لا تختلق التواريخ أو الروابط.

أعد النتيجة بصيغة JSON فقط دون أي نص إضافي.`;
}

function buildPrompt(
  regionLabel: string,
  count: number,
  preferDomains: string[],
  avoidDomains: string[],
): string {
  const prefer = preferDomains.length
    ? `\nفضّل المصادر الأساسية الموثوقة من هذه النطاقات (الأقوى أولاً): ${preferDomains.join(", ")}.`
    : "";
  const avoid = avoidDomains.length
    ? `\nتجنّب تماماً هذه النطاقات المحظورة: ${avoidDomains.join(", ")}.`
    : "";
  return `ابحث عن أحدث الأخبار الصحية الموثوقة المتعلقة بـ: ${regionLabel}.${prefer}${avoid}
أنشئ حتى ${count} مسودّات خبر اعتماداً على نتائج البحث الحقيقية فقط.
فضّل الدراسة الأصلية أو الجهة التنظيمية أو الوزارة أو الجامعة أو المستشفى كمصدر نهائي بدلاً من مجمِّع أخبار ضعيف.
أعد كائن JSON بالشكل التالي حصراً:
{"items":[{"title":"العنوان بالعربية","excerpt":"موجز قصير","body":"النص المبسّط","category_slug":"world","read_minutes":3,"relevance_score":70,"original_title":"العنوان الأصلي بلغته","source_url":"https://...","primary_source_url":"https://...","secondary_source_urls":["https://..."],"published_date":"2026-01-01","editorial_value_score":70,"institutional_pr_score":20,"decision":"accept","rejection_reason":null}]}`;
}

function sanitize(items: unknown, validCategories: string[]): Draft[] {
  if (!Array.isArray(items)) return [];
  const fallbackCat = validCategories.includes("world") ? "world" : validCategories[0] ?? "world";
  const out: Draft[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = String(o.title ?? "").trim();
    const source_url = String(o.source_url ?? "").trim();
    if (title.length < 4 || !source_url) continue;
    const secondary = Array.isArray(o.secondary_source_urls)
      ? o.secondary_source_urls.map((u) => String(u).trim()).filter(Boolean)
      : [];
    const publishedRaw = String(o.published_date ?? "").trim();
    const reasonRaw = o.rejection_reason;
    out.push({
      title,
      excerpt: String(o.excerpt ?? "").trim(),
      body: String(o.body ?? "").trim(),
      category_slug: validCategories.includes(String(o.category_slug))
        ? String(o.category_slug)
        : fallbackCat,
      read_minutes: Number(o.read_minutes) || 3,
      relevance_score: Math.min(Math.max(Number(o.relevance_score) || 0, 0), 100),
      original_title: String(o.original_title ?? "").trim(),
      source_url,
      primary_source_url: String(o.primary_source_url ?? "").trim() || source_url,
      secondary_source_urls: secondary,
      published_date: publishedRaw || null,
      editorial_value_score: Math.min(Math.max(Number(o.editorial_value_score) || 0, 0), 100),
      institutional_pr_score: Math.min(Math.max(Number(o.institutional_pr_score) || 0, 0), 100),
      rejection_reason:
        String(o.decision ?? "").toLowerCase() === "reject" && isRejectionReason(reasonRaw)
          ? reasonRaw
          : null,
    });
  }
  return out;
}

function citationIndex(citations: Citation[]): Map<string, Citation> {
  const map = new Map<string, Citation>();
  for (const c of citations) {
    const key = dedupeKeyFromUrl(c.url);
    if (key) map.set(key, c);
  }
  return map;
}

// ---- Core run -----------------------------------------------------------

async function runIngestion(
  db: SupabaseClient,
  opts: { trigger?: "manual" | "cron"; perRegion?: number } = {},
): Promise<RunStats> {
  const trigger = opts.trigger ?? "manual";
  const perRegion = Math.min(Math.max(opts.perRegion ?? 3, 1), 5);

  const { data: policy } = await db
    .from("editorial_policy")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (!policy) throw new Error("no editorial policy configured");

  const validCategories = await fetchCategorySlugs(db);
  const regions: string[] = policy.regions?.length ? policy.regions : ["world"];
  const stats: RunStats = { found: 0, kept: 0, filtered: 0, duplicates: 0 };

  const startedAt = Date.now();
  // Pre-generated so decisions can FK the run row.
  const runId = crypto.randomUUID();

  // Load the source registry fresh each run. FAIL SAFE: if it cannot be loaded
  // or verified we record a `registry_unavailable` run, create NO drafts, leave
  // existing published content untouched, and surface an operational error —
  // we never silently fall back to accepting unverified citations.
  const registry = await loadRegistry(db);
  if (!registryUsable(registry.ok, registry.sources.length)) {
    await db.from("ingestion_runs").insert({
      id: runId,
      trigger,
      status: "error",
      error: "registry_unavailable",
      found: 0,
      kept: 0,
      filtered: 0,
      duplicates: 0,
      duration_ms: Date.now() - startedAt,
      sources: [],
      created_ids: [],
    });
    throw new RegistryUnavailableError();
  }
  const preferDomains = discoveryDomains(registry.sources);
  const avoidDomains = blockedDomains(registry.sources);

  const sourcesChecked = new Set<string>();
  const createdIds: string[] = [];
  const decisions: Decision[] = [];

  // Records the outcome of a single candidate story for the audit log. The
  // `chosen` candidate (when accepted) determines the domain/tier/trust logged.
  const logDecision = (
    draft: Draft,
    chosen: Candidate | null,
    accepted: boolean,
    reason: RejectionReason | null,
  ): void => {
    const url = chosen?.url ?? draft.primary_source_url ?? draft.source_url;
    decisions.push({
      title: draft.title,
      source_domain: url ? hostFromUrl(url) : null,
      source_url: url || null,
      source_tier: chosen?.source?.tier ?? null,
      source_trust_score: chosen?.source?.trust_score ?? null,
      editorial_value_score: draft.editorial_value_score,
      institutional_pr_score: draft.institutional_pr_score,
      accepted,
      rejection_reason: reason,
    });
  };

  // Insert a single validated draft. Safe to run concurrently: the unique
  // index on dedupe_key turns same-run collisions into a counted duplicate.
  const processItem = async (
    draft: Draft,
    citations: Map<string, Citation>,
  ): Promise<void> => {
    stats.found++;

    // The model already judged this a promotional/ceremonial non-story.
    if (draft.rejection_reason) {
      logDecision(draft, null, false, draft.rejection_reason);
      stats.filtered++;
      return;
    }

    // Deterministic backstop over the model: a high-PR / low-editorial release
    // is rejected even if the model tried to keep it.
    if (failsPrGate(draft.editorial_value_score, draft.institutional_pr_score)) {
      logDecision(draft, null, false, "ceremonial_or_promotional");
      stats.filtered++;
      return;
    }

    // Build the candidate set from every URL the model attached, keeping only
    // those that match a real citation the plugin returned (anti-fabrication).
    const candidateUrls = [
      draft.primary_source_url,
      draft.source_url,
      ...draft.secondary_source_urls,
    ];
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const url of candidateUrls) {
      const k = dedupeKeyFromUrl(url);
      const citation = k ? citations.get(k) : undefined;
      if (!k || !citation || seen.has(k)) continue;
      seen.add(k);
      candidates.push({ url: citation.url, source: matchSource(hostFromUrl(citation.url), registry.index) });
    }

    // Rank sources: drop blocked, prefer Tier 1 primary over weak aggregators.
    // Registry is guaranteed usable here (the run aborts earlier otherwise).
    const pick = pickFinalSource(candidates, true);
    if (!pick.chosen) {
      logDecision(draft, null, false, pick.reason);
      stats.filtered++;
      return;
    }
    const chosen = pick.chosen;
    const finalUrl = chosen.url;
    const key = dedupeKeyFromUrl(finalUrl)!;
    const citation = citations.get(key)!;

    const { data: existing } = await db
      .from("content")
      .select("id")
      .eq("dedupe_key", key)
      .maybeSingle();
    if (existing) {
      logDecision(draft, chosen, false, null);
      stats.duplicates++;
      return;
    }

    const sourceName =
      chosen.source?.name || citation.title || new URL(citation.url).host.replace(/^www\./, "");
    const coverImage = await fetchCoverImage(citation.url);

    const slug = `${slugify(draft.title)}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      title: draft.title,
      slug,
      type: "news",
      status: "pending",
      origin: "ai",
      category_slug: draft.category_slug,
      excerpt: draft.excerpt || null,
      body: draft.body || null,
      read_minutes: draft.read_minutes,
      relevance_score: draft.relevance_score,
      original_title: draft.original_title || null,
      original_url: citation.url,
      source_name: sourceName,
      source_url: finalUrl,
      cover_image_url: coverImage,
      cover_credit_name: coverImage ? sourceName : null,
      cover_credit_url: coverImage ? citation.url : null,
      dedupe_key: key,
    };
    const { data, error } = await db
      .from("content")
      .insert(payload)
      .select("id")
      .single();
    if (error || !data) {
      // 23505 = unique_violation: another concurrent item won the same key.
      if ((error as { code?: string } | null)?.code === "23505") {
        logDecision(draft, chosen, false, null);
        stats.duplicates++;
      } else {
        logDecision(draft, chosen, false, null);
        stats.filtered++;
      }
      return;
    }

    const contentId = (data as { id: string }).id;
    // Primary source first, then any distinct secondary citations for context.
    const sourceRows = [{ content_id: contentId, label: sourceName, url: finalUrl }];
    for (const c of candidates) {
      if (c.url === finalUrl) continue;
      sourceRows.push({
        content_id: contentId,
        label: c.source?.name || new URL(c.url).host.replace(/^www\./, ""),
        url: c.url,
      });
    }
    await db.from("content_sources").insert(sourceRows);
    logDecision(draft, chosen, true, null);
    createdIds.push(contentId);
    stats.kept++;
  };

  // Fetch + process each region concurrently to keep total runtime bounded by
  // the slowest region instead of the sum of all regions.
  const processRegion = async (region: string): Promise<void> => {
    const regionLabel = REGION_LABELS[region] ?? region;
    let result: WebChatResult;
    try {
      result = await chatWeb(
        [
          { role: "system", content: buildSystem(policy as Policy, validCategories) },
          { role: "user", content: buildPrompt(regionLabel, perRegion, preferDomains, avoidDomains) },
        ],
        { temperature: 0.3, maxTokens: 2600, maxResults: 8 },
      );
    } catch {
      return;
    }

    for (const c of result.citations) {
      try {
        sourcesChecked.add(new URL(c.url).host.replace(/^www\./, ""));
      } catch {
        // skip unparseable citation URLs
      }
    }

    const citations = citationIndex(result.citations);
    let parsed: { items?: unknown };
    try {
      parsed = extractJson(result.content) as { items?: unknown };
    } catch {
      return;
    }

    await Promise.all(
      sanitize(parsed.items, validCategories).map((draft) => processItem(draft, citations)),
    );
  };

  // Persist the per-candidate audit trail. The run row already exists (created
  // as 'running' below) so the run_id FK always resolves; never throws
  // (best-effort logging).
  const persistDecisions = async (): Promise<void> => {
    if (decisions.length === 0) return;
    const rows = decisions.map((d) => ({
      ...d,
      run_id: runId,
      model: DEFAULT_MODEL,
      prompt_version: PROMPT_VERSION,
    }));
    try {
      await db.from("ingestion_decisions").insert(rows);
    } catch {
      // audit logging is best-effort; a failure must not fail the run
    }
  };

  // Run lifecycle: create the run row up front as 'running' so decisions can
  // reference it and so a crash mid-run leaves a visibly-unfinished row (never
  // a misleading 'success'). It is UPDATEd to a terminal state on completion.
  await db.from("ingestion_runs").insert({
    id: runId,
    trigger,
    status: "running",
    found: 0,
    kept: 0,
    filtered: 0,
    duplicates: 0,
    sources: [],
    created_ids: [],
  });

  try {
    await Promise.all(regions.map(processRegion));

    await persistDecisions();
    await db
      .from("ingestion_runs")
      .update({
        status: "success",
        ...stats,
        duration_ms: Date.now() - startedAt,
        sources: [...sourcesChecked],
        created_ids: createdIds,
      })
      .eq("id", runId);
    return stats;
  } catch (e) {
    await persistDecisions();
    await db
      .from("ingestion_runs")
      .update({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        ...stats,
        duration_ms: Date.now() - startedAt,
        sources: [...sourcesChecked],
        created_ids: createdIds,
      })
      .eq("id", runId);
    throw e;
  }
}

// ---- Auth + HTTP entrypoint --------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const INGEST_SECRET = Deno.env.get("INGEST_SECRET");

/** Returns the run trigger if authorized, otherwise null. */
async function authorize(
  req: Request,
  admin: SupabaseClient,
): Promise<"cron" | "manual" | null> {
  // Cron path: shared secret header set by run_news_ingestion().
  const provided = req.headers.get("x-ingest-secret");
  if (INGEST_SECRET && provided && provided === INGEST_SECRET) return "cron";

  // Manual path: a signed-in admin's session JWT.
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt === ANON_KEY) return null;

  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("role,disabled")
    .eq("id", user.id)
    .maybeSingle();
  if (
    profile &&
    ["admin", "super_admin", "owner"].includes(profile.role) &&
    !profile.disabled
  )
    return "manual";
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const trigger = await authorize(req, admin);
  if (!trigger) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const stats = await runIngestion(admin, { trigger });
    return Response.json({ ok: true, ...stats });
  } catch (e) {
    const message = e instanceof Error ? e.message : "ingestion failed";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
