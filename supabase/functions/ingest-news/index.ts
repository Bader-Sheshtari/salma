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
  type DecisionReason,
  discoveryDomains,
  DRAFT_STATUS,
  failsPrGate,
  hostFromUrl,
  isRejectionReason,
  matchSource,
  pickFinalSource,
  type RegistrySource,
  type RejectionReason,
  registryUsable,
  resolveAuthorizedTargetedSource,
} from "./registry.ts";
import { clusterStories, pickBestIndex, type StoryText, storyDuplicate } from "./dedupe.ts";
import { finalizeRun, selectRollbackTargets } from "./runFinalize.ts";
import {
  assertWriterConfig,
  processRepresentativesWithLimit,
  resolvePilotGate,
  type WriterMode,
} from "./writerRouter.ts";
import {
  EDITOR_PROMPT_VERSION,
  type EditorialAudit,
} from "./salmaEditor.ts";
import {
  fetchSourceText,
  groundedWrite,
  isBlockedHostname,
  NEUTRAL_USER_AGENT,
  type SourceFetchResult,
  type SourceText,
  validateResolvedAddresses,
} from "./fetchSourceText.ts";
import { type ErPost, fetchErArticleSource } from "./erSourceFallback.ts";
import {
  domainOf as escDomainOf,
  type EscalationResult,
} from "./sourceEscalation.ts";
import {
  type FidelityRepairAudit,
} from "./fidelityRepair.ts";
import {
  analyzeEvidence,
  type EvidenceOutcome,
} from "./evidenceIntelligence.ts";
import {
  assertEditorConfig,
  chatEvidence,
  chatWeb,
  DEFAULT_MODEL,
  denoRawFetch,
  denoResolveDns,
  EDITOR_MODEL,
  evidenceDbDeps,
  makeEvidenceAnalyzer,
  type ResolvedEvidenceSource,
  resolveAnalysisSource,
  runEscalation,
  type Citation,
  type WebChatResult,
  WRITER_CONFIG,
  type WriterAudit,
  writeArticle,
  type WriterOutcome,
} from "./pipeline.ts";

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


type Policy = {
  block_topics: string[];
  priority_topics: string[];
  trusted_sources: string[];
  regions: string[];
};

type RunStats = { found: number; kept: number; filtered: number; duplicates: number };

// E1.3E single-article pilot report. Operational-only: it carries NO extracted
// source text, API keys, tokens, or request headers — just the counts an
// operator needs to confirm the first controlled pilot processed exactly one
// candidate. Returned to the manual caller only AFTER the mandatory audit has
// persisted (runIngestion throws otherwise, so a reported pilot is always audited).
type PilotReport = {
  writer_mode: "pilot";
  pilot_limit: number;
  candidates_considered: number;
  source_fetches_attempted: number;
  writer_calls_attempted: number;
  fallback_calls_attempted: number;
  // Writer JSON-recovery observability: total writer model calls for the pilot
  // draft and whether the second call was the strict-JSON reparse recovery.
  writer_attempts: number;
  writer_second_attempt: "none" | "json_recovery";
  pending_articles_created: number;
  rejection_reason: string | null;
  created_content_id: string | null;
  // E1.4A: the editorial-director audit for the single draft that reached the
  // editor stage (null until then). Observability-only — surfaced in the HTTP
  // pilot report, NOT persisted to ingestion_decisions (no migration).
  editorial: EditorialAudit | null;
  editor_prompt_version: string | null;
  // Post-editor source-fidelity stage audit (original error, repair attempt,
  // repair outcome, final validation, needs_human_review). Observability-only.
  fidelity: FidelityRepairAudit | null;
  // True when the pilot draft became pending WITH an unresolved omission warning.
  needs_human_review: boolean;
  // True when the targeted source was resolved via the URL-scoped human-authorized
  // Radar bypass (synthetic transient source) rather than a registered news_source.
  authorized_source_bypass: boolean;
};

type Draft = {
  title: string;
  excerpt: string;
  body: string;
  category_slug: string | null;
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
  // E1.2 semantic-dedup audit metadata (all nullable; only set on duplicates).
  duplicate_of_content_id: string | null;
  similarity_score: number | null;
  dedupe_method: string | null;
  matched_title: string | null;
  selected_final_domain: string | null;
  // E1.3C writer-routing audit (all nullable; only set once a candidate reaches
  // the writing stage). Requires the additive columns from migration
  // 20260804120000_ingestion_decisions_writer_audit.sql.
  writing_profile: string | null;
  writer_primary_model: string | null;
  writer_model_used: string | null;
  writer_fallback_used: boolean | null;
  writer_prompt_version: string | null;
  writer_validation_reason: string | null;
  // E1.3D verified-source extraction audit (all nullable; only set on a pilot
  // candidate that reached the source-text stage). Requires the additive columns
  // from migration 20260805120000_ingestion_decisions_source_extraction.sql.
  source_extraction_method: string | null;
  source_char_count: number | null;
  source_word_count: number | null;
};

// Optional dedup audit fields attached to a decision (E1.2).
type DedupeMeta = {
  duplicate_of_content_id?: string | null;
  similarity_score?: number | null;
  dedupe_method?: string | null;
  matched_title?: string | null;
  selected_final_domain?: string | null;
};


// ---- Event Registry POST (Radar exact-article fallback only) -------------
//
// A FIXED trusted host we own the request to (never operator-supplied), so the
// SSRF host-validation that guards fetchSourceText does not apply: Event
// Registry itself fetches the target and returns the stored/extracted body. The
// apiKey is folded in here and never passed to the pure erSourceFallback module.
// Used ONLY on the admin-authorized Radar publish path (see runIngestion).
const ER_HOST = "https://eventregistry.org";
// ER performs its own remote extraction, so allow more headroom than the direct
// single-page fetch while staying bounded.
const ER_FETCH_TIMEOUT_MS = 15000;
function denoErPost(apiKey: string): ErPost {
  return async (path, body) => {
    const res = await fetch(ER_HOST + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, apiKey }),
      signal: AbortSignal.timeout(ER_FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Leave json null; the caller treats an unparseable body as unavailable.
    }
    return { status: res.status, ok: res.ok, json };
  };
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
// ---- Official-asset retrieval (bounded, SSRF-safe) ----------------------
//
// For the Content editor's «صورة من المصدر الرسمي» path: given URLs ALREADY
// linked to an article (its source_url / content_sources — never open-web
// discovery), inspect each authoritative page and surface its author-declared
// hero/brand image (og:image / twitter:image / og:logo) as a selectable cover
// candidate. Reuses the SAME SSRF hardening as source extraction (blocked-host
// list + DNS resolution check) — no duplicated security logic, no crawling.

// NOTE: a URL linked to an article (content_sources / source_url) is a
// SOURCE page (often a news outlet like CNN/Reuters), NOT necessarily the
// entity's official website. We therefore do NOT claim officialness: assets are
// typed neutrally as a source-page image or a source-page logo, and attribution
// names the source page they came from.
type OfficialAsset = {
  imageUrl: string;
  sourceUrl: string;
  sourceName: string;
  assetType: "source_image" | "source_logo";
  attribution: string;
};

/** Conservative reject of obviously-unsuitable images (favicons, sprites,
 *  tracking pixels, tiny icons, vector icons, data URIs). We only ever read
 *  author-declared meta images to begin with, so this is a belt-and-suspenders. */
