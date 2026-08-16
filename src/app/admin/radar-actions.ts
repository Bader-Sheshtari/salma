"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";

// Fast News Radar — one-click publish + on-demand translation server actions.
//
// These are the ONLY entry points that turn a Radar discovery into published
// Salma content, and they do so by REUSING the existing ingest-news targeted
// pilot (Writer v27 → Editorial Director → Fidelity) — there is NO parallel
// editorial pipeline. Radar itself never auto-publishes: publication begins only
// from an authenticated admin clicking نشر في سلمى, which these actions handle.

// --- publishRadarStory -------------------------------------------------------

export type PublishRadarResult =
  // Terminal success: content created AND auto-published (all checks clean).
  | { ok: true; status: "published"; contentId: string }
  // Content created but stopped safely at pending (needs human review); it is in
  // the normal Content Inbox. Not published.
  | { ok: true; status: "needs_review"; contentId: string; reason: string | null }
  // Already published earlier — idempotent no-op, link to the existing content.
  | { ok: true; status: "already_published"; contentId: string | null }
  // A publish job is already running for this exact article — no second start.
  | { status: "already_processing" }
  // Duplicate safety: the story already exists in Salma — do not create another.
  | { status: "already_in_salma"; matchedContentId: string | null }
  // Possible duplicate — require an explicit confirm before proceeding.
  | { status: "needs_confirmation"; matchedContentId: string | null }
  // Nothing was published: extraction/Writer/Editor/Fidelity rejected the story.
  | { status: "failed"; reason: string | null }
  | { error: string };

type RadarPublishRow = {
  id: string;
  url: string | null;
  duplicate_status: string | null;
  matched_content_id: string | null;
  expected_category_slug: string | null;
  publish_status: string | null;
  published_content_id: string | null;
};

type PilotReport = {
  created_content_id: string | null;
  needs_human_review: boolean;
  rejection_reason: string | null;
  fidelity: { decision: "clean" | "needs_human_review" | "reject" } | null;
  authorized_source_bypass?: boolean;
};

/**
 * Publish exactly ONE Radar story to Salma with a single authenticated click.
 *
 * Flow (all reused from the existing pipeline, nothing bypassed editorially):
 *   1. Load the radar row; enforce duplicate safety (already_in_salma blocks;
 *      possible_duplicate requires confirmPossibleDuplicate).
 *   2. Idempotency latch: compare-and-swap publish_status → 'processing' ONLY
 *      from NULL/'needs_review'. A losing racer / already-processing / already-
 *      published row does NOT start a second job.
 *   3. Run the ingest-news targeted pilot for this exact URL with a URL-scoped,
 *      admin-authorized source bypass (Writer v27 → Editorial Director →
 *      Fidelity, grounded on the ORIGINAL source, never on title_ar).
 *   4. Auto-publish ONLY when the pilot created content AND it is clean (no
 *      needs_human_review, fidelity decision 'clean'). Otherwise leave it at
 *      pending (needs review) in the normal Content Inbox — never force-publish.
 */
