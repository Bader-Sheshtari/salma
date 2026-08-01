"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, isManagerRole, type Profile } from "@/lib/auth";
import { slugify } from "@/lib/slug";
import type { TablesInsert, TablesUpdate } from "@/lib/supabase/database.types";

export type SaveResult = { error: string } | null;

/** Result of `saveContent`: on success it carries the saved id + status so the
 * editor can show next-action buttons instead of redirecting away. */
export type ContentSaveResult =
  | { error: string }
  | { ok: true; id: string; status: string }
  | null;

/** Create or update a content item plus its sources. */
export async function saveContent(
  _prev: ContentSaveResult,
  formData: FormData,
): Promise<ContentSaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (title.length < 4) return { error: "العنوان قصير جداً." };

  const type = String(formData.get("type") ?? "news");
  const status = String(formData.get("status") ?? "draft");
  const category_slug = String(formData.get("category_slug") ?? "") || null;
  const excerpt = String(formData.get("excerpt") ?? "").trim() || null;
  const ai_summary = String(formData.get("ai_summary") ?? "").trim() || null;
  const body = String(formData.get("body") ?? "").trim() || null;
  const cover_image_url = String(formData.get("cover_image_url") ?? "").trim() || null;
  const cover_credit_name = String(formData.get("cover_credit_name") ?? "").trim() || null;
  const cover_credit_url = String(formData.get("cover_credit_url") ?? "").trim() || null;
  const source_name = String(formData.get("source_name") ?? "").trim() || null;
  const source_url = String(formData.get("source_url") ?? "").trim() || null;
  const video_url = String(formData.get("video_url") ?? "").trim() || null;
  const video_duration = String(formData.get("video_duration") ?? "").trim() || null;
  const readRaw = String(formData.get("read_minutes") ?? "").trim();
  const read_minutes = readRaw ? Number(readRaw) : null;
  const is_breaking = formData.get("is_breaking") === "on";
  const is_featured = formData.get("is_featured") === "on";

  const slug = String(formData.get("slug") ?? "").trim() || slugify(title);
  const published_at = status === "published" ? new Date().toISOString() : null;

  const payload = {
    title,
    slug,
    type,
    status,
    category_slug,
    excerpt,
    ai_summary,
    body,
    cover_image_url,
    cover_credit_name,
    cover_credit_url,
    source_name,
    source_url,
    video_url,
    video_duration,
    read_minutes: Number.isFinite(read_minutes as number) ? read_minutes : null,
    is_breaking,
    is_featured,
    ...(published_at ? { published_at } : {}),
  } satisfies Partial<TablesInsert<"content">>;

  let contentId = id;

  if (id) {
    const { error } = await supabase
      .from("content")
      .update(payload as unknown as never)
      .eq("id", id);
    if (error) return { error: "تعذّر حفظ التعديلات." };
  } else {
    const { data, error } = await supabase
      .from("content")
      .insert(payload as unknown as never)
      .select("id")
      .single();
    if (error || !data) return { error: "تعذّر إنشاء المحتوى (تأكد أن الرابط فريد)." };
    contentId = (data as { id: string }).id;
  }

  // Only one article may be the homepage hero: clear the flag on every other row.
  if (is_featured) {
    await supabase
      .from("content")
      .update({ is_featured: false } as unknown as never)
      .eq("is_featured", true)
      .neq("id", contentId);
  }

  // Replace sources: parallel arrays source_label[] / source_url[].
  const labels = formData.getAll("source_label").map((v) => String(v).trim());
  const urls = formData.getAll("source_url").map((v) => String(v).trim());
  const rows: TablesInsert<"content_sources">[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) rows.push({ content_id: contentId, label: labels[i], url: urls[i] || null });
  }
  await supabase.from("content_sources").delete().eq("content_id", contentId);
  if (rows.length > 0) {
    await supabase.from("content_sources").insert(rows as unknown as never);
  }

  // Replace media gallery: submitted as a JSON array in `media_json`.
  const mediaRows: TablesInsert<"content_media">[] = [];
  try {
    const parsed = JSON.parse(String(formData.get("media_json") ?? "[]"));
    if (Array.isArray(parsed)) {
      parsed.forEach((m, i) => {
        const url = String(m?.url ?? "").trim();
        if (!url) return;
        mediaRows.push({
          content_id: contentId,
          type: m?.type === "video" ? "video" : "image",
          url,
          storage_path: m?.storage_path ? String(m.storage_path) : null,
          caption: String(m?.caption ?? "").trim() || null,
          credit_name: String(m?.credit_name ?? "").trim() || null,
          credit_url: String(m?.credit_url ?? "").trim() || null,
          sort_order: i,
        });
      });
    }
  } catch {
    // ignore malformed payload — treat as no media
  }
  await supabase.from("content_media").delete().eq("content_id", contentId);
  if (mediaRows.length > 0) {
    await supabase.from("content_media").insert(mediaRows as unknown as never);
  }

  revalidatePath("/admin/content");
  revalidatePath("/");
  // Stay on the editor and surface next-action buttons (return to list / publish
  // / delete / continue editing). The saved id lets a freshly-created item keep
  // editing the same row instead of inserting a duplicate.
  return { ok: true, id: contentId, status };
}

