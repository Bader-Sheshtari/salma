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
  publish_authorized_at: string | null;
  // Event Registry identifiers (trusted, from the stored radar row) used ONLY to
  // recover the EXACT SAME article's body when direct extraction fails, and to
  // preserve the original publisher name as the editorial source. Never operator
  // free text; forwarded to ingest-news only alongside the URL-scoped bypass.
  provider: string | null;
  provider_uri: string | null;
  source_title: string | null;
  // Original source language (ISO code), forwarded so ingest-news reads the
  // source's numbers with the correct locale (locale-aware numeric grounding).
  language: string | null;
};

/**
 * Publish exactly ONE Radar story to Salma with a single authenticated click.
 *
 * Flow (all reused from the existing pipeline, nothing bypassed editorially):
 *   1. Load the radar row; enforce duplicate safety (already_in_salma blocks;
 *      possible_duplicate requires confirmPossibleDuplicate).
 *   2. Idempotency latch: compare-and-swap publish_status → 'processing' ONLY
 *      from a retryable state (NULL/'needs_review'/'failed'). A losing racer /
 *      already-processing / already-published row does NOT start a second job.
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
    .select("id,url,duplicate_status,matched_content_id,expected_category_slug,publish_status,published_content_id,publish_authorized_at,provider,provider_uri,source_title,language")
    .eq("id", id)
    .maybeSingle();
  if (rowErr) return { error: "تعذّر قراءة الخبر." };
  const row = rowData as RadarPublishRow | null;
  if (!row || !row.url) return { error: "الخبر غير موجود أو بلا رابط مصدر." };

  if (row.publish_status === "published") {
    return { ok: true, status: "already_published", contentId: row.published_content_id };
  }
  if (row.publish_status === "processing") {
    // Self-recovery: a row can only remain 'processing' if a run was genuinely
    // abandoned (the Edge Function now writes the terminal state before it
    // returns 200). If the authorization is older than the conservative
    // threshold, release it to retryable 'failed' and fall through to re-latch;
    // otherwise a legitimate run may still be in flight — do not disturb it.
    const released = await recoverStaleProcessing(svc, id, row.publish_authorized_at);
    if (!released) return { status: "already_processing" };
  }
  if (row.duplicate_status === "already_in_salma") {
    return { status: "already_in_salma", matchedContentId: row.matched_content_id };
  }
  if (row.duplicate_status === "possible_duplicate" && !opts?.confirmPossibleDuplicate) {
    return { status: "needs_confirmation", matchedContentId: row.matched_content_id };
  }

  // 2) Idempotency compare-and-swap. A run may start ONLY from a genuinely
  //    retryable state, enforced server-side (not just in the UI):
  //      • publish_status IS NULL            → never attempted
  //      • publish_status = 'failed'         → pre-Content rejection (retryable)
  //      • publish_status = 'needs_review'   → ONLY when published_content_id IS
  //        NULL (a legacy row from before the failed-state split). A needs_review
  //        row that DOES have a Content id is a real item awaiting human review —
  //        it must be opened/reviewed, never re-run (would risk a duplicate).
  //    'published' / 'processing' never match. The same statement stamps the
  //    authorization audit; 0 rows updated → nothing retryable → no second flow.
  const { data: latched, error: latchErr } = await svc
    .from("radar_shadow_articles")
    .update({
      publish_status: "processing",
      publish_authorized_by: admin.id,
      publish_authorized_at: new Date().toISOString(),
      publish_error: null,
    } as unknown as never)
    .eq("id", id)
    .or("publish_status.is.null,publish_status.eq.failed,and(publish_status.eq.needs_review,published_content_id.is.null)")
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
      await markPublishFailed(svc, id, "session_expired");
      return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };
    }

    // 3) Run the targeted pilot with the URL-scoped human authorization. The URL
    //    is taken from the radar row (not free text), and radar_authorized_source
    //    binds the registry bypass to exactly this URL. radar_article_id +
    //    radar_category_slug hand terminal-state ownership to ingest-news: it
    //    writes the final radar state (published / needs_review / failed) BEFORE
    //    returning, so the outcome survives even if this action is terminated.
    const { data, error } = await supabase.functions.invoke("ingest-news", {
      body: {
        writer_mode: "pilot",
        pilot_limit: 1,
        pilot_source_url: row.url,
        radar_authorized_source: true,
        radar_article_id: id,
        radar_category_slug: opts?.categorySlug ?? row.expected_category_slug ?? null,
        // Exact-article source fallback + original-publisher preservation. These
        // are read from the trusted radar row above (never client input) and are
        // honored by ingest-news only alongside the URL-scoped authorization.
        radar_provider: row.provider,
        radar_provider_uri: row.provider_uri,
        radar_source_title: row.source_title,
        // Source language → locale-aware numeric grounding in the validator.
        radar_source_lang: row.language,
      },
      headers: { Authorization: `Bearer ${token}` },
    });

    // Orchestration, not terminal authority: the Edge Function already wrote the
    // terminal radar state. On a transport/500 error the write may or may not
    // have happened, so we reconcile by reading the row back rather than
    // assuming failure. Only if the row is STILL 'processing' (the write truly
    // never landed) do we finalize it here as retryable 'failed'.
    if (error || !data || data.ok === false) {
      return await reconcileAfterInvoke(svc, id, "ingest_invoke_failed");
    }

    // Preferred path: map the terminal outcome the Edge Function reported. This
    // is a mirror of the DB write it already performed, not an independent one.
    const rp = (data.radar_publish ?? null) as EdgeRadarPublish | null;
    if (rp) {
      revalidatePath("/admin/radar");
      revalidatePath("/admin/content");
      if (rp.status === "published") {
        revalidatePath("/");
        return { ok: true, status: "published", contentId: rp.content_id };
      }
      if (rp.status === "needs_review") {
        return { ok: true, status: "needs_review", contentId: rp.content_id, reason: rp.reason };
      }
      return { status: "failed", reason: rp.reason };
    }

    // Defensive fallback (older Edge Function without radar_publish): reconcile
    // from the row the function should have written.
    return await reconcileAfterInvoke(svc, id, "no_content_created");
  } catch {
    // The invoke itself threw. The Edge Function may still have written a
    // terminal state; reconcile rather than blindly overwriting.
    return await reconcileAfterInvoke(svc, id, "unexpected_error");
  }
}

/** Terminal outcome echoed by ingest-news (radar_publish). content_id matches
 *  the created Content row; reason is an internal code (may be null). */
