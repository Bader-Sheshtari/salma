"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireStaff, isManagerRole, type Profile } from "@/lib/auth";
import { canAssignRole, canManageTarget } from "@/lib/roles";
import { slugify } from "@/lib/slug";
import type { TablesInsert, TablesUpdate } from "@/lib/supabase/database.types";
import { normalizeRejectReason } from "@/lib/editorial-feedback";
import {
  SNAPSHOT_FIELDS,
  ensureAiBaseline,
  logFeedbackEvents,
  recordPublishFeedback,
  saveChangeEvents,
  type ContentSnapshot,
} from "./feedback-log";

export type SaveResult = { error: string } | null;

const CONTENT_STATUSES = ["draft", "pending", "published", "rejected", "unpublished"];
/** Statuses an article may be (re)published from. */
const PUBLISHABLE_FROM = ["pending", "unpublished"];

/**
 * Legal status transitions for a human actor — the EXACT matrix the DB trigger
 * content_lifecycle_before enforces (P0021 otherwise). Same-status is always OK.
 */
const LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["pending"],
  pending: ["published", "draft", "rejected"],
  published: ["unpublished"],
  unpublished: ["published", "draft"],
  rejected: ["draft"],
};

/**
 * The ONE status-transition rule shared by saveContent, setStatus and
 * bulkSetStatus, so no path can bypass it (and users get a clean Arabic error
 * instead of a DB P0021 → HTTP 500):
 *  - publish only from `pending` or `unpublished` (republish), never from a
 *    deleted row;
 *  - taking a live article down (→ draft/pending/unpublished) always lands on
 *    `unpublished` (unpublish ≠ draft);
 *  - every other transition must be in LEGAL_TRANSITIONS, else an Arabic error.
 * Publication dates are NOT stamped here — the DB lifecycle trigger owns them.
 */