export async function setStatus(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const status = String(formData.get("status"));
  const patch =
    status === "published"
      ? { status, published_at: new Date().toISOString() }
      : { status };
  await supabase.from("content").update(patch as unknown as never).eq("id", id);
  revalidatePath("/admin/content");
  revalidatePath("/");
}

export async function softDeleteContent(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  await supabase
    .from("content")
    .update({ deleted_at: new Date().toISOString() } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/content");
  revalidatePath("/");
}

export type IngestResult =
  | { error: string }
  | { found: number; kept: number; filtered: number; duplicates: number }
  | null;

/**
 * Trigger the news-ingestion agent, which runs entirely inside Supabase as the
 * `ingest-news` Edge Function: it live-searches trusted sources, translates and
 * curates into Arabic, and stores real, sourced items as `pending` content
 * (origin = 'ai') for an admin to review. The AI never authors facts.
 *
 * This server action is a thin proxy — it forwards the admin's session JWT so
 * the function can authorize the caller, then returns the run stats.
 */
export async function ingestNews(_prev: IngestResult, _formData: FormData): Promise<IngestResult> {
  await requireAdmin();
  const supabase = await createClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("ingest-news", {
    body: {},
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error || !data || data.ok === false) {
    return { error: "تعذّر تشغيل وكيل الأخبار. تأكد من مفتاح OpenRouter وإعدادات السياسة التحريرية." };
  }

  revalidatePath("/admin/content");
  return {
    found: Number(data.found) || 0,
    kept: Number(data.kept) || 0,
    filtered: Number(data.filtered) || 0,
    duplicates: Number(data.duplicates) || 0,
  };
}

const VALID_REGIONS = ["kuwait", "gulf", "mena", "world"];

/** Split a textarea value into a clean, de-duplicated list (one item per line). */
function linesToList(value: string): string[] {
  const seen = new Set<string>();
  for (const raw of value.split("\n")) {
    const t = raw.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

export type PolicyResult = { error: string } | { saved: true } | null;

/** Update the single editorial-policy row that drives the ingestion agent. */
export async function updateEditorialPolicy(
  _prev: PolicyResult,
  formData: FormData,
): Promise<PolicyResult> {
  await requireAdmin();
  const supabase = await createClient();

  const regions = formData
    .getAll("regions")
    .map((r) => String(r))
    .filter((r) => VALID_REGIONS.includes(r));
  if (regions.length === 0) return { error: "اختر منطقة واحدة على الأقل." };

  const patch = {
    block_topics: linesToList(String(formData.get("block_topics") ?? "")),
    priority_topics: linesToList(String(formData.get("priority_topics") ?? "")),
    trusted_sources: linesToList(String(formData.get("trusted_sources") ?? "")),
    regions,
    updated_at: new Date().toISOString(),
  } satisfies TablesUpdate<"editorial_policy">;

  const { data: existing } = await supabase
    .from("editorial_policy")
    .select("id")
    .limit(1)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("editorial_policy")
      .update(patch as unknown as never)
      .eq("id", (existing as { id: string }).id);
    if (error) return { error: "تعذّر حفظ السياسة." };
  } else {
    const { error } = await supabase
      .from("editorial_policy")
      .insert(patch as unknown as never);
    if (error) return { error: "تعذّر إنشاء السياسة." };
  }

  revalidatePath("/admin/ingest/policy");
  return { saved: true };
}

// ============ NEWS SOURCE REGISTRY (E1.1) ============

const VALID_SOURCE_TYPES = ["official", "research", "medical_institution", "media", "reference"];
const VALID_TIERS = ["1", "2", "3", "blocked"];

/**
 * Normalize a host the same way the DB `normalize_host` function does: lowercase,
 * drop the scheme, a leading "www.", and any path/port/query/fragment. Keeps the
 * client-entered value and the stored value consistent for case-insensitive matching.
 */
function normalizeHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/:?#].*$/, "");
}

/** Parse a dotted-quad IPv4 into octets, or null if it isn't one. */
function ipv4Octets(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

/**
 * Reject hosts that must never be a news source or fetched later: localhost,
 * loopback, link-local, and private/CGNAT IP ranges (IPv4 + IPv6). This is the
 * SSRF guard applied to both the domain and the (optional) feed URL.
 */
function isBlockedHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.includes(":")) {
    // IPv6 loopback / unspecified / link-local (fe80::/10) / unique-local (fc00::/7)
    if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd"))
      return true;
  }
  const o = ipv4Octets(h);
  if (o) {
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10) return true; // unspecified, loopback, private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

// A public hostname: dot-separated labels, no IP literal, no blocked host.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Returns an Arabic error string if the normalized domain is invalid, else null. */
function validateDomain(domain: string): string | null {
  if (!domain) return "أدخل نطاقاً صحيحاً (مثال: who.int).";
  if (ipv4Octets(domain)) return "النطاق يجب أن يكون اسم مضيف وليس عنوان IP.";
  if (isBlockedHost(domain)) return "نطاق غير مسموح (محلي أو شبكة داخلية).";
  if (!HOSTNAME_RE.test(domain)) return "صيغة النطاق غير صحيحة (مثال: who.int).";
  return domain.length <= 253 ? null : "النطاق طويل جداً.";
}

/**
 * Validate the optional RSS/feed URL as an external http/https address. Rejects
 * unsafe protocols, embedded credentials, and localhost/loopback/link-local/
 * private hosts. Does NOT fetch the URL — validation only.
 */
function validateFeedUrl(raw: string): { url: string | null } | { error: string } {
  const value = raw.trim();
  if (!value) return { url: null };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "رابط RSS غير صالح." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { error: "رابط RSS يجب أن يبدأ بـ http أو https." };
  if (parsed.username || parsed.password)
    return { error: "رابط RSS يجب ألا يحتوي على بيانات دخول." };
  if (isBlockedHost(parsed.hostname))
    return { error: "مضيف رابط RSS غير مسموح (محلي أو شبكة داخلية)." };
  return { url: value };
}

/** Create or update a registry source. Domain is normalized before saving. */
export async function saveNewsSource(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2) return { error: "اسم المصدر قصير جداً." };

  const domain = normalizeHost(String(formData.get("domain") ?? ""));
  const domainError = validateDomain(domain);
  if (domainError) return { error: domainError };

  const region = String(formData.get("region") ?? "");
  if (!VALID_REGIONS.includes(region)) return { error: "اختر منطقة صحيحة." };

  const source_type = String(formData.get("source_type") ?? "");
  if (!VALID_SOURCE_TYPES.includes(source_type)) return { error: "اختر نوع مصدر صحيح." };

  const tier = String(formData.get("tier") ?? "");
  if (!VALID_TIERS.includes(tier)) return { error: "اختر مستوى صحيح." };

  const trust_score = Math.min(Math.max(Number(formData.get("trust_score")) || 0, 0), 100);
  const feed = validateFeedUrl(String(formData.get("feed_url") ?? ""));
  if ("error" in feed) return { error: feed.error };
  const feed_url = feed.url;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const payload = {
    name,
    domain,
    region,
    source_type,
    tier,
    trust_score,
    discovery_enabled: formData.get("discovery_enabled") === "on",
    final_source_allowed: formData.get("final_source_allowed") === "on",
    active: formData.get("active") === "on",
    feed_url,
    notes,
  } satisfies Partial<TablesInsert<"news_sources">>;

  if (id) {
    const { error } = await supabase
      .from("news_sources")
      .update(payload as unknown as never)
      .eq("id", id);
    if (error) return { error: "تعذّر حفظ المصدر." };
  } else {
    const { error } = await supabase.from("news_sources").insert(payload as unknown as never);
    if (error) return { error: "تعذّر إضافة المصدر (تأكد أن النطاق غير مُسجَّل مسبقاً)." };
  }

  revalidatePath("/admin/ingest/sources");
  return null;
}

/** Toggle a source active/inactive from the list without opening the full form. */
export async function toggleNewsSource(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const active = String(formData.get("active")) === "true";
  await supabase
    .from("news_sources")
    .update({ active } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/ingest/sources");
}

/**
 * Permanently delete a source — but only when it carries no editorial history.
 * If the domain appears in the decision audit log, deletion would make past
 * runs unreadable, so we refuse and steer the admin to disable it instead
 * (disabling keeps the row and its history while removing it from ingestion).
 */
export async function deleteNewsSource(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));

  const { data: src } = await supabase
    .from("news_sources")
    .select("domain")
    .eq("id", id)
    .maybeSingle();
  const domain = (src as { domain: string } | null)?.domain;
  if (domain) {
    const { count } = await supabase
      .from("ingestion_decisions")
      .select("id", { count: "exact", head: true })
      .eq("source_domain", domain);
    if ((count ?? 0) > 0)
      return {
        error: "لا يمكن حذف مصدر مرتبط بسجلّ تحريري سابق. عطِّله بدلاً من الحذف للحفاظ على السجلّ.",
      };
  }

  const { error } = await supabase.from("news_sources").delete().eq("id", id);
  if (error) return { error: "تعذّر حذف المصدر." };
  revalidatePath("/admin/ingest/sources");
  return null;
}

