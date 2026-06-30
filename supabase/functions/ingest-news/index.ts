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

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-oss-20b:free";

const VALID_CATEGORIES = [
  "kuwait",
  "gulf",
  "world",
  "health-economy",
  "lifestyle",
  "investigations",
];

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

function buildSystem(policy: Policy): string {
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
- صنّف كل خبر إلى أحد الأقسام: kuwait, gulf, world, health-economy, lifestyle, investigations.
- relevance_score: رقم 0-100 يقيس مدى أهمية الخبر لقارئ صحي في الكويت/الخليج.

أعد النتيجة بصيغة JSON فقط دون أي نص إضافي.`;
}

function buildPrompt(regionLabel: string, count: number): string {
  return `ابحث عن أحدث الأخبار الصحية الموثوقة المتعلقة بـ: ${regionLabel}.
أنشئ حتى ${count} مسودّات خبر اعتماداً على نتائج البحث الحقيقية فقط.
أعد كائن JSON بالشكل التالي حصراً:
{"items":[{"title":"العنوان بالعربية","excerpt":"موجز قصير","body":"النص المبسّط","category_slug":"world","read_minutes":3,"relevance_score":70,"original_title":"العنوان الأصلي بلغته","source_url":"https://..."}]}`;
}

function sanitize(items: unknown): Draft[] {
  if (!Array.isArray(items)) return [];
  const out: Draft[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = String(o.title ?? "").trim();
    const source_url = String(o.source_url ?? "").trim();
    if (title.length < 4 || !source_url) continue;
    out.push({
      title,
      excerpt: String(o.excerpt ?? "").trim(),
      body: String(o.body ?? "").trim(),
      category_slug: VALID_CATEGORIES.includes(String(o.category_slug))
        ? String(o.category_slug)
        : "world",
      read_minutes: Number(o.read_minutes) || 3,
      relevance_score: Math.min(Math.max(Number(o.relevance_score) || 0, 0), 100),
      original_title: String(o.original_title ?? "").trim(),
      source_url,
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

  const regions: string[] = policy.regions?.length ? policy.regions : ["world"];
  const stats: RunStats = { found: 0, kept: 0, filtered: 0, duplicates: 0 };

  const startedAt = Date.now();
  const sourcesChecked = new Set<string>();
  const createdIds: string[] = [];

  try {
    for (const region of regions) {
      const regionLabel = REGION_LABELS[region] ?? region;
      let result: WebChatResult;
      try {
        result = await chatWeb(
          [
            { role: "system", content: buildSystem(policy as Policy) },
            { role: "user", content: buildPrompt(regionLabel, perRegion) },
          ],
          { temperature: 0.3, maxTokens: 2600, maxResults: 8 },
        );
      } catch {
        continue;
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
        continue;
      }

      for (const draft of sanitize(parsed.items)) {
        stats.found++;

        // SAFEGUARD: the source URL must match a real citation the plugin
        // returned — otherwise the model likely invented it. Drop the item.
        const key = dedupeKeyFromUrl(draft.source_url);
        const citation = key ? citations.get(key) : undefined;
        if (!key || !citation) {
          stats.filtered++;
          continue;
        }

        const { data: existing } = await db
          .from("content")
          .select("id")
          .eq("dedupe_key", key)
          .maybeSingle();
        if (existing) {
          stats.duplicates++;
          continue;
        }

        const sourceName = citation.title || new URL(citation.url).host.replace(/^www\./, "");
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
          stats.filtered++;
          continue;
        }

        const contentId = (data as { id: string }).id;
        await db.from("content_sources").insert({
          content_id: contentId,
          label: sourceName,
          url: citation.url,
        });
        createdIds.push(contentId);
        stats.kept++;
      }
    }

    await db.from("ingestion_runs").insert({
      trigger,
      status: "success",
      ...stats,
      duration_ms: Date.now() - startedAt,
      sources: [...sourcesChecked],
      created_ids: createdIds,
    });
    return stats;
  } catch (e) {
    await db.from("ingestion_runs").insert({
      trigger,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
      ...stats,
      duration_ms: Date.now() - startedAt,
      sources: [...sourcesChecked],
      created_ids: createdIds,
    });
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
  if (profile && profile.role === "admin" && !profile.disabled) return "manual";
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