export async function publishRadarStory(
  radarId: string,
  opts?: { categorySlug?: string | null; confirmPossibleDuplicate?: boolean },
): Promise<PublishRadarResult> {
  const admin = await requireAdmin();
  const supabase = await createClient();
  const svc = createAdminClient() as unknown as SupabaseClient;

  const id = String(radarId ?? "").trim();
  if (!id) return { error: "معرّف غير صالح." };

  // 1) Load the radar row + enforce duplicate safety.
  const { data: rowData, error: rowErr } = await svc
    .from("radar_shadow_articles")
    .select("id,url,duplicate_status,matched_content_id,expected_category_slug,publish_status,published_content_id")
    .eq("id", id)
    .maybeSingle();
  if (rowErr) return { error: "تعذّر قراءة الخبر." };
  const row = rowData as RadarPublishRow | null;
  if (!row || !row.url) return { error: "الخبر غير موجود أو بلا رابط مصدر." };

  if (row.publish_status === "published") {
    return { ok: true, status: "already_published", contentId: row.published_content_id };
  }
  if (row.publish_status === "processing") {
    return { status: "already_processing" };
  }
  if (row.duplicate_status === "already_in_salma") {
    return { status: "already_in_salma", matchedContentId: row.matched_content_id };
  }
  if (row.duplicate_status === "possible_duplicate" && !opts?.confirmPossibleDuplicate) {
    return { status: "needs_confirmation", matchedContentId: row.matched_content_id };
  }

  // 2) Idempotency compare-and-swap. Only NULL / 'needs_review' may start a run;
  //    the same statement stamps the authorization audit. 0 rows updated → a
  //    concurrent click already latched it → no second publish flow.
  const { data: latched, error: latchErr } = await svc
    .from("radar_shadow_articles")
    .update({
      publish_status: "processing",
      publish_authorized_by: admin.id,
      publish_authorized_at: new Date().toISOString(),
      publish_error: null,
    } as unknown as never)
    .eq("id", id)
    .or("publish_status.is.null,publish_status.eq.needs_review")
    .select("id");
  if (latchErr) return { error: "تعذّر بدء النشر." };
  if (!latched || latched.length === 0) {
    return { status: "already_processing" };
  }

  // From here a run is committed to this article. Any early return MUST leave a
  // terminal state (published / needs_review), never a stuck 'processing'.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      await resetToNeedsReview(svc, id, "session_expired");
      return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };
    }

    // 3) Run the targeted pilot with the URL-scoped human authorization. The URL
    //    is taken from the radar row (not free text), and radar_authorized_source
    //    binds the registry bypass to exactly this URL.
    const { data, error } = await supabase.functions.invoke("ingest-news", {
      body: {
        writer_mode: "pilot",
        pilot_limit: 1,
        pilot_source_url: row.url,
        radar_authorized_source: true,
      },
      headers: { Authorization: `Bearer ${token}` },
    });

    if (error || !data || data.ok === false) {
      await resetToNeedsReview(svc, id, "ingest_invoke_failed");
      return { status: "failed", reason: "ingest_invoke_failed" };
    }

    const pilot = (data.pilot ?? null) as PilotReport | null;
    const contentId = pilot?.created_content_id ?? null;

    // 4a) No content row → extraction/Writer/Editor/Fidelity rejected it. Nothing
    //     published; mark needs_review (retryable) with the rejection reason.
    if (!contentId) {
      const reason = pilot?.rejection_reason ?? "no_content_created";
      await resetToNeedsReview(svc, id, reason);
      return { status: "failed", reason };
    }

    // 4b) Content created but not clean → leave it pending in the Content Inbox
    //     for human review. Do NOT auto-publish.
    const clean = pilot?.needs_human_review === false && pilot?.fidelity?.decision === "clean";
    if (!clean) {
      await svc
        .from("radar_shadow_articles")
        .update({
          publish_status: "needs_review",
          published_content_id: contentId,
          publish_error: pilot?.rejection_reason ?? "needs_human_review",
        } as unknown as never)
        .eq("id", id);
      revalidatePath("/admin/radar");
      revalidatePath("/admin/content");
      return { ok: true, status: "needs_review", contentId, reason: pilot?.rejection_reason ?? null };
    }

    // 4c) Clean → apply the (optional) category override, then flip the pending
    //     row to published. Publication is only ever from 'pending' (mirrors
    //     setStatus), so a non-pending row is never force-published.
    const categorySlug = await resolveCategory(svc, opts?.categorySlug ?? row.expected_category_slug ?? null);
    const publishPatch: Record<string, unknown> = {
      status: "published",
      published_at: new Date().toISOString(),
    };
    if (categorySlug) publishPatch.category_slug = categorySlug;

    const { data: published } = await svc
      .from("content")
      .update(publishPatch as unknown as never)
      .eq("id", contentId)
      .eq("status", "pending")
      .is("deleted_at", null)
      .select("id");

    if (!published || published.length === 0) {
      // The content wasn't in a publishable 'pending' state (already published,
      // rejected, or deleted). Link it and leave for human review rather than
      // forcing a state change.
      await svc
        .from("radar_shadow_articles")
        .update({
          publish_status: "needs_review",
          published_content_id: contentId,
          publish_error: "content_not_pending",
        } as unknown as never)
        .eq("id", id);
      revalidatePath("/admin/radar");
      revalidatePath("/admin/content");
      return { ok: true, status: "needs_review", contentId, reason: "content_not_pending" };
    }

    await svc
      .from("radar_shadow_articles")
      .update({
        publish_status: "published",
        published_content_id: contentId,
        publish_error: null,
      } as unknown as never)
      .eq("id", id);

    revalidatePath("/admin/radar");
    revalidatePath("/admin/content");
    revalidatePath("/");
    return { ok: true, status: "published", contentId };
  } catch {
    await resetToNeedsReview(svc, id, "unexpected_error");
    return { status: "failed", reason: "unexpected_error" };
  }
}

/** Release the idempotency latch back to a retryable terminal state. */
async function resetToNeedsReview(svc: SupabaseClient, id: string, reason: string): Promise<void> {
  await svc
    .from("radar_shadow_articles")
    .update({ publish_status: "needs_review", publish_error: reason } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/radar");
}

/** Validate a category slug against the live categories table; null if unknown. */
async function resolveCategory(svc: SupabaseClient, slug: string | null): Promise<string | null> {
  const s = String(slug ?? "").trim();
  if (!s) return null;
  const { data } = await svc.from("categories").select("slug").eq("slug", s).maybeSingle();
  return data ? s : null;
}

// --- translateRadarStory -----------------------------------------------------

export type TranslateRadarResult =
  | { ok: true; titleOriginal: string | null; text: string; sourceUrl: string | null }
  | { error: string };

/**
 * On-demand full-article Arabic translation (reading aid ONLY). Forwards the
 * admin JWT to the radar-translate function, which re-extracts the ORIGINAL
 * source via the SSRF-hardened path and translates it faithfully. The result is
 * NEVER persisted and NEVER used as Writer input.
 */
export async function translateRadarStory(radarId: string): Promise<TranslateRadarResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(radarId ?? "").trim();
  if (!id) return { error: "معرّف غير صالح." };

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("radar-translate", {
    body: { radar_article_id: id },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error || !data || data.ok === false) {
    return { error: "تعذّرت ترجمة الخبر. قد يكون المصدر غير قابل للاستخراج." };
  }
  return {
    ok: true,
    titleOriginal: (data.title_original as string | null) ?? null,
    text: String(data.translated_text ?? ""),
    sourceUrl: (data.source_url as string | null) ?? null,
  };
}