type EdgeRadarPublish =
  | { status: "published"; content_id: string }
  | { status: "needs_review"; content_id: string; reason: string | null }
  | { status: "failed"; reason: string | null };

/**
 * Reconcile the UI result from the current DB row after an invoke that did not
 * yield a usable radar_publish outcome (transport error, 500, or legacy
 * function). The Edge Function owns the terminal write; here we only READ it. If
 * the row is already terminal we surface that; if it is STILL 'processing' the
 * write never landed, so we release it to retryable 'failed' with `fallbackReason`.
 */
async function reconcileAfterInvoke(
  svc: SupabaseClient,
  id: string,
  fallbackReason: string,
): Promise<PublishRadarResult> {
  const { data } = await svc
    .from("radar_shadow_articles")
    .select("publish_status,published_content_id,publish_error")
    .eq("id", id)
    .maybeSingle();
  const r = data as
    | { publish_status: string | null; published_content_id: string | null; publish_error: string | null }
    | null;

  if (r?.publish_status === "published") {
    revalidatePath("/admin/radar");
    revalidatePath("/admin/content");
    revalidatePath("/");
    return r.published_content_id
      ? { ok: true, status: "published", contentId: r.published_content_id }
      : { ok: true, status: "already_published", contentId: null };
  }
  if (r?.publish_status === "needs_review" && r.published_content_id) {
    revalidatePath("/admin/radar");
    revalidatePath("/admin/content");
    return { ok: true, status: "needs_review", contentId: r.published_content_id, reason: r.publish_error };
  }
  if (r?.publish_status === "failed") {
    revalidatePath("/admin/radar");
    return { status: "failed", reason: r.publish_error };
  }

  // Still processing (or unreadable) → the terminal write never landed. Release
  // the latch to retryable 'failed' so the click never orphans in 'processing'.
  await markPublishFailed(svc, id, fallbackReason);
  return { status: "failed", reason: fallbackReason };
}