function resolveStatusTransition(
  current: { status: string; deleted_at?: string | null } | null,
  requested: string,
): { status: string } | { error: string } {
  if (!CONTENT_STATUSES.includes(requested)) return { error: "حالة غير صالحة." };
  if (current && current.status === requested) return { status: requested };
  if (requested === "published") {
    if (!current || current.deleted_at || !PUBLISHABLE_FROM.includes(current.status)) {
      return { error: "النشر مسموح فقط من حالة (بانتظار المراجعة) أو (غير منشور)." };
    }
    return { status: requested };
  }
  if (current?.status === "published" && ["draft", "pending", "unpublished"].includes(requested)) {
    return { status: "unpublished" };
  }
  if (requested === "unpublished" && current?.status !== "published") {
    return { error: "لا يمكن إلغاء نشر مادة غير منشورة." };
  }
  // New rows (no current) are not transitions; existing rows must follow the matrix.
  if (current && !(LEGAL_TRANSITIONS[current.status] ?? []).includes(requested)) {
    return { error: "انتقال غير مسموح بين حالات المحتوى." };
  }
  return { status: requested };
}

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
  const admin = await requireStaff();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (title.length < 4) return { error: "العنوان قصير جداً." };

  const type = String(formData.get("type") ?? "news");
  let status = String(formData.get("status") ?? "draft");
  const category_slug = String(formData.get("category_slug") ?? "") || null;
  const excerpt = String(formData.get("excerpt") ?? "").replace(/\r\n/g, "\n").trim() || null;
  const ai_summary = String(formData.get("ai_summary") ?? "").trim() || null;
  const body = String(formData.get("body") ?? "").replace(/\r\n/g, "\n").trim() || null;
  const cover_image_url = String(formData.get("cover_image_url") ?? "").trim() || null;
  const cover_credit_name = String(formData.get("cover_credit_name") ?? "").trim() || null;
  const cover_credit_url = String(formData.get("cover_credit_url") ?? "").trim() || null;
  const source_name = String(formData.get("source_name") ?? "").trim() || null;
  const source_url = String(formData.get("source_url") ?? "").trim() || null;
  const video_url = String(formData.get("video_url") ?? "").trim() || null;
  const video_duration = String(formData.get("video_duration") ?? "").trim() || null;
  const readRaw = String(formData.get("read_minutes") ?? "").trim();
  const read_minutes = readRaw ? Number(readRaw) : null;
  let is_breaking = formData.get("is_breaking") === "on";
  let is_featured = formData.get("is_featured") === "on";
  // Homepage/breaking flags are admin-scope: editors cannot set them. On update
  // the existing values are preserved (keys omitted below); on create → false.
  const flagsLocked = admin.role === "editor";
  if (flagsLocked) {
    is_breaking = false;
    is_featured = false;
  }

  const slug = String(formData.get("slug") ?? "").trim() || slugify(title);
  // No published_at here: the DB lifecycle trigger owns publication dates (an
  // edit of a live article must never move its original publication date).

  let contentId = id;
  // Pre-edit snapshot for the editorial feedback loop (observational only):
  // captured BEFORE the update so the AI-original baseline and change events
  // can be derived. Feedback capture is best-effort and never blocks saving.
  let prevRow: ContentSnapshot | null = null;

  if (id) {
    const { data: prevData } = await supabase
      .from("content")
      .select(`${SNAPSHOT_FIELDS},deleted_at`)
      .eq("id", id)
      .maybeSingle();
    prevRow = (prevData as unknown as ContentSnapshot) ?? null;
    // Same publish rule as setStatus — the form's status select cannot bypass it.
    const prev = prevData as unknown as { status: string; deleted_at: string | null } | null;
    if (!prev || prev.status !== status) {
      const next = resolveStatusTransition(prev, status);
      if ("error" in next) return { error: next.error };
      status = next.status;
    }
  } else {
    // New manual articles always begin as drafts — publishing goes through the
    // normal lifecycle (draft → pending → published), never directly on create.
    status = "draft";
  }

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
  } satisfies Partial<TablesInsert<"content">>;

  if (id) {
    const updatePayload: Record<string, unknown> = { ...payload };
    if (flagsLocked) {
      delete updatePayload.is_breaking;
      delete updatePayload.is_featured;
    }
    const { error } = await supabase
      .from("content")
      .update(updatePayload as unknown as never)
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

  // Editorial feedback (observational): baseline + change events. Best-effort;
  // a feedback failure never affects the save that already succeeded.
  if (prevRow) {
    try {
      await ensureAiBaseline(prevRow);
      const events = saveChangeEvents(
        prevRow,
        { category_slug, source_url, source_name, cover_image_url },
        admin.id,
      );
      if (prevRow.status === "published" && status !== "published") {
        events.push({
          content_id: contentId,
          action: "unpublish",
          actor_id: admin.id,
          origin: prevRow.origin,
          before_value: "published",
          after_value: status,
        });
      }
      await logFeedbackEvents(events);
      if (prevRow.status !== "published" && status === "published") {
        await recordPublishFeedback(contentId, admin.id, prevRow.status);
      }
    } catch (e) {
      console.error("[feedback] saveContent capture failed:", e);
    }
  }

  revalidatePath("/admin/content");
  revalidatePath("/");
  // Stay on the editor and surface next-action buttons (return to list / publish
  // / delete / continue editing). The saved id lets a freshly-created item keep
  // editing the same row instead of inserting a duplicate.
  return { ok: true, id: contentId, status };
}

export async function setStatus(formData: FormData): Promise<{ ok: true } | { error: string }> {
  const admin = await requireStaff();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const requested = String(formData.get("status"));
  const { data } = await supabase
    .from("content")
    .select("status,origin,deleted_at")
    .eq("id", id)
    .maybeSingle();
  const row = data as { status: string; origin: string; deleted_at: string | null } | null;
  // Publication is only ever permitted from `pending` (the intended flow is
  // Writer → Editorial Director → Fidelity → pending → human review → publish)
  // or from `unpublished` (republish, original date restored by the DB). A
  // draft/rejected/published/deleted row can never be published here.
  // Unpublishing a live article lands on `unpublished`.
  const next = resolveStatusTransition(row, requested);
  if ("error" in next) return { error: next.error };
  // Same-status request (e.g. publishing an already-published row): no write,
  // no feedback event.
  if (row && row.status === next.status) return { ok: true };
  const status = next.status;
  // Publication dates are stamped by the DB lifecycle trigger, not here.
  const patch = { status };
  const { error } = await supabase
    .from("content")
    .update(patch as unknown as never)
    .eq("id", id);
  // Editorial feedback (observational, best-effort — never affects the flip).
  if (!error && row) {
    if (status === "published") {
      await recordPublishFeedback(id, admin.id, row.status);
    } else if (row.status === "published" && status !== "published") {
      await logFeedbackEvents([
        {
          content_id: id,
          action: "unpublish",
          actor_id: admin.id,
          origin: row.origin,
          before_value: "published",
          after_value: status,
        },
      ]);
    }
  }
  revalidatePath("/admin/content");
  revalidatePath("/");
  if (error) return { error: "تعذّر تحديث الحالة." };
  return { ok: true };
}