export async function moderateComment(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const action = String(formData.get("action"));
  if (action === "delete") {
    await supabase.from("comments").delete().eq("id", id);
  } else {
    const status = action === "approve" ? "approved" : "rejected";
    await supabase.from("comments").update({ status } as unknown as never).eq("id", id);
  }
  revalidatePath("/admin/comments");
}

// ============ DEPARTMENTS ============

export async function saveDepartment(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const name_ar = String(formData.get("name_ar") ?? "").trim();
  if (name_ar.length < 2) return { error: "اسم القسم قصير جداً." };
  const slug = String(formData.get("slug") ?? "").trim() || slugify(name_ar);
  const sortRaw = String(formData.get("sort_order") ?? "").trim();
  const sort_order = sortRaw ? Number(sortRaw) || 0 : 0;

  const payload = { name_ar, slug, sort_order } satisfies Partial<TablesInsert<"departments">>;

  if (id) {
    const { error } = await supabase
      .from("departments")
      .update(payload as unknown as never)
      .eq("id", id);
    if (error) return { error: "تعذّر حفظ القسم." };
  } else {
    const { error } = await supabase
      .from("departments")
      .insert(payload as unknown as never);
    if (error) return { error: "تعذّر إنشاء القسم (تأكد أن الرابط فريد)." };
  }

  revalidatePath("/admin/departments");
  revalidatePath("/doctors");
  return null;
}

