import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chatWeb, type Citation } from "./openrouter";
import type { Database, Tables, TablesInsert } from "@/lib/supabase/database.types";

// Accepts both the @supabase/ssr server client and the service-role admin
// client, whose generic arities differ slightly across versions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<Database, any, any>;

const VALID_CATEGORIES = ["kuwait", "gulf", "world", "health-economy", "lifestyle", "investigations"];

const REGION_LABELS: Record<string, string> = {
  kuwait: "الكويت",
  gulf: "دول الخليج (السعودية، الإمارات، قطر، البحرين، عُمان)",
  mena: "الشرق الأوسط وشمال أفريقيا",
  world: "العالم",
};

type Policy = Tables<"editorial_policy">;

export type RunStats = {
  found: number;
  kept: number;
  filtered: number;
  duplicates: number;
};

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

/** Load the single editorial-policy row (admin-configured allow/block lists). */
async function loadPolicy(db: DB): Promise<Policy | null> {
  const { data } = await db.from("editorial_policy").select("*").limit(1).maybeSingle();
  return (data as Policy | null) ?? null;
}

/** Normalise a URL into a stable dedupe key (host + path, no scheme/query/hash). */
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

/** Build a normalised lookup of the real citation URLs the plugin returned. */
function citationIndex(citations: Citation[]): Map<string, Citation> {
  const map = new Map<string, Citation>();
  for (const c of citations) {
    const key = dedupeKeyFromUrl(c.url);
    if (key) map.set(key, c);
  }
  return map;
}

/**
 * Run one full ingestion pass: live-search per enabled region, translate &
 * curate into Arabic drafts, enforce the real-citation safeguard, dedupe, and
 * insert as `pending` content for admin review. Returns per-run stats.
 */
export async function runIngestion(
  db: DB,
  opts: { trigger?: "manual" | "cron"; perRegion?: number } = {},
): Promise<RunStats> {
  const trigger = opts.trigger ?? "manual";
  const perRegion = Math.min(Math.max(opts.perRegion ?? 3, 1), 5);

  const policy = await loadPolicy(db);
  if (!policy) throw new Error("no editorial policy configured");

  const regions = policy.regions.length ? policy.regions : ["world"];
  const stats: RunStats = { found: 0, kept: 0, filtered: 0, duplicates: 0 };

  const startedAt = Date.now();
  const sourcesChecked = new Set<string>();
  const createdIds: string[] = [];

  try {
    for (const region of regions) {
      const regionLabel = REGION_LABELS[region] ?? region;
      let result;
      try {
        result = await chatWeb(
          [
            { role: "system", content: buildSystem(policy) },
            { role: "user", content: buildPrompt(regionLabel, perRegion) },
          ],
          { temperature: 0.3, maxTokens: 2600, maxResults: 8 },
        );
      } catch {
        continue; // one region failing shouldn't abort the whole run
      }

      // Record every source the plugin actually surfaced (checked) this run.
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

        // Dedupe against already-ingested stories.
        const { data: existing } = await db
          .from("content")
          .select("id")
          .eq("dedupe_key", key)
          .maybeSingle();
        if (existing) {
          stats.duplicates++;
          continue;
        }

        const slug = `${slugify(draft.title)}-${Math.random().toString(36).slice(2, 7)}`;
        const payload: TablesInsert<"content"> = {
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
          dedupe_key: key,
        };
        const { data, error } = await db
          .from("content")
          .insert(payload as unknown as never)
          .select("id")
          .single();
        if (error || !data) {
          stats.filtered++;
          continue;
        }

        const contentId = (data as { id: string }).id;
        const sourceRow: TablesInsert<"content_sources"> = {
          content_id: contentId,
          label: citation.title || new URL(citation.url).host.replace(/^www\./, ""),
          url: citation.url,
        };
        await db.from("content_sources").insert(sourceRow as unknown as never);
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
    } as unknown as never);
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
    } as unknown as never);
    throw e;
  }
}