/** `<form action>` adapter for `setStatus` (form actions must return void). */
export async function setStatusForm(formData: FormData): Promise<void> {
  await setStatus(formData);
}

export async function softDeleteContent(formData: FormData) {
  await requireStaff();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  await supabase
    .from("content")
    .update({ deleted_at: new Date().toISOString() } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/content");
  revalidatePath("/");
}

/**
 * Restore a soft-deleted content item from المحذوفات (clears deleted_at). The
 * DB lifecycle trigger stamps the restore in the audit log and flips a
 * previously-published row to `unpublished` — a restore never puts an article
 * back on the public site by itself. Returns the post-restore status so the UI
 * can offer an explicit «إعادة النشر».
 */
export async function restoreContent(
  id: string,
): Promise<{ error: string } | { ok: true; status: string; title: string }> {
  await requireStaff();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content")
    .update({ deleted_at: null } as unknown as never)
    .eq("id", String(id))
    .not("deleted_at", "is", null)
    .select("status,title")
    .maybeSingle();
  if (error) return { error: "تعذّرت استعادة المادة." };
  if (!data) return { error: "المادة غير موجودة في المحذوفات." };
  revalidatePath("/admin/content");
  revalidatePath("/");
  const row = data as { status: string; title: string };
  return { ok: true, status: row.status, title: row.title };
}

export type RestoreVersionResult =
  | { ok: true; noChange: boolean; newVersion: number | null }
  | { error: string };

/** Arabic message for a `{ ok: false, reason }` from restore_content_version. */
function restoreReasonAr(reason: unknown): string {
  // The RPC returns ready-to-show Arabic reasons — pass them through verbatim.
  if (typeof reason === "string" && /[؀-ۿ]/.test(reason)) return reason;
  const r = String(reason ?? "").toLowerCase();
  if (r.includes("delet") || r.includes("trash")) {
    return "المادة في المحذوفات — استعدها من المحذوفات أولًا ثم أعد المحاولة.";
  }
  if (r.includes("version")) return "هذا الإصدار غير موجود.";
  if (r.includes("not_found") || r.includes("not found") || r.includes("content")) {
    return "المادة غير موجودة.";
  }
  return "تعذّرت استعادة الإصدار.";
}

/**
 * Restore an article's editable content to a stored version via the
 * `restore_content_version` RPC (CMS Phase 4). The RPC never changes status,
 * flags, dates or slug; the DB trigger snapshots the current content as a new
 * version and logs a single `version_restored` event. Staff access (editor and
 * above: requireStaff + the RPC's own is_staff() check).
 */
export async function restoreContentVersion(
  contentId: string,
  versionNo: number,
): Promise<RestoreVersionResult> {
  await requireStaff();
  const id = String(contentId);
  const v = Number(versionNo);
  if (!Number.isSafeInteger(v) || v < 1) return { error: "رقم إصدار غير صالح." };
  const supabase = await createClient();
  const { data: before } = await supabase.from("content").select("slug").eq("id", id).maybeSingle();
  // RPC is not in the generated Database types until regenerated post-migration.
  const client = supabase as unknown as SupabaseClient;
  const { data, error } = await client.rpc("restore_content_version", {
    p_content_id: id,
    p_version_no: v,
  });
  if (error) {
    console.error("[content] restore_content_version failed:", error.message);
    return {
      error: error.code === "42501" ? "ليست لديك صلاحية لاستعادة الإصدارات." : "تعذّرت استعادة الإصدار.",
    };
  }
  const res = (data ?? {}) as {
    ok?: boolean;
    no_change?: boolean;
    new_version?: number;
    reason?: string;
    error?: string;
  };
  if (!res.ok) return { error: restoreReasonAr(res.reason ?? res.error) };
  revalidatePath(`/admin/content/${id}`);
  revalidatePath("/admin/content");
  revalidatePath("/");
  const slug = (before as { slug: string } | null)?.slug;
  if (slug) revalidatePath(`/article/${slug}`);
  return { ok: true, noChange: !!res.no_change, newVersion: res.new_version ?? null };
}

/**
 * Reject a content item: an explicit editorial "no" for a pending (typically
 * AI-generated) article. Sets `status = "rejected"` WITHOUT deleting the row, so
 * the article stays stored for audit/history. Rejected content never appears
 * publicly (every public query filters `status = "published"`), and this never
 * stamps `published_at` — publishing remains a separate, explicit action.
 */
export async function rejectContent(formData: FormData) {
  const admin = await requireStaff();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  // Optional lightweight structured reason (clamped to the small taxonomy —
  // anything else is treated as "no reason given").
  const reason = normalizeRejectReason(formData.get("reason"));
  // Optional free-text note. The reason column holds the clamped taxonomy code
  // (grouped by exact value in analytics), so the note rides in the event's
  // existing `meta` jsonb instead of being appended to the code.
  const note = String(formData.get("note") ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const { data } = await supabase
    .from("content")
    .select("status,origin,deleted_at")
    .eq("id", id)
    .maybeSingle();
  const row = data as { status: string; origin: string; deleted_at: string | null } | null;
  if (!row || row.deleted_at) return;
  // Rejection is only legal from `pending` (DB matrix; anything else would hit
  // P0021 → 500). Already rejected → silent no-op; any other status → refused
  // without a write (form-action signature has no error channel, like setStatus).
  if (row.status !== "pending") return;
  const { error } = await supabase
    .from("content")
    .update({ status: "rejected" } as unknown as never)
    .eq("id", id);
  // Editorial feedback (observational, best-effort — never affects the reject).
  if (!error) {
    await logFeedbackEvents([
      {
        content_id: id,
        action: "reject",
        actor_id: admin.id,
        origin: row.origin,
        reason,
        before_value: row.status,
        after_value: "rejected",
        ...(note ? { meta: { note } } : {}),
      },
    ]);
  }
  revalidatePath("/admin/content");
  revalidatePath("/");
}

/** Per-item note in a bulk report (skipped or failed). */
export type BulkItemNote = { id: string; title: string; reason: string };

/**
 * Per-item outcome of a bulk action, so the admin sees exactly what happened.
 * `skipped` = deliberately not acted on (ineligible), `failed` = attempted but
 * errored. Neither is ever silently swallowed.
 */
export type BulkActionResult = {
  succeeded: number;
  skipped: BulkItemNote[];
  failed: BulkItemNote[];
};

type ContentRow = { id: string; title: string; status: string; deleted_at: string | null };

/** Load the current rows (title/status/deleted_at) so bulk actions can enforce
 * eligibility and name each item in the report. */
async function contentRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<Map<string, ContentRow>> {
  const map = new Map<string, ContentRow>();
  if (ids.length === 0) return map;
  const { data } = await supabase
    .from("content")
    .select("id,title,status,deleted_at")
    .in("id", ids);
  for (const r of (data as ContentRow[]) ?? []) map.set(r.id, r);
  return map;
}

/**
 * Bulk status change (e.g. publish selected). This is a HUMAN ADMIN action and
 * applies the SAME update `setStatus` uses for a single item — identical patch
 * (publication dates are stamped by the DB lifecycle trigger) — one row at a
 * time so a single failure never aborts the rest. It does NOT run or bypass
 * Writer / Editorial Director / Fidelity: publishing is only ever a status flip.
 *
 * Eligibility: publication is only ever permitted from `pending` or
 * `unpublished` (republish) — matching the single-item Publish rule and the
 * intended flow (Writer → Editorial Director → Fidelity → pending → human
 * review → publish). draft / rejected / already published / deleted rows are
 * skipped with an exact reason, never force-published.
 */
export async function bulkSetStatus(ids: string[], status: string): Promise<BulkActionResult> {
  const admin = await requireStaff();
  const supabase = await createClient();
  const clean = [...new Set((ids ?? []).map(String))].filter(Boolean);
  const rows = await contentRows(supabase, clean);
  const skipped: BulkItemNote[] = [];
  const failed: BulkItemNote[] = [];
  let succeeded = 0;
  for (const id of clean) {
    const row = rows.get(id);
    if (!row || row.deleted_at) {
      skipped.push({ id, title: row?.title ?? id, reason: "العنصر غير موجود أو محذوف." });
      continue;
    }
    const next = resolveStatusTransition(row, status);
    if ("error" in next) {
      skipped.push({ id, title: row.title, reason: next.error });
      continue;
    }
    if (row.status === next.status) {
      skipped.push({
        id,
        title: row.title,
        reason:
          status === "published"
            ? "منشور بالفعل — غير مؤهّل للنشر الجماعي."
            : "الحالة الحالية مطابقة للمطلوبة.",
      });
      continue;
    }
    // Publication dates are stamped by the DB lifecycle trigger, not here.
    const patch = { status: next.status };
    const { error } = await supabase.from("content").update(patch as unknown as never).eq("id", id);
    if (error) failed.push({ id, title: row.title, reason: error.message });
    else {
      succeeded++;
      // Editorial feedback (observational, best-effort per row).
      if (next.status === "published") await recordPublishFeedback(id, admin.id, row.status);
    }
  }
  revalidatePath("/admin/content");
  revalidatePath("/");
  return { succeeded, skipped, failed };
}

/** Bulk soft-delete: same `deleted_at` stamp `softDeleteContent` uses, per row,
 * collecting per-item outcomes rather than aborting on the first error. Rows
 * that are missing or already deleted are skipped (nothing to do). */
export async function bulkSoftDelete(ids: string[]): Promise<BulkActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const clean = [...new Set((ids ?? []).map(String))].filter(Boolean);
  const rows = await contentRows(supabase, clean);
  const stamp = new Date().toISOString();
  const skipped: BulkItemNote[] = [];
  const failed: BulkItemNote[] = [];
  let succeeded = 0;
  for (const id of clean) {
    const row = rows.get(id);
    if (!row || row.deleted_at) {
      skipped.push({ id, title: row?.title ?? id, reason: "العنصر غير موجود أو محذوف مسبقاً." });
      continue;
    }
    const { error } = await supabase
      .from("content")
      .update({ deleted_at: stamp } as unknown as never)
      .eq("id", id);
    if (error) failed.push({ id, title: row.title, reason: error.message });
    else succeeded++;
  }
  revalidatePath("/admin/content");
  revalidatePath("/");
  return { succeeded, skipped, failed };
}

/**
 * Manually set (or clear) an item's primary category from the content inbox.
 * The admin is always allowed to override the AI's category. The slug is
 * validated against the live `categories` table (the single source of truth);
 * an empty value clears it back to "needs review".
 */
export async function setCategory(
  id: string,
  slug: string,
): Promise<{ error: string } | { ok: true }> {
  const admin = await requireStaff();
  const supabase = await createClient();
  const category_slug = String(slug ?? "").trim() || null;
  if (category_slug) {
    const { data } = await supabase
      .from("categories")
      .select("slug")
      .eq("slug", category_slug)
      .maybeSingle();
    if (!data) return { error: "قسم غير معروف." };
  }
  const { data: prevData } = await supabase
    .from("content")
    .select("category_slug,origin")
    .eq("id", String(id))
    .maybeSingle();
  const prev = prevData as { category_slug: string | null; origin: string } | null;
  const { error } = await supabase
    .from("content")
    .update({ category_slug } as unknown as never)
    .eq("id", String(id));
  if (error) return { error: "تعذّر تحديث القسم." };
  // Editorial feedback (observational): AI-predicted category → editor choice.
  if (prev && (prev.category_slug ?? "") !== (category_slug ?? "")) {
    await logFeedbackEvents([
      {
        content_id: String(id),
        action: "category_change",
        actor_id: admin.id,
        origin: prev.origin,
        before_value: prev.category_slug,
        after_value: category_slug,
      },
    ]);
  }
  revalidatePath("/admin/content");
  revalidatePath("/");
  return { ok: true };
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

/**
 * Whether `actor` may act on `target` (suspend / change role / reset password).
 * The rule set lives in `@/lib/roles` (shared with the users-page UI); this is
 * the authoritative server-side check. Owner manages every non-owner account;
 * super_admin manages admin/editor (and legacy user) accounts only.
 */
function canManage(actor: Profile, target: { id: string; role: string }): boolean {
  return canManageTarget(actor, target);
}

/**
 * Best-effort record of a refused account-management attempt in
 * admin_audit_log (via the `log_admin_denied` SECURITY DEFINER RPC, which
 * snapshots the actor from the session). Never throws, never blocks the refusal.
 * The RPC is not in the generated Database types until regenerated.
 */
async function logDenied(action: string, targetId: string | null, detail: string): Promise<void> {
  try {
    const supabase = (await createClient()) as unknown as SupabaseClient;
    const { error } = await supabase.rpc("log_admin_denied", {
      p_action: action,
      p_target: targetId && /^[0-9a-f-]{36}$/i.test(targetId) ? targetId : null,
      p_detail: detail,
    });
    if (error) console.error("[users] log_admin_denied failed:", error.message);
  } catch (e) {
    console.error("[users] log_admin_denied threw:", e);
  }
}

/**
 * Change a target's role within the actor's assignable set (owner: super_admin
 * / admin / editor; super_admin: admin / editor). Written through the actor's
 * own session (RLS profiles_update_own_or_manager) so the DB guard
 * guard_profile_changes enforces the same rules AND admin_audit_log attributes
 * the change to the real actor (a service-role write would be logged as system).
 */
export async function setAdminRole(formData: FormData) {
  const actor = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!canAssignRole(actor.role, role)) {
    await logDenied("change_role", id, `role=${role}`);
    return;
  }

  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id, role").eq("id", id).maybeSingle();
  const target = data as { id: string; role: string } | null;
  if (!target) return;
  if (!canManage(actor, target)) {
    await logDenied("change_role", id, `${target.role}→${role}`);
    return;
  }
  if (target.role === role) return;

  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ role } as never)
    .eq("id", id)
    .select("id");
  if (error || !updated?.length) {
    console.error("[users] setAdminRole failed:", error?.message ?? "no row updated (RLS)");
  }
  revalidatePath("/admin/users");
}