export async function deleteDepartment(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  await supabase.from("departments").delete().eq("id", id);
  revalidatePath("/admin/departments");
  revalidatePath("/doctors");
}

// ============ CATEGORIES ============

/**
 * Create or update a site category (a nav line + homepage topic, e.g. "الكويت").
 * The category `slug` is the primary key and is referenced by content and
 * homepage_sections, so it is immutable after creation — edits only touch the
 * display fields. Creating a category also seeds a matching, *disabled*
 * homepage_sections row so the admin can enable/position it when ready.
 */
export async function saveCategory(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  // `original_slug` marks an edit; empty means create.
  const original_slug = String(formData.get("original_slug") ?? "").trim();
  const name_ar = String(formData.get("name_ar") ?? "").trim();
  if (name_ar.length < 2) return { error: "اسم القسم قصير جداً." };
  const name_en = String(formData.get("name_en") ?? "").trim() || null;
  const accent = String(formData.get("accent") ?? "").trim() || "#449785";
  const sortRaw = String(formData.get("sort_order") ?? "").trim();
  const sort_order = sortRaw ? Number(sortRaw) || 0 : 0;
  const show_in_nav = formData.get("show_in_nav") === "on";

  if (original_slug) {
    const payload = { name_ar, name_en, accent, sort_order, show_in_nav };
    const { error } = await supabase
      .from("categories")
      .update(payload as unknown as never)
      .eq("slug", original_slug);
    if (error) return { error: "تعذّر حفظ القسم." };
  } else {
    const slug = String(formData.get("slug") ?? "").trim() || slugify(name_ar);
    const payload = { slug, name_ar, name_en, accent, sort_order, show_in_nav };
    const { error } = await supabase
      .from("categories")
      .insert(payload as unknown as never);
    if (error) return { error: "تعذّر إنشاء القسم (تأكد أن الرابط فريد)." };

    // Seed an enabled homepage section for the new category so it shows on the
    // homepage immediately; the admin can hide/reorder it from /admin/homepage.
    const { data: maxRow } = await supabase
      .from("homepage_sections")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSort = ((maxRow as { sort_order: number } | null)?.sort_order ?? 0) + 1;
    const section = {
      key: `category:${slug}`,
      kind: "category",
      category_slug: slug,
      title_ar: name_ar,
      is_enabled: true,
      sort_order: nextSort,
      accent,
    };
    await supabase.from("homepage_sections").insert(section as unknown as never);
  }

  revalidatePath("/admin/categories");
  revalidatePath("/admin/homepage");
  revalidatePath("/", "layout");
  return null;
}

/**
 * Delete a category. Blocked if any content is still filed under it (the FK
 * would otherwise orphan articles); the admin must reassign content first.
 * The matching homepage_sections row is removed alongside it.
 */
export async function deleteCategory(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();
  const slug = String(formData.get("slug") ?? "").trim();
  if (!slug) return null;

  const { count } = await supabase
    .from("content")
    .select("*", { count: "exact", head: true })
    .eq("category_slug", slug)
    .is("deleted_at", null);
  if ((count ?? 0) > 0) {
    // Leave the category in place; content is still attached to it.
    return { error: `لا يمكن حذف القسم لأنه يحتوي على ${count} مقالاً. انقل المقالات أو احذفها أولاً.` };
  }

  await supabase.from("homepage_sections").delete().eq("category_slug", slug);
  await supabase.from("categories").delete().eq("slug", slug);
  revalidatePath("/admin/categories");
  revalidatePath("/admin/homepage");
  revalidatePath("/", "layout");
  return null;
}

// ============ DOCTORS ============