function isUsableAssetImage(u: string): boolean {
  const low = u.toLowerCase();
  if (low.startsWith("data:")) return false;
  if (/\.svg(\?|#|$)/.test(low)) return false;
  if (/\.ico(\?|#|$)/.test(low)) return false;
  if (/favicon|sprite|spacer|tracking|beacon|1x1|pixel\.|\/pixel/.test(low)) return false;
  if (/(^|[^0-9])(16x16|24x24|32x32|48x48)([^0-9]|$)/.test(low)) return false;
  return true;
}

/** Fetch ONE already-known authoritative page and return its declared official
 *  image(s). SSRF-safe: http(s) only, blocked-host check, and a DNS-resolution
 *  classification that must be "safe" before any fetch. Best-effort — any
 *  failure (blocked, unreachable, no image) yields []. */
async function fetchOfficialAssetsFrom(
  url: string,
  label: string,
  resolveDns: (h: string) => Promise<string[]>,
): Promise<OfficialAsset[]> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return [];
  if (isBlockedHostname(u.hostname)) return [];
  // BUG FIX (pre-existing): validateResolvedAddresses returns {ok} — the old
  // `cls !== "safe"` string comparison was always true, so this helper ALWAYS
  // returned [] and official-asset extraction silently never worked. The SSRF
  // gate semantics are unchanged: any resolution failure still fails closed.
  const cls = await validateResolvedAddresses(u.hostname, resolveDns).catch(
    () => ({ ok: false as const, reason: "source_dns_resolution_failed" as const }),
  );
  if (!cls.ok) return [];

  let html: string;
  try {
    const res = await fetch(u.href, {
      headers: { "User-Agent": NEUTRAL_USER_AGENT },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!res.ok) return [];
    if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) return [];
    html = (await res.text()).slice(0, 200000);
  } catch {
    return [];
  }

  const name = label || u.hostname.replace(/^www\./, "");
  const grab = (re: RegExp): string | undefined => html.match(re)?.[1];
  const out: OfficialAsset[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined, assetType: OfficialAsset["assetType"]) => {
    if (!raw) return;
    let abs: string;
    try {
      abs = new URL(raw.trim(), u.href).href;
    } catch {
      return;
    }
    if (seen.has(abs) || !isUsableAssetImage(abs)) return;
    seen.add(abs);
    out.push({ imageUrl: abs, sourceUrl: u.href, sourceName: name, assetType, attribution: name });
  };

  // Hero image (page-author declared) — preferred.
  push(
    grab(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i) ??
      grab(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      grab(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i),
    "source_image",
  );
  push(grab(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i), "source_image");
  // A declared logo on the source page — supporting fallback only.
  push(grab(/<meta[^>]+property=["']og:logo["'][^>]+content=["']([^"']+)["']/i), "source_logo");
  return out;
}

/** Extract official assets from a bounded set of already-known authoritative
 *  URLs. Deduped by image URL; capped. Never throws into the request path. */
async function extractOfficialAssets(
  items: { url: string; label: string }[],
  resolveDns: (h: string) => Promise<string[]>,
): Promise<OfficialAsset[]> {
  const seenUrls = new Set<string>();
  const targets = items
    .filter((it) => it.url && !seenUrls.has(it.url) && seenUrls.add(it.url))
    .slice(0, 8);
  const results = await Promise.all(
    targets.map((t) => fetchOfficialAssetsFrom(t.url, t.label, resolveDns).catch(() => [])),
  );
  const out: OfficialAsset[] = [];
  const seenImg = new Set<string>();
  for (const arr of results) {
    for (const a of arr) {
      if (seenImg.has(a.imageUrl)) continue;
      seenImg.add(a.imageUrl);
      out.push(a);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/** Trim a possibly-unknown value to a non-empty string, else null. */
function asTrimmedTop(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

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
- صنّف كل خبر في قسم واحد رئيسي (category_slug) من: ${validCategories.join(", ")}.
  حدّد أولاً الطبيعة التحريرية الجوهرية للخبر، ثم طبّق هذا الترتيب في الأسبقية:
  1) dawi-news: فقط إذا كان الخبر تحديداً عن "داوي" (منتجاتها، شراكاتها، إطلاقاتها، إعلاناتها، مبادراتها، أو تطوّرات الشركة). مجرّد أن يكون الخبر منشوراً أو مصدره داوي لا يجعله dawi-news.
  2) investigations: فقط للأخبار الاستقصائية فعلاً، القائمة على الأدلة، أو تقارير المساءلة/الكشف. لا تستخدمه لمجرّد أنّ المقال طويل.
  3) health-economy: إذا كان جوهر الخبر اقتصاد/أعمال القطاع الصحي (استحواذات، اندماجات، استثمارات، تمويل، أسواق صحية، أعمال الأدوية/التقنية الحيوية، أعمال المستشفيات، اقتصاد التأمين، نتائج مالية، استراتيجية شركة، شراكات تجارية كبرى). هذا القسم يتقدّم على الجغرافيا حين تكون الطبيعة الاقتصادية/التجارية هي محور الخبر — مثال: صفقة استحواذ دوائية أميركية تُصنّف health-economy لا world.
  4) lifestyle: للصحة الشخصية العملية، والعافية، والوقاية، والتغذية، والرياضة، والنوم، وصحة الحياة اليومية، والمواضيع الموجّهة للقارئ.
  5) الأقسام الجغرافية: للأخبار الطبية/الصحة العامة/الصحية الاعتيادية التي لا تنتمي أساساً لأحد الأقسام الموضوعية أعلاه — محورها الكويت → kuwait؛ محورها دولة خليجية أخرى أو شأن خليجي عام → gulf؛ دولية/خارج الخليج → world.
  قواعد حاسمة: ذكرٌ عابر للكويت لا يجعل الخبر kuwait، وذكرٌ عابر لدولة خليجية لا يجعله gulf. حدّد ما يدور حوله الخبر أساساً بالاعتماد على العنوان والموجز والنص المتاح والمصدر والجهات والشركات والجغرافيا، لا على مطابقة كلمات مفتاحية سطحية. اختر قسماً رئيسياً واحداً فقط.
  إذا كانت الثقة منخفضة فعلاً، اترك category_slug فارغاً (null) بدل التخمين؛ سيراجعه المحرّر البشري يدوياً.
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
      // Empty/omitted → null (genuinely low confidence; admin classifies it in
      // the inbox). A non-empty but INVALID slug is still coerced to the
      // fallback so we never write a dangling category_slug that fails the FK.
      category_slug: String(o.category_slug ?? "").trim() === ""
        ? null
        : validCategories.includes(String(o.category_slug))
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
  opts: {
    trigger?: "manual" | "cron";
    perRegion?: number;
    writerMode?: WriterMode;
    pilotLimit?: number | null;
    // E1.3F targeted single-article pilot: an operator-supplied source URL,
    // honored ONLY in pilot mode. Its hostname must match an active, registered,
    // final_source_allowed source (verified below against the loaded registry);
    // ignored entirely in legacy mode.
    targetedSourceUrl?: string | null;
    // Radar one-click publish: the EXACT admin-authorized article URL permitted
    // to bypass the news_sources registry (URL-scoped human authorization). Only
    // set by the entrypoint for an authenticated manual trigger; when it equals
    // targetedSourceUrl the pilot may fetch that one URL via a transient synthetic
    // source. Cron/legacy runs never receive it, so they can never bypass.
    radarAuthorizedUrl?: string | null;
    // Radar exact-article source fallback identifiers (from the TRUSTED radar row,
    // never free text). Honored ONLY when radarAuthorizedUrl is set. provider must
    // be "eventregistry"; providerUri is the stored ER article uri used for the
    // exact-article stored-body recovery; sourceTitle is the ORIGINAL publisher
    // name (e.g. "CNN International") preserved as the editorial source.
    radarErProvider?: string | null;
    radarErProviderUri?: string | null;
    radarSourceTitle?: string | null;
    // Source language (ISO code) from the TRUSTED radar row, honored ONLY with a
    // valid radarAuthorizedUrl. Feeds locale-aware numeric grounding so a European
    // source's period-thousands / comma-decimals are read correctly. Cron/legacy
    // never set it → the validator uses the English-convention default.
    radarSourceLang?: string | null;
    // Evidence Intelligence analyzer for an ESL promotion (bounded: ≤ the daily
    // cap of stories, cached per canonical cluster). Runs over the SAME verified
    // source text the Writer is grounded in, ONLY for the exact authorized URL.
    // Null/absent (all non-ESL paths) → the pipeline is byte-for-byte unchanged.
    evidenceAnalyzer?: ((verified: SourceText) => Promise<EvidenceOutcome | null>) | null;
  } = {},
): Promise<RunStats & { pilot?: PilotReport }> {
  const trigger = opts.trigger ?? "manual";
  const perRegion = Math.min(Math.max(opts.perRegion ?? 3, 1), 5);
  // Controlled-pilot gate: "legacy" (the unchanged pre-pilot path the scheduled
  // cron uses) inserts the discovery draft directly — no source fetch, no Salma
  // writer. "pilot" runs the E1.3C/D verified-source writer. Defaults to legacy
  // so any caller that does not explicitly (and authorizedly) opt in is legacy.
  const writerMode: WriterMode = opts.writerMode ?? "legacy";
  // E1.3E single-article cap. In pilot mode the run processes at most this many
  // candidates that REACH the source-fetch stage (the entrypoint only ever lets
  // pilotLimit=1 through). null in legacy mode → no cap, unchanged behavior.
  const pilotLimit: number | null = writerMode === "pilot" ? (opts.pilotLimit ?? 1) : null;
  // E1.3F: the targeted-pilot URL is honored ONLY in pilot mode; legacy/cron
  // runs ignore it so the scheduled path can never be steered to an arbitrary URL.
  const targetedSourceUrl: string | null = writerMode === "pilot" ? (opts.targetedSourceUrl ?? null) : null;
  // Honored ONLY in pilot mode; the entrypoint additionally restricts it to an
  // authenticated manual trigger. Never consulted in legacy/cron runs.
  const radarAuthorizedUrl: string | null = writerMode === "pilot" ? (opts.radarAuthorizedUrl ?? null) : null;
  // Radar exact-article ER fallback, built ONCE. Available ONLY when: pilot mode,
  // a URL-scoped Radar authorization exists, the provider is Event Registry, and
  // the ER key is configured. null in every other path → the direct fetch is the
  // sole source (unchanged behavior). This closure NEVER searches ER; it recovers
  // only the body of the exact authorized article (by provider_uri, then by URL).
  const erApiKey = Deno.env.get("EVENTREGISTRY_API_KEY") ?? "";
  const radarSourceTitle = radarAuthorizedUrl ? (opts.radarSourceTitle ?? null) : null;
  const radarErFetch: ((url: string, sourceName: string | null) => Promise<SourceFetchResult>) | null =
    radarAuthorizedUrl && erApiKey && opts.radarErProvider === "eventregistry"
      ? (url, sourceName) =>
        fetchErArticleSource({
          erPost: denoErPost(erApiKey),
          providerUri: opts.radarErProviderUri ?? null,
          url,
          sourceName,
        })
      : null;
  // Live pilot counters, mutated as the single candidate is processed; assembled
  // into the returned PilotReport after finalize. null in legacy mode.
  const pilot: PilotReport | null = writerMode === "pilot"
    ? {
      writer_mode: "pilot",
      pilot_limit: pilotLimit ?? 1,
      candidates_considered: 0,
      source_fetches_attempted: 0,
      writer_calls_attempted: 0,
      fallback_calls_attempted: 0,
      writer_attempts: 1,
      writer_second_attempt: "none",
      pending_articles_created: 0,
      rejection_reason: null,
      created_content_id: null,
      editorial: null,
      editor_prompt_version: null,
      fidelity: null,
      needs_human_review: false,
      authorized_source_bypass: false,
    }
    : null;

  // Fail fast on a misconfigured writer route (empty or forbidden model) before
  // any discovery/model call — never silently route to the wrong model. The
  // editorial-director model is asserted on the same rule (independent config).
  assertWriterConfig(WRITER_CONFIG);
  assertEditorConfig(EDITOR_MODEL);

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
  // `chosen` candidate (when accepted) determines the domain/tier/trust logged;
  // `meta` carries optional E1.2 semantic-dedup audit fields.
  const logDecision = (
    draft: Draft,
    chosen: Candidate | null,
    accepted: boolean,
    reason: DecisionReason | string | null,
    meta: DedupeMeta = {},
    writer: WriterAudit = {},
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
      duplicate_of_content_id: meta.duplicate_of_content_id ?? null,
      similarity_score: meta.similarity_score ?? null,
      dedupe_method: meta.dedupe_method ?? null,
      matched_title: meta.matched_title ?? null,
      selected_final_domain: meta.selected_final_domain ?? null,
      writing_profile: writer.writing_profile ?? null,
      writer_primary_model: writer.writer_primary_model ?? null,
      writer_model_used: writer.writer_model_used ?? null,
      writer_fallback_used: writer.writer_fallback_used ?? null,
      writer_prompt_version: writer.writer_prompt_version ?? null,
      writer_validation_reason: writer.writer_validation_reason ?? null,
      source_extraction_method: writer.source_extraction_method ?? null,
      source_char_count: writer.source_char_count ?? null,
      source_word_count: writer.source_word_count ?? null,
    });
  };

  // A candidate that survived editorial + source selection and is ready to be
  // considered for insertion. Carries its citation-verified candidate set so
  // secondary sources can be preserved when it wins a duplicate cluster.
  type PendingItem = {
    draft: Draft;
    chosen: Candidate;
    candidates: Candidate[];
    citation: Citation;
    key: string;
  };

  const storyTextOf = (draft: Draft): StoryText => ({
    title: draft.title,
    originalTitle: draft.original_title,
    excerpt: draft.excerpt,
  });

  // E1.3F — build the synthetic, discovery-less draft for a targeted pilot. It
  // carries NO editorial text or scores from any caller: title/excerpt/body/
  // original_title stay EMPTY so nothing manually supplied is ever treated as a
  // fact (the writer is grounded solely in the fetched source text), and the
  // editorial/PR scores are 0 because no model classified this story. The only
  // operator input is the URL (as the source pointer); the category is derived
  // conservatively from registry metadata (the matched source's region), falling
  // back to "world". Used only when resolveTargetedSource accepted the URL.
  const buildTargetedDraft = (url: string, source: RegistrySource | null): Draft => {
    const region = source?.region ?? "";
    const category_slug = validCategories.includes(region)
      ? region
      : validCategories.includes("world")
      ? "world"
      : validCategories[0];
    return {
      title: "",
      excerpt: "",
      body: "",
      category_slug,
      read_minutes: 0,
      relevance_score: 0,
      original_title: "",
      source_url: url,
      primary_source_url: url,
      secondary_source_urls: [],
      published_date: null,
      editorial_value_score: 0,
      institutional_pr_score: 0,
      rejection_reason: null,
    };
  };

  // Phase 1 (pure): run the editorial gate + source selection for one draft.
  // Rejections are logged/counted immediately; survivors become PendingItems.
  // No DB writes here so the whole run can be clustered before any insert.
  const evaluateDraft = (
    draft: Draft,
    citations: Map<string, Citation>,
  ): PendingItem | null => {
    stats.found++;

    // The model already judged this a promotional/ceremonial non-story.
    if (draft.rejection_reason) {
      logDecision(draft, null, false, draft.rejection_reason);
      stats.filtered++;
      return null;
    }

    // Deterministic backstop over the model: a high-PR / low-editorial release
    // is rejected even if the model tried to keep it.
    if (failsPrGate(draft.editorial_value_score, draft.institutional_pr_score)) {
      logDecision(draft, null, false, "ceremonial_or_promotional");
      stats.filtered++;
      return null;
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
      return null;
    }
    const chosen = pick.chosen;
    const key = dedupeKeyFromUrl(chosen.url)!;
    const citation = citations.get(key)!;
    return { draft, chosen, candidates, citation, key };
  };

  // Insert one representative draft as a pending editorial draft. `supporting`
  // holds extra candidate URLs (its own secondaries plus the final URLs of the
  // same-run duplicates it represents) preserved as context sources — never
  // merged into the body. Safe to run concurrently: the unique dedupe_key index
  // turns any residual same-key race into a counted duplicate.
  const insertRepresentative = async (
    item: PendingItem,
    supporting: Candidate[],
    written: { article: { title: string; excerpt: string; body: string; summary?: string }; readMinutes: number; audit: WriterAudit },
    meta: DedupeMeta = {},
  ): Promise<string | null> => {
    const { draft, chosen, citation, key } = item;
    const finalUrl = chosen.url;
    const sourceName =
      chosen.source?.name || citation.title || new URL(citation.url).host.replace(/^www\./, "");
    const coverImage = await fetchCoverImage(citation.url);

    // FINAL stored article is the validated writer output, NOT the raw
    // discovery draft. read_minutes is recomputed from the final Arabic body.
    const article = written.article;
    const slug = `${slugify(article.title)}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      title: article.title,
      slug,
      type: "news",
      status: DRAFT_STATUS,
      origin: "ai",
      category_slug: draft.category_slug,
      excerpt: article.excerpt || null,
      ai_summary: article.summary || null,
      body: article.body || null,
      read_minutes: written.readMinutes,
      relevance_score: draft.relevance_score,
      original_title: draft.original_title || null,
      original_url: citation.url,
      source_name: sourceName,
      source_url: finalUrl,
      cover_image_url: coverImage,
      // The ORIGINAL publisher image, persisted independently of the cover so it
      // stays selectable as «الصورة الأصلية» even after an AI/upload replaces the
      // cover. Never modified by later cover changes.
      source_image_url: coverImage,
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
        logDecision(draft, chosen, false, "duplicate_url", meta, written.audit);
        stats.duplicates++;
      } else {
        logDecision(draft, chosen, false, null, meta, written.audit);
        stats.filtered++;
      }
      return null;
    }

    const contentId = (data as { id: string }).id;
    // Primary source first, then any distinct supporting citations for context.
    const sourceRows = [{ content_id: contentId, label: sourceName, url: finalUrl }];
    const sourceSeen = new Set<string>([finalUrl]);
    for (const c of [...item.candidates, ...supporting]) {
      if (sourceSeen.has(c.url)) continue;
      sourceSeen.add(c.url);
      sourceRows.push({
        content_id: contentId,
        label: c.source?.name || new URL(c.url).host.replace(/^www\./, ""),
        url: c.url,
      });
    }
    await db.from("content_sources").insert(sourceRows);
    logDecision(draft, chosen, true, null, meta, written.audit);
    createdIds.push(contentId);
    stats.kept++;
    return contentId;
  };

  // Fetch + evaluate each region concurrently (network-bound), returning the
  // survivors. Clustering across the whole run happens after all regions gather.
  const gatherRegion = async (region: string): Promise<PendingItem[]> => {
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
      return [];
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
      return [];
    }

    const pending: PendingItem[] = [];
    for (const draft of sanitize(parsed.items, validCategories)) {
      const item = evaluateDraft(draft, citations);
      if (item) pending.push(item);
    }
    return pending;
  };

  // Recent news content for the semantic existing-content comparison. Scope is
  // deliberately ORIGIN-AGNOSTIC: published, pending, and draft news items are
  // all included (regardless of origin) so the agent cannot recreate a story an
  // editor already wrote by hand. Non-news types and soft-deleted rows are
  // excluded. A bounded 14-day lookback + row cap keeps this a small, indexed
  // scan; older stories are still protected from exact-URL repeats by the
  // per-item dedupe_key point lookup below.
  type RecentContent = { id: string; title: string; original_title: string | null };
  const loadRecentContent = async (): Promise<RecentContent[]> => {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { data } = await db
        .from("content")
        .select("id,title,original_title")
        .eq("type", "news")
        .is("deleted_at", null)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500);
      return (data as RecentContent[] | null) ?? [];
    } catch {
      return [];
    }
  };

  // Phase 3: for a cluster representative, reject if it repeats stored content —
  // first by exact dedupe_key (any age), then by semantic title match against
  // the recent window — otherwise insert it as a pending draft.
  const commitRepresentative = async (
    item: PendingItem,
    supporting: Candidate[],
    recent: RecentContent[],
  ): Promise<{ reachedFetchStage: boolean; result: string | null }> => {
    const { draft, chosen, key } = item;

    // Exact URL repeat (indexed point lookup, not time-bounded).
    const { data: existing } = await db
      .from("content")
      .select("id")
      .eq("dedupe_key", key)
      .maybeSingle();
    if (existing) {
      const existingId = (existing as { id: string }).id;
      logDecision(draft, chosen, false, "duplicate_existing_content", {
        duplicate_of_content_id: existingId,
        dedupe_method: "exact_url",
        selected_final_domain: hostFromUrl(chosen.url),
      });
      stats.duplicates++;
      return { reachedFetchStage: false, result: existingId };
    }

    // Semantic repeat against recent stored content (origin-agnostic).
    const text = storyTextOf(draft);
    for (const r of recent) {
      const verdict = storyDuplicate(text, { title: r.title, originalTitle: r.original_title });
      if (verdict.duplicate) {
        logDecision(draft, chosen, false, "duplicate_semantic_existing", {
          duplicate_of_content_id: r.id,
          similarity_score: verdict.score,
          dedupe_method: verdict.method,
          matched_title: r.title,
          selected_final_domain: hostFromUrl(chosen.url),
        });
        stats.duplicates++;
        return { reachedFetchStage: false, result: r.id };
      }
    }

    // Legacy path (pilot gate): the scheduled cron and any non-pilot caller keep
    // the exact pre-pilot behavior — insert the discovery draft as the pending
    // AI draft, with NO source fetch and NO Salma writer call. The stored
    // status/origin/type are identical to the pilot path (pending / ai / news);
    // only the body provenance differs. The writer audit stays empty so the
    // legacy cron audit trail is unchanged.
    if (writerMode === "legacy") {
      const legacyWritten = {
        article: { title: draft.title, excerpt: draft.excerpt, body: draft.body },
        readMinutes: draft.read_minutes,
        audit: {} as WriterAudit,
      };
      const legacyId = await insertRepresentative(item, supporting, legacyWritten);
      return { reachedFetchStage: false, result: legacyId };
    }

    // Source-text stage (E1.3D, pilot only): the story has passed editorial +
    // source selection, same-run representative selection, and BOTH existing-content
    // dedup checks. Only now — for the ONE final, registered, final_source_allowed
    // URL — do we fetch and extract the real source page. pickFinalSource(_, true)
    // guarantees chosen.source is a registered final source with a domain; the
    // fetch is SSRF-validated against exactly that domain (see fetchSourceText).
    const registeredDomain = chosen.source?.domain ?? null;
    if (!registeredDomain) {
      // Defensive: a final source without a domain cannot be safely fetched.
      // This is BEFORE the fetch stage, so it does NOT consume the single pilot
      // slot — the bounded loop moves on to the next representative.
      logDecision(draft, chosen, false, "source_text_unavailable");
      stats.filtered++;
      return { reachedFetchStage: false, result: null };
    }

    // FETCH STAGE reached (E1.3E): from here this candidate consumes the single
    // pilot slot even if extraction/writing then fails. Counted before the fetch
    // is attempted so the bounded loop stops after exactly one fetch-stage try.
    if (pilot) pilot.source_fetches_attempted += 1;

    // Writer stage (E1.3C/D): groundedWrite fetches+extracts the verified source
    // text and ONLY THEN calls the writer — exactly once, and never on a
    // fetch/extraction failure. A source-fetch failure creates NO pending draft
    // and NO paid writer call; the discrete source_* reason is recorded on the
    // audit row. The writer/validator are grounded in the extracted source text,
    // never the discovery draft (see writeArticle). A parse/validation failure is
    // likewise a rejection that creates no draft (fallback never runs after a
    // factual validation failure — see orchestrateWriter).
    const grounded = await groundedWrite<WriterOutcome>({
      fetchSource: async () => {
        // Attempt 1 — direct extraction of the ORIGINAL publisher page, with ALL
        // SSRF/DNS/redirect/domain protections intact. This is the ONLY path for
        // every non-Radar candidate and the preferred path for Radar too.
        const direct = await fetchSourceText({
          url: chosen.url,
          registeredDomain,
          sourceName: chosen.source?.name ?? null,
          rawFetch: denoRawFetch,
          // E1.3E: per-hop DNS-resolution SSRF check (see denoResolveDns). A
          // DNS/security failure returns a discrete source_* reason → no writer
          // call, no pending draft, and a rejection audit row (below).
          resolveDns: denoResolveDns,
        });
        if (direct.ok) return direct;
        // Attempt 2 & 3 — admin-authorized Radar exact-article ER fallback, ONLY
        // for the exact authorized URL (chosen.url === radarAuthorizedUrl). ER is
        // a technical fetch provider: it recovers the SAME article's body (by
        // provider_uri, then by exact URL) — never a different/similar story, and
        // never becomes the editorial source. On ER failure we keep the DIRECT
        // failure reason so the audit/UX reflects the original-source outcome.
        if (radarErFetch && chosen.url === radarAuthorizedUrl) {
          const recovered = await radarErFetch(chosen.url, chosen.source?.name ?? null);
          if (recovered.ok) return recovered;
        }
        return direct;
      },
      write: async (verified) => {
        // Evidence Intelligence (ESL promotions only, same scope as the other
        // radar-authorized extras): ONE bounded, cached analysis of the SAME
        // verified source text the Writer sees. Never blocks — a failed or
        // unavailable analysis simply passes no evidence context.
        let evidence: EvidenceOutcome | null = null;
        if (opts.evidenceAnalyzer && chosen.url === radarAuthorizedUrl) {
          evidence = await opts.evidenceAnalyzer(verified);
        }
        return writeArticle({
          verified,
          discovery: {
            originalTitle: draft.original_title,
            body: draft.body,
            excerpt: draft.excerpt,
          },
          sourceName: chosen.source?.name ?? item.citation.title ?? null,
          registeredDomain,
          citationTitles: [item.citation.title].filter((t): t is string => !!t),
          // Locale-aware numeric grounding: the trusted radar-row language, used
          // ONLY for the exact admin-authorized URL (same scope as the ER
          // fallback). Every other candidate passes null → English convention.
          sourceLang: chosen.url === radarAuthorizedUrl ? (opts.radarSourceLang ?? null) : null,
          evidence: evidence?.status === "complete" ? evidence.card : null,
        });
      },
    });
    if (!grounded.ok) {
      // Source fetch/extraction (incl. DNS-security) failed: no writer call, no
      // pending draft. The discrete source_* reason is the pilot's rejection.
      logDecision(draft, chosen, false, grounded.reason);
      stats.filtered++;
      if (pilot) pilot.rejection_reason = grounded.reason;
      return { reachedFetchStage: true, result: null };
    }

    // The writer WAS called (groundedWrite only calls write() on a successful
    // fetch): count exactly one primary writer call, plus one fallback call iff
    // the primary suffered a qualifying technical failure (writer_fallback_used).
    const written = grounded.value;
    if (pilot) {
      pilot.writer_calls_attempted += 1;
      if (written.audit.writer_fallback_used) pilot.fallback_calls_attempted += 1;
      // Surface the writer attempt count + second-attempt type (json_recovery
      // when the one strict-JSON reparse retry fired). Observability only.
      pilot.writer_attempts = written.writerAttempts;
      pilot.writer_second_attempt = written.writerSecondAttempt;
      // The editor + fidelity stages run inside writeArticle on every draft that
      // reached the writer, so surface their audits on BOTH outcomes (a
      // fidelity-stage rejection still ran the editor first — editorial-policy
      // ordering — and carries a fidelity audit).
      if (written.editorial) {
        pilot.editorial = written.editorial;
        pilot.editor_prompt_version = EDITOR_PROMPT_VERSION;
      }
      pilot.fidelity = written.fidelity;
      if (written.ok) pilot.needs_human_review = written.needsHumanReview;
    }
    if (!written.ok) {
      logDecision(draft, chosen, false, written.rejection, {
        selected_final_domain: hostFromUrl(chosen.url),
      }, written.audit);
      stats.filtered++;
      if (pilot) pilot.rejection_reason = written.rejection;
      return { reachedFetchStage: true, result: null };
    }

    const insertedId = await insertRepresentative(item, supporting, written, {
      selected_final_domain: hostFromUrl(chosen.url),
    });
    if (pilot && !insertedId) pilot.rejection_reason = "pending_insert_failed";
    return { reachedFetchStage: true, result: insertedId };
  };

  // Persist the per-candidate audit trail. The run row already exists (created
  // as 'running' below) so the run_id FK always resolves. This is MANDATORY:
  // the returned result reports failure (the supabase client returns { error }
  // rather than throwing) so the caller can refuse to mark the run successful.
  const persistDecisions = async (): Promise<{ ok: boolean; error?: string }> => {
    if (decisions.length === 0) return { ok: true };
    const rows = decisions.map((d) => ({
      ...d,
      run_id: runId,
      model: DEFAULT_MODEL,
      prompt_version: PROMPT_VERSION,
    }));
    try {
      const { error } = await db.from("ingestion_decisions").insert(rows);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // Best-effort rollback used only when the mandatory audit write fails. Deletes
  // exactly the pending AI drafts THIS run created (guarded by selectRollbackTargets
  // — never previously-existing or since-published content); content_sources rows
  // cascade-delete via their `on delete cascade` FK.
  const rollbackCreatedContent = async (): Promise<{ ok: boolean; error?: string }> => {
    if (createdIds.length === 0) return { ok: true };
    try {
      const { data, error: selErr } = await db
        .from("content")
        .select("id,origin,status")
        .in("id", createdIds);
      if (selErr) return { ok: false, error: selErr.message };
      const targets = selectRollbackTargets(
        (data as { id: string; origin: string | null; status: string | null }[] | null) ?? [],
        createdIds,
        DRAFT_STATUS,
      );
      if (targets.length === 0) return { ok: true };
      const { error: delErr } = await db.from("content").delete().in("id", targets);
      if (delErr) return { ok: false, error: delErr.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
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

  type Plan = { rep: PendingItem; members: PendingItem[]; supporting: Candidate[] };

  let phaseError: unknown = null;
  try {
    let plans: Plan[];

    if (targetedSourceUrl) {
      // TARGETED single-article pilot (E1.3F): skip discovery ENTIRELY (no web
      // discovery model call, no clustering) and build exactly ONE representative
      // from the operator-supplied URL — but ONLY when its hostname matches an
      // active, registered, final_source_allowed source. The URL is the sole
      // operator input; no manually-supplied title/body/excerpt/entity/category
      // is trusted (buildTargetedDraft leaves them empty), so the fetched page
      // must supply every fact. An unregistered/blocked/context-only URL is a
      // hard rejection here: no fetch, no writer call, no insert.
      sourcesChecked.add(hostFromUrl(targetedSourceUrl));
      // URL-scoped human-authorized bypass: when the entrypoint marked this exact
      // URL as admin-authorized (radarAuthorizedUrl === targetedSourceUrl), an
      // unregistered host resolves to a TRANSIENT synthetic source scoped to that
      // one URL. Otherwise this is identical to resolveTargetedSource (registry
      // required). SSRF/redirect/DNS protections are unchanged — fetchSourceText
      // still validates every hop against the resolved host.
      const resolved = resolveAuthorizedTargetedSource(
        targetedSourceUrl,
        registry.index,
        radarAuthorizedUrl,
      );
      const key = dedupeKeyFromUrl(targetedSourceUrl);
      if (!resolved.ok || !key) {
        const reason = resolved.ok ? "pilot_source_url_invalid" : resolved.reason;
        logDecision(
          buildTargetedDraft(targetedSourceUrl, null),
          { url: targetedSourceUrl, source: null },
          false,
          reason,
          { selected_final_domain: hostFromUrl(targetedSourceUrl) },
        );
        stats.filtered++;
        if (pilot) pilot.rejection_reason = reason;
        plans = [];
      } else {
        if (pilot) pilot.authorized_source_bypass = resolved.authorized;
        // Preserve the ORIGINAL publisher identity: the URL-scoped synthetic
        // Radar source defaults its name to the bare host (e.g. "edition.cnn.com").
        // When the trusted radar row carries the publisher title (e.g. "CNN
        // International"), use it as the editorial source name so the stored
        // content and its content_sources show the publisher, never the host and
        // never Event Registry. Applied ONLY to the transient authorized source
        // (never a registered news_source, which already has its proper name).
        if (resolved.authorized && resolved.source && radarSourceTitle) {
          resolved.source.name = radarSourceTitle;
        }
        const draft = buildTargetedDraft(targetedSourceUrl, resolved.source);
        const chosen: Candidate = { url: targetedSourceUrl, source: resolved.source };
        const rep: PendingItem = {
          draft,
          chosen,
          candidates: [chosen],
          citation: { url: targetedSourceUrl, title: "" },
          key,
        };
        plans = [{ rep, members: [], supporting: [] }];
      }
    } else {
      // Phase 1: gather every editorial+source survivor across all regions.
      const pendings = (await Promise.all(regions.map(gatherRegion))).flat();

      // Phase 2: cluster same-run duplicates. Each high-confidence cluster yields
      // ONE representative (strongest eligible source); the rest are logged as
      // same-run semantic duplicates and their final URLs preserved as supporting
      // sources on the winner — never as separate drafts.
      //
      // Source ranking deliberately excludes any per-item published_date: the only
      // dates available here come from model output and are unverified, so they
      // must never influence which source wins. tier/trust/final-eligibility/
      // primary-status decide (see betterSource).
      const clusters = clusterStories(pendings, (p) => storyTextOf(p.draft));
      plans = clusters.map((cluster) => {
        const bestIdx = pickBestIndex(cluster.map((p) => ({ source: p.chosen.source })));
        const rep = cluster[bestIdx];
        const members = cluster.filter((_, i) => i !== bestIdx);
        const supporting = members.map((m) => m.chosen);
        return { rep, members, supporting };
      });
    }

    // Phase 3: reject representatives that repeat recent stored content, then
    // insert the rest as pending drafts. The winner is committed FIRST so its
    // canonical content id (whether freshly inserted or the row it matched) can
    // be linked from every same-run duplicate's audit record.
    const recent = await loadRecentContent();
    // Phase-3 processing is bounded for the pilot: processRepresentativesWithLimit
    // stops STARTING new representatives once `pilotLimit` of them have reached the
    // source-fetch stage (limit=1 for the first pilot). In legacy mode the limit is
    // null → every representative is processed, unchanged. A representative rejected
    // BEFORE the fetch stage (a duplicate, or a final source without a domain) does
    // not consume the slot, so the loop keeps looking for the one real pilot candidate.
    const loopResult = await processRepresentativesWithLimit({
      representatives: plans,
      limit: pilotLimit,
      commit: async ({ rep, members, supporting }) => {
        const outcome = await commitRepresentative(rep, supporting, recent);
        for (const dup of members) {
          const verdict = storyDuplicate(storyTextOf(dup.draft), storyTextOf(rep.draft));
          logDecision(dup.draft, dup.chosen, false, "duplicate_semantic_same_run", {
            duplicate_of_content_id: outcome.result,
            similarity_score: verdict.score,
            dedupe_method: verdict.method ?? "semantic_title",
            matched_title: rep.draft.title,
            selected_final_domain: hostFromUrl(rep.chosen.url),
          });
          stats.duplicates++;
        }
        return outcome;
      },
      // Pilot only: representatives after the single slot are deliberately not
      // processed. Record them (and their cluster members) honestly so the audit
      // shows they were deferred by the single-article cap, not silently dropped.
      onSkipped: ({ rep, members }) => {
        logDecision(rep.draft, rep.chosen, false, "pilot_single_article_limit", {
          selected_final_domain: hostFromUrl(rep.chosen.url),
        });
        stats.filtered++;
        for (const dup of members) {
          logDecision(dup.draft, dup.chosen, false, "pilot_single_article_limit");
          stats.filtered++;
        }
      },
    });

    if (pilot) {
      pilot.candidates_considered = loopResult.processed;
      pilot.pending_articles_created = createdIds.length;
      pilot.created_content_id = createdIds[0] ?? null;
    }

  } catch (e) {
    phaseError = e;
  }

  // Finalize: the audit trail is mandatory. finalizeRun always attempts to persist
  // the decisions and decides the terminal state — a failed audit on an otherwise
  // successful run becomes an error (after rolling back this run's created drafts),
  // never a misleading success.
  const final = await finalizeRun({
    phaseError,
    createdIds,
    persist: persistDecisions,
    cleanupCreated: rollbackCreatedContent,
  });
  // E1.3F: mark a targeted pilot at the run level with the registered domain it
  // targeted (never the full URL, never any secret or extracted body). The key
  // is included ONLY for a targeted run, so legacy/cron/ordinary-pilot runs never
  // reference the additive `pilot_source_domain` column (migration-ordering safe:
  // the column must exist before the first targeted pilot, but non-targeted runs
  // are unaffected whether or not it has been applied).
  const runUpdate: Record<string, unknown> = {
    status: final.status,
    error: final.status === "error" ? final.error : null,
    ...stats,
    duration_ms: Date.now() - startedAt,
    sources: [...sourcesChecked],
    created_ids: final.createdIds,
  };
  if (targetedSourceUrl) runUpdate.pilot_source_domain = hostFromUrl(targetedSourceUrl);
  await db.from("ingestion_runs").update(runUpdate).eq("id", runId);

  // Return an error to the caller: re-throw the original phase failure, or raise
  // the mandatory-audit failure so the run is never treated as successful.
  if (phaseError != null) throw phaseError;
  if (final.throwMessage) throw new Error(final.throwMessage);
  // Reaching here means finalizeRun persisted the mandatory audit (it throws
  // otherwise), so the pilot report below is only ever returned for an audited run.
  return pilot ? { ...stats, pilot } : stats;
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

// --- Radar one-click publish: terminal-state ownership ----------------------
//
// For a Radar-authorized one-click publish, THIS Edge Function owns the final
// radar_shadow_articles state transition — it must be written BEFORE the HTTP
// response returns, using the service-role client already created below. This
// closes the failure mode where the Next.js server action was terminated after
// the invoke returned 200, orphaning the row in 'processing'. The server action
// now only latches 'processing' and reads back the terminal state we write.
//
// Two modes, selected by radar_publish_mode:
//   "publish" (default) — the direct one-click path (نشر مباشر).
//   "prepare"           — the editorial preparation path (تحرير في سلمى): create
//                         the Content as `pending`, DON'T publish, leave the Radar
//                         row 'draft' linked to it so a human edits then publishes.
//
// Terminal outcomes:
//   (a) published      — publish mode, content clean AND has a cover image →
//                        flip pending→published.
//   (b) draft          — prepare mode (any content), OR publish mode when the
//                        clean article has NO cover image (graceful fallback to
//                        editorial review — NOT a failure). needs_cover marks the
//                        missing-cover case for the UI.
//   (c) needs_review   — publish mode, a real Content row exists but is not clean
//                        (or was no longer 'pending' at publish time).
//   (d) failed         — the pipeline stopped BEFORE any Content row (source
//                        retrieval / Writer / Editor / Fidelity / validation).
// A duplicate/existing-content match never reaches here: the server action
// blocks it before invoking, so no run is started and no Content is created.
type RadarPublishOutcome =
  | { status: "published"; content_id: string }
  | { status: "draft"; content_id: string; needs_cover: boolean }
  | { status: "needs_review"; content_id: string; reason: string | null }
  | { status: "failed"; reason: string | null };

/** True when the created Content row already carries a non-empty cover image. */
async function contentHasCover(admin: SupabaseClient, contentId: string): Promise<boolean> {
  const { data } = await admin
    .from("content")
    .select("cover_image_url")
    .eq("id", contentId)
    .maybeSingle();
  const url = (data as { cover_image_url?: string | null } | null)?.cover_image_url ?? null;
  return !!(url && String(url).trim());
}

// Write a terminal radar state, but ONLY for the row still owned by this
// authorized run (publish_status = 'processing'). Scoping to 'processing'
// guarantees the Edge Function finalizes exactly the row the server action
// latched for THIS invocation and never mutates an unrelated radar row.
async function setRadarTerminal(
  admin: SupabaseClient,
  radarId: string,
  patch: { publish_status: string; published_content_id: string | null; publish_error: string | null },
): Promise<void> {
  await admin
    .from("radar_shadow_articles")
    .update(patch)
    .eq("id", radarId)
    .eq("publish_status", "processing");
}

/** Validate a category slug against the live categories table; null if unknown. */
async function resolveRadarCategory(admin: SupabaseClient, slug: string | null): Promise<string | null> {
  const s = String(slug ?? "").trim();
  if (!s) return null;
  const { data } = await admin.from("categories").select("slug").eq("slug", s).maybeSingle();
  return data ? s : null;
}

/**
 * Finalize the Radar row for an authorized one-click publish from the pilot
 * outcome, writing the terminal state before the HTTP response returns. This is
 * the SAME terminal decision the server action used to own — moved here so the
 * write survives server-action termination. It changes no editorial safeguard;
 * it only persists the pipeline's already-decided outcome.
 */
async function finalizeRadarPublish(
  admin: SupabaseClient,
  radarId: string,
  pilot: PilotReport | null,
  categorySlugInput: string | null,
  mode: "publish" | "prepare",
): Promise<RadarPublishOutcome> {
  const contentId = pilot?.created_content_id ?? null;

  // (d) No Content row → the pipeline stopped before creation. Retryable failed.
  if (!contentId) {
    const reason = pilot?.rejection_reason ?? "no_content_created";
    await setRadarTerminal(admin, radarId, {
      publish_status: "failed",
      published_content_id: null,
      publish_error: reason,
    });
    return { status: "failed", reason };
  }

  // (b-prepare) Editorial preparation: the pipeline produced a real Content row.
  //     Leave it `pending` and mark the Radar row 'draft' linked to it — never
  //     publish here. `needs_cover` marks a missing cover image for the UI.
  if (mode === "prepare") {
    const needsCover = !(await contentHasCover(admin, contentId));
    await setRadarTerminal(admin, radarId, {
      publish_status: "draft",
      published_content_id: contentId,
      publish_error: needsCover ? "needs_cover" : null,
    });
    return { status: "draft", content_id: contentId, needs_cover: needsCover };
  }

  // (c) Direct publish, content exists but not clean → leave it pending for human
  //     review, and record needs_review WITH the content id (card links to Content).
  const clean = pilot?.needs_human_review === false && pilot?.fidelity?.decision === "clean";
  if (!clean) {
    const reason = pilot?.rejection_reason ?? "needs_human_review";
    await setRadarTerminal(admin, radarId, {
      publish_status: "needs_review",
      published_content_id: contentId,
      publish_error: reason,
    });
    return { status: "needs_review", content_id: contentId, reason };
  }

  // (b-cover) Direct publish of a clean article WITHOUT a cover image → do NOT
  //     publish an image-less article. Fall back to editorial review: keep the
  //     Content `pending`, mark the Radar row 'draft' + needs_cover. This is a
  //     graceful fallback, never a failure — the human adds a cover then publishes.
  if (!(await contentHasCover(admin, contentId))) {
    await setRadarTerminal(admin, radarId, {
      publish_status: "draft",
      published_content_id: contentId,
      publish_error: "needs_cover",
    });
    return { status: "draft", content_id: contentId, needs_cover: true };
  }

  // (a) Clean AND has a cover → apply the optional category, then flip
  //     pending→published. Only a 'pending' row is ever published (mirrors
  //     setStatus); a non-pending row is linked and left for review.
  const categorySlug = await resolveRadarCategory(admin, categorySlugInput);
  const publishPatch: Record<string, unknown> = {
    status: "published",
    published_at: new Date().toISOString(),
  };
  if (categorySlug) publishPatch.category_slug = categorySlug;

  const { data: published } = await admin
    .from("content")
    .update(publishPatch)
    .eq("id", contentId)
    .eq("status", "pending")
    .is("deleted_at", null)
    .select("id");

  if (!published || published.length === 0) {
    await setRadarTerminal(admin, radarId, {
      publish_status: "needs_review",
      published_content_id: contentId,
      publish_error: "content_not_pending",
    });
    return { status: "needs_review", content_id: contentId, reason: "content_not_pending" };
  }

  await setRadarTerminal(admin, radarId, {
    publish_status: "published",
    published_content_id: contentId,
    publish_error: null,
  });
  return { status: "published", content_id: contentId };
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

  // Controlled-pilot gate (E1.3E). Only an AUTHORIZED caller (verified above via
  // the ingest secret or an admin JWT) that EXPLICITLY sends writer_mode:"pilot"
  // AND an explicit pilot_limit of exactly 1 runs the verified-source Salma
  // writer; everything else — including the scheduled cron, which sends no body —
  // stays on the unchanged legacy path. A pilot request with a missing/other/>1
  // pilot_limit is REJECTED (HTTP 400) and performs NO ingestion, rather than
  // silently clamping. Resolving with authorized=true is sound because an
  // unauthorized request already returned 401 above and can never reach here.
  // This does NOT read or change OPENROUTER_MODEL or any writer-model secret.
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  // Bounded official-asset retrieval op (Content editor «صورة من المصدر الرسمي»).
  // Admin-only (never cron), read-only, and scoped to URLs the caller already has
  // for the article (its source/content_sources). Reuses the SSRF-safe fetch and
  // returns declared official images; never runs the ingestion pipeline. Any
  // failure yields an empty list — it must never break the editor.
  if ((body as { op?: unknown })?.op === "source_assets") {
    if (trigger !== "manual") {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const rawUrls = Array.isArray((body as { urls?: unknown }).urls) ? (body as { urls: unknown[] }).urls : [];
    const items = rawUrls
      .map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { url: String(o.url ?? "").trim().slice(0, 2000), label: String(o.label ?? "").trim().slice(0, 160) };
      })
      .filter((it) => it.url)
      .slice(0, 8);
    const assets = await extractOfficialAssets(items, denoResolveDns).catch(() => []);
    return Response.json({ ok: true, assets });
  }

  // Primary Source Escalation — DRY RUN (op:"escalate_source"). Runs the bounded
  // escalation ladder for ONE selected cluster and returns/caches the result
  // WITHOUT creating any Content. This is the safe way to validate escalation on
  // real selected clusters. Read-only; authorized caller only (already gated above).
  if ((body as { op?: unknown })?.op === "escalate_source") {
    const b = body as Record<string, unknown>;
    const discoveryUrl = asTrimmedTop(b.discovery_url);
    const clusterKey = asTrimmedTop(b.cluster_key);
    if (!discoveryUrl || !clusterKey) {
      return Response.json({ ok: false, error: "cluster_key and discovery_url required" }, { status: 400 });
    }
    const result = await runEscalation(admin, {
      clusterKey,
      storyType: asTrimmedTop(b.story_type) ?? "general",
      discoveryUrl,
      discoveryDomain: asTrimmedTop(b.discovery_domain) ?? escDomainOf(discoveryUrl),
      title: asTrimmedTop(b.title),
      titleAr: asTrimmedTop(b.title_ar),
    });
    return Response.json({ ok: true, escalation: result });
  }

  // Evidence Intelligence — DRY RUN (op:"analyze_evidence"). Fetches ONE source
  // page (same hardened SSRF-safe path the pipeline uses), runs the bounded
  // structured evidence analysis and returns the card WITHOUT creating any
  // Content. persist:true additionally writes the per-cluster cache/audit row
  // (so a validated real cluster is not re-analyzed at promotion time).
  // Authorized caller only (already gated above).
  if ((body as { op?: unknown })?.op === "analyze_evidence") {
    const b = body as Record<string, unknown>;
    const url = asTrimmedTop(b.url);
    const clusterKey = asTrimmedTop(b.cluster_key);
    if (!url || !clusterKey) {
      return Response.json({ ok: false, error: "cluster_key and url required" }, { status: 400 });
    }
    const persist = b.persist === true;
    const storyType = asTrimmedTop(b.story_type) ?? "general";

    // use_escalation:true mirrors the LIVE promotion path: run/reuse the cached
    // escalation for this cluster (url = the discovery URL), then resolve the
    // strongest FETCHABLE source (primary → supporting → discovery) exactly as
    // a real promotion would, recording the fallback provenance.
    let resolved: ResolvedEvidenceSource = { kind: "primary", url, primaryUrl: null };
    if (b.use_escalation === true) {
      const esc = await runEscalation(admin, {
        clusterKey,
        storyType,
        discoveryUrl: url,
        discoveryDomain: escDomainOf(url),
        title: asTrimmedTop(b.title),
        titleAr: asTrimmedTop(b.title_ar),
      });
      if (esc.status === "upgraded" && /^https?:\/\//i.test(esc.selected_editorial_source.url)) {
        resolved = await resolveAnalysisSource(esc, url);
      }
    }

    const fetched = await fetchSourceText({
      url: resolved.url,
      registeredDomain: escDomainOf(resolved.url),
      sourceName: null,
      rawFetch: denoRawFetch,
      resolveDns: denoResolveDns,
    });
    if (!fetched.ok) {
      return Response.json({ ok: false, error: fetched.reason, analysis_source: resolved }, { status: 422 });
    }
    const db = evidenceDbDeps(admin);
    const outcome = await analyzeEvidence(
      {
        clusterKey,
        storyType,
        sourceUrl: fetched.finalUrl,
        sourceDomain: escDomainOf(fetched.finalUrl),
        sourceTitle: fetched.title || null,
        sourceText: fetched.text,
        sourceKind: resolved.kind,
        editorialPrimaryUrl: resolved.primaryUrl,
      },
      {
        cacheGet: persist ? db.cacheGet : async () => null,
        cachePut: persist ? db.cachePut : async () => {},
        chat: chatEvidence,
      },
    );
    return Response.json({ ok: true, evidence: outcome, analysis_source: resolved, source_chars: fetched.charCount });
  }

  const gate = resolvePilotGate({
    authorized: true,
    requestedMode: (body as { writer_mode?: unknown })?.writer_mode,
    requestedLimit: (body as { pilot_limit?: unknown })?.pilot_limit,
    // E1.3F: an optional targeted source URL, honored ONLY for an authorized
    // pilot (limit=1). A legacy/cron/default request never reaches the pilot
    // branch of the gate, so pilot_source_url is ignored there. A supplied-but-
    // unusable URL is a hard gate rejection (HTTP 400, no ingestion).
    requestedSourceUrl: (body as { pilot_source_url?: unknown })?.pilot_source_url,
  });
  if (gate.mode === "rejected") {
    // No ingestion runs: a malformed pilot request must not fall through to a run.
    return Response.json({ ok: false, error: gate.reason }, { status: 400 });
  }
  const writerMode: WriterMode = gate.mode === "pilot" ? "pilot" : "legacy";
  const pilotLimit = gate.mode === "pilot" ? gate.limit : null;
  const targetedSourceUrl = gate.mode === "pilot" ? (gate.sourceUrl ?? null) : null;

  // ESL scheduled promotion: the Editorial Selection Layer runs server-side under
  // the ingest secret (trigger "cron") and, like the admin one-click path, hands
  // us the EXACT article URL + identifiers read from the TRUSTED
  // radar_shadow_articles row (never operator free text). It opts in with
  // op:"esl_promote"; a plain/legacy cron (no op) is unaffected and can still
  // never bypass the registry.
  const eslPromote = trigger === "cron" && (body as { op?: unknown })?.op === "esl_promote";

  // Radar one-click publish: URL-scoped authorization to fetch an unregistered
  // source. Granted ONLY when ALL hold: an authorized promoter — either an ADMIN
  // JWT (trigger "manual") or the ESL cron promotion (eslPromote) — an explicit
  // radar_authorized_source === true flag, and a resolved targeted pilot URL. The
  // authorization is scoped to exactly that URL — runIngestion mints the transient
  // synthetic source only when the pilot URL equals this value. A generic cron run
  // (no op:"esl_promote") can never reach this branch and never bypasses the
  // registry.
  const radarAuthorizedFlag = (body as { radar_authorized_source?: unknown })?.radar_authorized_source === true;
  const radarAuthorizedUrl = (trigger === "manual" || eslPromote) && radarAuthorizedFlag && targetedSourceUrl
    ? targetedSourceUrl
    : null;

  // Radar exact-article fallback identifiers, honored ONLY alongside a valid
  // URL-scoped authorization (same admin-manual + flag + resolved-URL scope).
  // These come from the TRUSTED radar_shadow_articles row (the server action
  // reads them from the DB, never from operator free text): provider selects the
  // fetch provider, provider_uri is the exact ER article id for the same-article
  // stored-body recovery, and source_title is the original publisher preserved as
  // the editorial source. A non-Radar/cron request never sets any of them.
  const asTrimmed = (v: unknown): string | null => {
    const s = String(v ?? "").trim();
    return s ? s : null;
  };
  const radarErProvider = radarAuthorizedUrl ? asTrimmed((body as { radar_provider?: unknown })?.radar_provider) : null;
  const radarErProviderUri = radarAuthorizedUrl
    ? asTrimmed((body as { radar_provider_uri?: unknown })?.radar_provider_uri)
    : null;
  const radarSourceTitle = radarAuthorizedUrl
    ? asTrimmed((body as { radar_source_title?: unknown })?.radar_source_title)
    : null;
  // Source language (ISO code) from the trusted radar row, for locale-aware
  // numeric grounding. Honored ONLY alongside a valid URL-scoped authorization.
  const radarSourceLang = radarAuthorizedUrl
    ? asTrimmed((body as { radar_source_lang?: unknown })?.radar_source_lang)
    : null;
  // Radar publish mode: "prepare" (تحرير في سلمى — create a draft for editing,
  // never publish here) vs "publish" (نشر مباشر — the direct one-click path).
  // Defaults to "publish" so existing callers are unchanged.
  const radarPublishMode: "publish" | "prepare" =
    (body as { radar_publish_mode?: unknown })?.radar_publish_mode === "prepare" ? "prepare" : "publish";

  // Radar row to finalize (terminal-state ownership). Present ONLY for an
  // authorized Radar one-click publish; a generic/cron/pilot request leaves it
  // null and this function never touches any radar row. radar_category_slug is
  // the optional operator category override, validated against categories.
  const radarArticleId = radarAuthorizedUrl
    ? asTrimmed((body as { radar_article_id?: unknown })?.radar_article_id)
    : null;
  const radarCategorySlug = radarArticleId
    ? asTrimmed((body as { radar_category_slug?: unknown })?.radar_category_slug)
    : null;

  // Primary Source Escalation (LIVE, ESL promotion only). Try to upgrade the
  // discovery source to a stronger, story-type-appropriate PRIMARY before the
  // Writer runs. Bounded + cached; any failure keeps the discovery source. This
  // never changes WHETHER we publish (still PENDING) — only WHICH source is the
  // Writer's primary. The discovery URL is preserved in provenance below.
  const bodyRec = body as Record<string, unknown>;
  let escalation: EscalationResult | null = null;
  let evidenceOutcome: EvidenceOutcome | null = null;
  let evidenceClusterKey: string | null = null;
  let evidenceResolved: ResolvedEvidenceSource | null = null;
  let evidenceAnalyzer: ((verified: SourceText) => Promise<EvidenceOutcome | null>) | null = null;
  let effSourceUrl = targetedSourceUrl;
  let effAuthorizedUrl = radarAuthorizedUrl;
  let effErProvider = radarErProvider;
  let effErProviderUri = radarErProviderUri;
  let effSourceTitle = radarSourceTitle;
  let effSourceLang = radarSourceLang;
  if (eslPromote && radarAuthorizedUrl && radarArticleId) {
    escalation = await runEscalation(admin, {
      clusterKey: asTrimmed(bodyRec.esl_cluster_key) ?? radarArticleId,
      storyType: asTrimmed(bodyRec.esl_story_type) ?? "general",
      discoveryUrl: radarAuthorizedUrl,
      discoveryDomain: escDomainOf(radarAuthorizedUrl),
      title: asTrimmed(bodyRec.esl_title),
      titleAr: asTrimmed(bodyRec.esl_title_ar),
    });
    // The analyzed/written source relative to the editorial primary. Default:
    // no upgrade → the discovery article IS the editorial primary.
    evidenceResolved = { kind: "primary", url: radarAuthorizedUrl, primaryUrl: null };
    if (escalation.status === "upgraded") {
      const up = escalation.selected_editorial_source.url;
      if (/^https?:\/\//i.test(up)) {
        // Fetchability-aware: the upgraded primary may be unreachable for the
        // sanctioned extractor (bot-block/paywall). Probe primary → validated
        // supporting → discovery, and hand the Writer the strongest FETCHABLE
        // one. The identified primary is preserved as provenance either way;
        // it is never silently presented as the analyzed/written source.
        evidenceResolved = await resolveAnalysisSource(escalation, radarAuthorizedUrl);
        if (evidenceResolved.kind !== "discovery_fallback") {
          // Writer fetches the resolved primary/supporting source (SSRF-safe
          // fetch re-validates).
          effSourceUrl = evidenceResolved.url;
          effAuthorizedUrl = evidenceResolved.url;
          effErProvider = null;      // resolved URL is NOT the discovery ER article
          effErProviderUri = null;
          effSourceTitle = escDomainOf(evidenceResolved.url);
          effSourceLang = null;      // likely a different language → let it be inferred
        }
        // discovery_fallback: keep every original discovery parameter (exact
        // URL, ER exact-article recovery, source title/lang) — the pipeline
        // behaves exactly as before the upgrade existed.
      }
    }

    // Evidence Intelligence: analyze the strongest FETCHABLE editorial source
    // (post-escalation) for THIS selected cluster, over the same verified text
    // the Writer will be grounded in. The analyzer runs inside the pipeline
    // (single fetch); the outcome is captured here for the content link +
    // response, and its provenance records which source kind was analyzed.
    evidenceClusterKey = asTrimmed(bodyRec.esl_cluster_key) ?? radarArticleId;
    const inner = makeEvidenceAnalyzer(admin, {
      clusterKey: evidenceClusterKey,
      storyType: asTrimmed(bodyRec.esl_story_type) ?? "general",
      sourceKind: evidenceResolved.kind,
      editorialPrimaryUrl: evidenceResolved.primaryUrl,
    });
    evidenceAnalyzer = async (verified) => {
      evidenceOutcome = await inner(verified);
      return evidenceOutcome;
    };
  }

  try {
    const result = await runIngestion(admin, {
      trigger,
      writerMode,
      pilotLimit,
      targetedSourceUrl: effSourceUrl,
      radarAuthorizedUrl: effAuthorizedUrl,
      radarErProvider: effErProvider,
      radarErProviderUri: effErProviderUri,
      radarSourceTitle: effSourceTitle,
      radarSourceLang: effSourceLang,
      evidenceAnalyzer,
    });
    // The pilot report (if any) is present only because runIngestion returned
    // normally, i.e. AFTER the mandatory audit persisted. It carries operational
    // counts only — no source text, keys, tokens, or headers.
    const pilot = (result as { pilot?: PilotReport }).pilot ?? null;

    // Radar one-click publish: own the terminal radar state transition here,
    // BEFORE responding, so it survives a terminated server action. The returned
    // outcome is echoed back for the server action to map to its UI result.
    let radarPublish: RadarPublishOutcome | null = null;
    if (radarArticleId) {
      radarPublish = await finalizeRadarPublish(admin, radarArticleId, pilot, radarCategorySlug, radarPublishMode);
    }

    // Provenance: when escalation upgraded the source, record every source that
    // is NOT the Writer's main source. Which rows apply depends on which source
    // the pipeline could actually fetch (evidenceResolved.kind):
    //  - primary written        → discovery "اكتُشِف عبر" (+ supporting context)
    //  - supporting written     → discovery + the identified-but-unfetchable primary
    //  - discovery written      → the identified primary (+ supporting context)
    // The identified primary is preserved even when unfetchable — never dropped,
    // never presented as the source the article/card was derived from.
    if (escalation && escalation.status === "upgraded" && pilot?.created_content_id) {
      try {
        const kind = evidenceResolved?.kind ?? "primary";
        const rows: { content_id: string; label: string; url: string }[] = [];
        if (kind !== "discovery_fallback") {
          rows.push({ content_id: pilot.created_content_id, label: "اكتُشِف عبر", url: escalation.discovery_source.url });
        }
        if (kind !== "primary" && evidenceResolved?.primaryUrl) {
          rows.push({
            content_id: pilot.created_content_id,
            label: "المصدر الأولي المحدد (تعذّر الجلب الآلي)",
            url: evidenceResolved.primaryUrl,
          });
        }
        if (escalation.supporting_url && kind !== "supporting") {
          rows.push({ content_id: pilot.created_content_id, label: "سياق مستقل", url: escalation.supporting_url });
        }
        if (rows.length) await admin.from("content_sources").insert(rows);
      } catch { /* provenance best-effort */ }
    }

    // Link the Evidence Intelligence audit row to the created Content so the
    // admin editor can show the card directly. Best-effort; the cluster-key
    // lookup via radar_editorial_selection remains the fallback path.
    if (evidenceClusterKey && pilot?.created_content_id) {
      try {
        await admin
          .from("radar_evidence_intelligence")
          .update({ content_id: pilot.created_content_id })
          .eq("cluster_key", evidenceClusterKey);
      } catch { /* link best-effort */ }
    }

    const evidenceSummary = evidenceOutcome
      ? {
        status: (evidenceOutcome as EvidenceOutcome).status,
        cached: (evidenceOutcome as EvidenceOutcome).cached,
        source_status: (evidenceOutcome as EvidenceOutcome).source_status,
        editorial_primary_url: evidenceResolved?.primaryUrl ?? null,
        evidence_type: (evidenceOutcome as EvidenceOutcome).card?.evidence_type ?? null,
        evidence_strength: (evidenceOutcome as EvidenceOutcome).card?.evidence_strength ?? null,
        claim_relationship: (evidenceOutcome as EvidenceOutcome).card?.claim_relationship ?? null,
      }
      : null;
    return Response.json({ ok: true, writer_mode: writerMode, radar_publish: radarPublish, source_escalation: escalation, evidence_intelligence: evidenceSummary, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "ingestion failed";
    // The pipeline threw before producing a pilot report → no Content was
    // created for this authorized run. Finalize the radar row as retryable
    // 'failed' (scoped to the 'processing' row we own) so the click never
    // orphans in 'processing'. Best-effort; a failure here still returns 500.
    if (radarArticleId) {
      try {
        await setRadarTerminal(admin, radarArticleId, {
          publish_status: "failed",
          published_content_id: null,
          publish_error: "pipeline_error",
        });
      } catch { /* ignore: response still reports the underlying error */ }
    }
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