// Conservative stale-processing threshold. The Edge Function writes the terminal
// state before returning 200, so a row older than this in 'processing' reflects
// a genuinely abandoned run (crash / timeout), not one still in flight.
const STALE_PROCESSING_MS = 5 * 60 * 1000;

/**
 * Release a genuinely stale 'processing' latch to retryable 'failed'. Returns
 * true only when it actually released a row (authorized before the threshold and
 * still 'processing'), so the caller may re-latch and retry. A fresh run is left
 * untouched (returns false). Scoped to publish_status='processing' so it can
 * never disturb a row that already reached a terminal state.
 */
async function recoverStaleProcessing(
  svc: SupabaseClient,
  id: string,
  authorizedAt: string | null,
): Promise<boolean> {
  if (!authorizedAt) return false;
  const ageMs = Date.now() - new Date(authorizedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < STALE_PROCESSING_MS) return false;
  const { data } = await svc
    .from("radar_shadow_articles")
    .update({ publish_status: "failed", publish_error: "processing_timeout" } as unknown as never)
    .eq("id", id)
    .eq("publish_status", "processing")
    .select("id");
  return !!data && data.length > 0;
}

// --- getRadarPublishStates ---------------------------------------------------

export type RadarPublishState = {
  publish_status: string | null;
  published_content_id: string | null;
  publish_error: string | null;
  // Slug of the linked content row (published/needs_review), for the UI link.
  slug: string | null;
};

/**
 * Lightweight status read for the Radar Inbox to poll while a publish is
 * 'processing' — it does NOT run the heavy ingestion pipeline. It also self-
 * heals: any polled row stuck in 'processing' past the stale threshold is
 * released to retryable 'failed' ('processing_timeout') in one scoped bulk
 * update (no cron). Returns a map keyed by radar id.
 */
export async function getRadarPublishStates(
  ids: string[],
): Promise<Record<string, RadarPublishState>> {
  await requireAdmin();
  const svc = createAdminClient() as unknown as SupabaseClient;

  const unique = [...new Set((ids ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (unique.length === 0) return {};

  // Self-heal genuinely stale 'processing' rows among the polled ids.
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  await svc
    .from("radar_shadow_articles")
    .update({ publish_status: "failed", publish_error: "processing_timeout" } as unknown as never)
    .in("id", unique)
    .eq("publish_status", "processing")
    .lt("publish_authorized_at", cutoff);

  const { data } = await svc
    .from("radar_shadow_articles")
    .select("id,publish_status,published_content_id,publish_error")
    .in("id", unique);
  const rows = (data ?? []) as {
    id: string;
    publish_status: string | null;
    published_content_id: string | null;
    publish_error: string | null;
  }[];

  // Resolve slugs for the linked content rows so the card can link directly.
  const contentIds = [...new Set(rows.map((r) => r.published_content_id).filter((x): x is string => !!x))];
  const slugById: Record<string, string> = {};
  if (contentIds.length > 0) {
    const { data: cRows } = await svc.from("content").select("id,slug").in("id", contentIds);
    for (const c of (cRows ?? []) as { id: string; slug: string }[]) slugById[c.id] = c.slug;
  }

  const out: Record<string, RadarPublishState> = {};
  for (const r of rows) {
    out[r.id] = {
      publish_status: r.publish_status,
      published_content_id: r.published_content_id,
      publish_error: r.publish_error,
      slug: r.published_content_id ? slugById[r.published_content_id] ?? null : null,
    };
  }
  return out;
}

/**
 * Release the idempotency latch to the retryable 'failed' state. Used ONLY when
 * the pipeline stopped before any Content row was created — source retrieval
 * failed, or Writer/Editorial Director/Fidelity/quotation validation rejected
 * the draft. This is deliberately NOT 'needs_review': there is no Content item
 * to review, so the Radar card surfaces it as an editorial-validation failure
 * with a retry (which simply re-runs the unchanged one-click pipeline).
 */
async function markPublishFailed(svc: SupabaseClient, id: string, reason: string): Promise<void> {
  await svc
    .from("radar_shadow_articles")
    .update({ publish_status: "failed", publish_error: reason } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/radar");
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