export async function saveDoctor(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const name_ar = String(formData.get("name_ar") ?? "").trim();
  if (name_ar.length < 3) return { error: "اسم الطبيب قصير جداً." };

  const department_id = String(formData.get("department_id") ?? "").trim() || null;
  const title_ar = String(formData.get("title_ar") ?? "").trim() || null;
  const hospital = String(formData.get("hospital") ?? "").trim() || null;
  const photo_url = String(formData.get("photo_url") ?? "").trim() || null;
  const bio = String(formData.get("bio") ?? "").trim() || null;
  const slug = String(formData.get("slug") ?? "").trim() || slugify(name_ar);

  const payload = {
    name_ar,
    slug,
    department_id,
    title_ar,
    hospital,
    photo_url,
    bio,
  } satisfies Partial<TablesInsert<"doctors">>;

  if (id) {
    const { error } = await supabase
      .from("doctors")
      .update(payload as unknown as never)
      .eq("id", id);
    if (error) return { error: "تعذّر حفظ التعديلات." };
  } else {
    const { error } = await supabase
      .from("doctors")
      .insert(payload as unknown as never);
    if (error) return { error: "تعذّر إنشاء الطبيب (تأكد أن الرابط فريد)." };
  }

  revalidatePath("/admin/doctors");
  revalidatePath("/doctors");
  redirect("/admin/doctors");
}

export async function softDeleteDoctor(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  await supabase
    .from("doctors")
    .update({ deleted_at: new Date().toISOString() } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/doctors");
  revalidatePath("/doctors");
}

export async function moderateRating(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const action = String(formData.get("action"));
  if (action === "delete") {
    await supabase.from("doctor_ratings").delete().eq("id", id);
  } else {
    const status = action === "approve" ? "approved" : "rejected";
    await supabase.from("doctor_ratings").update({ status } as unknown as never).eq("id", id);
  }
  revalidatePath("/admin/doctors/ratings");
  revalidatePath("/doctors");
}

// ============ DOCTOR TRANSFERS (انتقال الأطباء) ============

export async function saveTransfer(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const actor = await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const doctor_name = String(formData.get("doctor_name") ?? "").trim();
  if (doctor_name.length < 3) return { error: "اسم الطبيب قصير جداً." };

  const specialty = String(formData.get("specialty") ?? "").trim() || null;
  const doctor_photo_url = String(formData.get("doctor_photo_url") ?? "").trim() || null;
  const from_hospital = String(formData.get("from_hospital") ?? "").trim() || null;
  const to_hospital = String(formData.get("to_hospital") ?? "").trim() || null;

  // Strict status validation: only draft/published are ever accepted. A missing,
  // malformed, or forged value is rejected — never coerced into published.
  const rawStatus = String(formData.get("status") ?? "");
  if (rawStatus !== "draft" && rawStatus !== "published") {
    return { error: "حالة غير صالحة." };
  }
  const status = rawStatus;

  // Confidential internal source is manager-only and never part of the public
  // payload. The form only submits the source fields when the manager UI was
  // actually shown (`internal_source_present`), so a regular admin — or a load
  // error that suppressed the field — can never overwrite or clear it.
  const canSource =
    isManagerRole(actor.role) && formData.get("internal_source_present") === "1";
  const internalSource = canSource
    ? String(formData.get("internal_source_note") ?? "").trim() || null
    : null;
  const clearSource = canSource && formData.get("clear_internal_source") === "1";

  const revalidatePublic = () => {
    revalidatePath("/admin/transfers");
    revalidatePath("/transfers");
    revalidatePath("/");
  };

  if (id) {
    // Load the current publication timestamp so publish/edit/unpublish all
    // preserve it. A read failure must stop the save — never assume null, which
    // would wipe or reset the publication date.
    const { data: existing, error: readErr } = await supabase
      .from("doctor_transfers")
      .select("published_at")
      .eq("id", id)
      .maybeSingle();
    if (readErr) return { error: "تعذّر تحميل بيانات الانتقال الحالية." };
    if (!existing) return { error: "الانتقال غير موجود." };
    const prior = (existing as { published_at: string | null }).published_at;
    // First publication stamps now(); republishing/editing keeps the original;
    // unpublishing (→ draft) preserves the stored date.
    const published_at =
      status === "published" ? prior ?? new Date().toISOString() : prior;

    // Slug is no longer generated in A2 (kept null for new rows elsewhere); the
    // update omits it so existing slugs are preserved untouched. Legacy content
    // columns are likewise never written.
    const payload = {
      doctor_name,
      specialty,
      doctor_photo_url,
      from_hospital,
      to_hospital,
      status,
      published_at,
    } satisfies Partial<TablesUpdate<"doctor_transfers">>;

    const { error } = await supabase
      .from("doctor_transfers")
      .update(payload as unknown as never)
      .eq("id", id);
    if (error) return { error: "تعذّر حفظ التعديلات." };

    // Only managers touch the confidential note, and only when the form carried
    // the source UI. Public data is already saved above, so a private-write
    // failure reports a scoped error without discarding the public save.
    if (canSource) {
      if (clearSource) {
        const { error: delErr } = await supabase
          .from("doctor_transfer_private")
          .delete()
          .eq("transfer_id", id);
        if (delErr) {
          revalidatePublic();
          return {
            error:
              "حُفظت بيانات الانتقال، لكن تعذّر حذف المصدر الداخلي. البيانات العامة محفوظة — أعد المحاولة لحذف المصدر فقط.",
          };
        }
      } else if (internalSource) {
        const { error: upErr } = await supabase
          .from("doctor_transfer_private")
          .upsert({ transfer_id: id, internal_source_note: internalSource } as unknown as never);
        if (upErr) {
          revalidatePublic();
          return {
            error:
              "حُفظت بيانات الانتقال، لكن تعذّر حفظ المصدر الداخلي. البيانات العامة محفوظة — أعد المحاولة لحفظ المصدر فقط.",
          };
        }
      }
      // else: blank field with no clear flag → preserve the stored note untouched.
    }
  } else {
    // Atomic create via the hardened RPC: it re-validates status, stamps
    // published_at, generates no slug, and writes the optional private note in
    // one transaction under the caller's RLS — a non-manager or a failed private
    // write rolls the whole thing back, leaving no orphaned public row.
    const { data: newId, error } = await supabase.rpc(
      "create_transfer_with_private",
      {
        p_doctor_name: doctor_name,
        p_specialty: specialty ?? undefined,
        p_doctor_photo_url: doctor_photo_url ?? undefined,
        p_from_hospital: from_hospital ?? undefined,
        p_to_hospital: to_hospital ?? undefined,
        p_status: status,
        p_internal_source: internalSource ?? undefined,
      } as unknown as never,
    );
    if (error || !newId) {
      return {
        error: internalSource
          ? "تعذّر إنشاء الانتقال مع المصدر الداخلي. لم يتم حفظ أي بيانات، حاول مرة أخرى."
          : "تعذّر إنشاء الانتقال.",
      };
    }
  }

  revalidatePublic();
  redirect("/admin/transfers");
}

export async function softDeleteTransfer(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  await supabase
    .from("doctor_transfers")
    .update({ deleted_at: new Date().toISOString() } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/transfers");
  revalidatePath("/transfers");
}

// ============ HOMEPAGE SECTIONS ============

const DISPLAY_STYLES = ["carousel", "grid", "list", "featured"];

/** Update the editable fields of a single homepage section. Kind/key/category
 * are immutable (seeded), so they are not accepted here. */
export async function saveHomepageSection(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "قسم غير معروف." };

  const title_ar = String(formData.get("title_ar") ?? "").trim();
  if (title_ar.length < 2) return { error: "عنوان القسم قصير جداً." };

  const styleRaw = String(formData.get("display_style") ?? "carousel");
  const display_style = DISPLAY_STYLES.includes(styleRaw) ? styleRaw : "carousel";
  const limitRaw = Number(String(formData.get("items_limit") ?? "6"));
  const items_limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 24) : 6;
  const show_view_all = formData.get("show_view_all") === "on";
  const accent = String(formData.get("accent") ?? "").trim() || null;

  // Note: `is_enabled` (homepage visibility) is intentionally NOT updated here —
  // it is owned exclusively by the dedicated toggle (toggleHomepageSection), so
  // editing a section's title/style never accidentally hides or shows it.
  const payload = {
    title_ar,
    display_style,
    items_limit,
    show_view_all,
    accent,
  } satisfies Partial<TablesUpdate<"homepage_sections">>;

  const { error } = await supabase
    .from("homepage_sections")
    .update(payload as unknown as never)
    .eq("id", id);
  if (error) return { error: "تعذّر حفظ القسم." };

  revalidatePath("/admin/homepage");
  revalidatePath("/");
  return null;
}