/**
 * Suspend or re-activate a target account. The profile flag is authoritative
 * (requireStaff/requireAdmin, is_staff()/is_admin() all refuse disabled
 * profiles on the next request); additionally, best-effort, the auth user is
 * banned (~10 years) / un-banned so it cannot refresh its session or sign in.
 * A ban failure is logged, never fails the suspension. Written through the
 * actor's session for DB-guard enforcement + correct audit attribution.
 */
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
  if (!target) return;
  if (!canManage(actor, target)) {
    await logDenied(target.disabled ? "reactivate_user" : "suspend_user", id, `target_role=${target.role}`);
    return;
  }

  const disabled = !target.disabled;
  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ disabled } as never)
    .eq("id", id)
    .select("id");
  if (error || !updated?.length) {
    console.error("[users] toggleAdminDisabled failed:", error?.message ?? "no row updated (RLS)");
    revalidatePath("/admin/users");
    return;
  }

  try {
    const { error: banErr } = await admin.auth.admin.updateUserById(id, {
      ban_duration: disabled ? "87600h" : "none",
    });
    if (banErr) console.error("[users] auth ban update failed:", banErr.message);
  } catch (e) {
    console.error("[users] auth ban update threw:", e);
  }
  revalidatePath("/admin/users");
}

/**
 * Permanent account deletion is intentionally NOT available (owner decision:
 * suspend instead). Kept as an exported stub so any stale client reference
 * gets a clear refusal; the UI no longer offers it. The DB additionally blocks
 * deleting any owner row.
 */
export async function deleteAdmin(formData?: FormData): Promise<AdminUserResult> {
  await requireAdmin();
  const id = formData ? String(formData.get("id") ?? "") : "";
  await logDenied("delete_user", id || null, "permanent deletion disabled");
  return { error: "الحذف الدائم غير متاح — استخدم الإيقاف." };
}