/** Result of the homepage-visibility toggle: a success or error message. */
export type ToggleResult = { success?: string; error?: string } | null;

/**
 * Feature sections whose public resolver is implemented in `getHomepage`, so
 * they may be enabled. Any other `feature:*` key (e.g. `feature:social`, whose
 * UI is postponed) has no renderer yet — enabling it would produce a misleading
 * "visible" state that shows nothing to visitors, so it is blocked below.
 * Category sections are always enable-able.
 */
const ENABLEABLE_FEATURE_KEYS = new Set(["feature:doctor_transfers"]);

/**
 * Show/hide a homepage section on the public homepage. Owns `is_enabled`
 * exclusively so visibility is a single, explicit action (separate from the
 * section's content/style edits). `next` is the desired visibility state.
 */
export async function toggleHomepageSection(
  _prev: ToggleResult,
  formData: FormData,
): Promise<ToggleResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "قسم غير معروف." };
  const next = String(formData.get("next") ?? "") === "true";

  // Guard: unsupported feature sections cannot be enabled (disabling is always
  // allowed). Authoritative check — never trust the client-disabled button.
  if (next) {
    const { data: row } = await supabase
      .from("homepage_sections")
      .select("key, kind")
      .eq("id", id)
      .maybeSingle();
    const s = row as { key: string; kind: string } | null;
    if (s && s.kind === "feature" && !ENABLEABLE_FEATURE_KEYS.has(s.key)) {
      return { error: "لا يمكن تفعيل هذا القسم بعد — الميزة قيد الإنشاء." };
    }
  }

  const { error } = await supabase
    .from("homepage_sections")
    .update({ is_enabled: next } as unknown as never)
    .eq("id", id);
  if (error) return { error: "تعذّر تحديث حالة القسم." };

  revalidatePath("/admin/homepage");
  revalidatePath("/", "layout");
  return {
    success: next
      ? "تم إظهار القسم في الصفحة الرئيسية"
      : "تم إخفاء القسم من الصفحة الرئيسية",
  };
}

/** Swap a section's sort_order with its neighbour to move it up or down. */
export async function moveHomepageSection(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const dir = String(formData.get("dir"));

  const { data } = await supabase
    .from("homepage_sections")
    .select("id, sort_order")
    .order("sort_order", { ascending: true });
  const rows = (data as { id: string; sort_order: number }[]) ?? [];
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) return;
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= rows.length) return;

  const a = rows[i];
  const b = rows[j];
  await Promise.all([
    supabase.from("homepage_sections").update({ sort_order: b.sort_order } as unknown as never).eq("id", a.id),
    supabase.from("homepage_sections").update({ sort_order: a.sort_order } as unknown as never).eq("id", b.id),
  ]);

  revalidatePath("/admin/homepage");
  revalidatePath("/");
}

/**
 * Choose the homepage hero (the big article on top). Clears `is_featured` on all
 * content, then sets it on the chosen row. An empty id restores automatic mode
 * (the homepage falls back to the newest item of the first section).
 */
export async function setMainContent(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id") ?? "").trim();

  await supabase
    .from("content")
    .update({ is_featured: false } as unknown as never)
    .eq("is_featured", true);

  if (id) {
    await supabase
      .from("content")
      .update({ is_featured: true } as unknown as never)
      .eq("id", id);
  }

  revalidatePath("/admin/homepage");
  revalidatePath("/");
}

/** Move a section to an exact 1-based position, renumbering the rest to match. */
export async function setHomepageSectionPosition(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const posRaw = Number(String(formData.get("position") ?? ""));
  if (!id || !Number.isFinite(posRaw)) return;

  const { data } = await supabase
    .from("homepage_sections")
    .select("id, sort_order")
    .order("sort_order", { ascending: true });
  const rows = (data as { id: string; sort_order: number }[]) ?? [];
  const from = rows.findIndex((r) => r.id === id);
  if (from === -1) return;
  const to = Math.min(Math.max(Math.trunc(posRaw) - 1, 0), rows.length - 1);
  if (to === from) return;

  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);

  await Promise.all(
    rows.map((r, i) =>
      supabase
        .from("homepage_sections")
        .update({ sort_order: i } as unknown as never)
        .eq("id", r.id),
    ),
  );

  revalidatePath("/admin/homepage");
  revalidatePath("/");
}

/**
 * Persist a full drag-and-drop reorder: `orderedIds` is the sections in their
 * new top-to-bottom order; each row's sort_order is set to its index. Called
 * directly from the client after a drag ends.
 */
export async function reorderHomepageSections(orderedIds: string[]) {
  await requireAdmin();
  const supabase = await createClient();
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;

  await Promise.all(
    orderedIds.map((id, i) =>
      supabase
        .from("homepage_sections")
        .update({ sort_order: i } as unknown as never)
        .eq("id", String(id)),
    ),
  );

  revalidatePath("/admin/homepage");
  revalidatePath("/");
}

// ============ URL → AI SYNTHESIS ============

export type SynthResult = { error: string } | { ok: true; id: string; title: string } | null;

/**
 * Proxy to the `synthesize-url` Edge Function: the admin pastes an article URL;
 * the function fetches the page, writes an Arabic draft, keeps the source as a
 * reference, and stores it as `pending` content for review. Mirrors ingestNews:
 * the OpenRouter key lives only as a Supabase function secret, so synthesis must
 * run inside Supabase, not in this Next.js process.
 */
export async function synthesizeUrl(_prev: SynthResult, formData: FormData): Promise<SynthResult> {
  await requireAdmin();
  const url = String(formData.get("url") ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return { error: "أدخل رابطاً صحيحاً يبدأ بـ http(s)." };

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("synthesize-url", {
    body: { url },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error || !data) {
    return { error: "تعذّر الاتصال بخدمة المعالجة. حاول مرة أخرى." };
  }
  if (data.ok === false) {
    const reasons: Record<string, string> = {
      no_text: "تعذّر قراءة نص المقال من هذا الرابط. قد يكون الموقع محمياً أو يعرض محتواه عبر JavaScript؛ جرّب رابطاً آخر أو أضف المقال يدوياً.",
      blocked: "يمنع هذا الموقع القراءة الآلية لصفحاته (حماية ضد الروبوتات)، لذا لا يمكن جلب المقال تلقائياً. انسخ نص المقال وأضفه يدوياً.",
      synthesis: "تعذّرت صياغة المقال. حاول مرة أخرى بعد قليل.",
    };
    return { error: reasons[String(data.reason)] ?? "تعذّرت معالجة الرابط. تأكد من صحته وإعدادات OpenRouter." };
  }

  revalidatePath("/admin/content");
  return { ok: true, id: String(data.id), title: String(data.title ?? "") };
}

/* ─────────────────────────  ADMIN USERS & PERMISSIONS  ───────────────────────── */

export type AdminUserResult = { error: string } | { ok: string } | null;

/** Roles a manager may hand out through the UI (never "owner"). */
const ASSIGNABLE_ROLES = ["admin", "super_admin"] as const;

/**
 * Whether `actor` may act on `target` (suspend / delete / change role / reset
 * password). Self is excluded (use the self-service password form) and the owner
 * account is always protected. Owners manage admins and super admins; super
 * admins manage only plain admins. Mirrors the spec's role hierarchy — and is the
 * authoritative check, since the service-role client bypasses RLS and triggers.
 */
function canManage(actor: Profile, target: { id: string; role: string }): boolean {
  if (target.id === actor.id) return false;
  if (target.role === "owner") return false;
  if (actor.role === "owner") return true;
  if (actor.role === "super_admin") return target.role === "admin";
  return false;
}

/** Create a new admin account (auth user + elevated profile) with a temp password. */
export async function createAdmin(
  _prev: AdminUserResult,
  formData: FormData,
): Promise<AdminUserResult> {
  const actor = await requireAdmin();
  if (!isManagerRole(actor.role)) return { error: "لا تملك صلاحية إضافة مدراء." };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const full_name = String(formData.get("full_name") ?? "").trim() || null;
  const role = String(formData.get("role") ?? "admin");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "أدخل بريداً إلكترونياً صحيحاً." };
  if (password.length < 8) return { error: "كلمة المرور المؤقتة يجب ألا تقل عن 8 أحرف." };
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) return { error: "دور غير صالح." };
  if (role === "super_admin" && actor.role !== "owner")
    return { error: "فقط المالك يمكنه تعيين مشرف أعلى." };

  const admin = createAdminClient();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: full_name ? { full_name } : undefined,
  });
  if (createErr || !created?.user) {
    if (/registered|already|exists/i.test(createErr?.message ?? ""))
      return { error: "هذا البريد مسجّل بالفعل." };
    return { error: "تعذّر إنشاء الحساب." };
  }

  // handle_new_user already inserted a profile (role=user); elevate it.
  const { error: updErr } = await admin
    .from("profiles")
    .update({ role, full_name, created_by: actor.id } as never)
    .eq("id", created.user.id);
  if (updErr) {
    await admin.auth.admin.deleteUser(created.user.id); // roll back the orphan
    return { error: "تعذّر ضبط صلاحية الحساب." };
  }

  revalidatePath("/admin/users");
  return { ok: "تم إنشاء الحساب بنجاح." };
}

/** Change a target admin's role (admin ⇄ super_admin). */
export async function setAdminRole(formData: FormData) {
  const actor = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) return;
  if (role === "super_admin" && actor.role !== "owner") return;

  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id, role").eq("id", id).maybeSingle();
  const target = data as { id: string; role: string } | null;
  if (!target || !canManage(actor, target)) return;

  await admin.from("profiles").update({ role } as never).eq("id", id);
  revalidatePath("/admin/users");
}

/** Suspend or re-activate a target admin. */
export async function toggleAdminDisabled(formData: FormData) {
  const actor = await requireAdmin();
  const id = String(formData.get("id") ?? "");

  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, role, disabled")
    .eq("id", id)
    .maybeSingle();
  const target = data as { id: string; role: string; disabled: boolean } | null;
  if (!target || !canManage(actor, target)) return;

  await admin.from("profiles").update({ disabled: !target.disabled } as never).eq("id", id);
  revalidatePath("/admin/users");
}

/** Permanently delete a target admin (cascades the profile via the auth FK). */
export async function deleteAdmin(formData: FormData) {
  const actor = await requireAdmin();
  const id = String(formData.get("id") ?? "");

  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id, role").eq("id", id).maybeSingle();
  const target = data as { id: string; role: string } | null;
  if (!target || !canManage(actor, target)) return;

  await admin.auth.admin.deleteUser(id);
  revalidatePath("/admin/users");
}

/** Set a new temporary password for a target admin. */
export async function resetAdminPassword(
  _prev: AdminUserResult,
  formData: FormData,
): Promise<AdminUserResult> {
  const actor = await requireAdmin();
  if (!isManagerRole(actor.role)) return { error: "لا تملك صلاحية." };
  const id = String(formData.get("id") ?? "");
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) return { error: "كلمة المرور يجب ألا تقل عن 8 أحرف." };

  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id, role").eq("id", id).maybeSingle();
  const target = data as { id: string; role: string } | null;
  if (!target || !canManage(actor, target)) return { error: "لا تملك صلاحية على هذا الحساب." };

  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) return { error: "تعذّر تغيير كلمة المرور." };
  return { ok: "تم تحديث كلمة المرور." };
}

/** Any signed-in admin may change their own password. */
export async function changeOwnPassword(
  _prev: AdminUserResult,
  formData: FormData,
): Promise<AdminUserResult> {
  await requireAdmin();
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) return { error: "كلمة المرور يجب ألا تقل عن 8 أحرف." };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: "تعذّر تغيير كلمة المرور." };
  return { ok: "تم تغيير كلمة مرورك بنجاح." };
}
