import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  assessBodyEdit,
  assessTitleEdit,
  urlHost,
} from "@/lib/editorial-feedback";

/**
 * Editorial Feedback Loop V1 — write side (OBSERVATIONAL ONLY).
 *
 * Every function here is best-effort: feedback capture must NEVER make a
 * legitimate publish/reject/save unsafe, so all entry points swallow errors
 * after logging them. Writes go through the service-role client (same
 * convention as radar-actions.ts); the tables are read-only for admins via
 * RLS and append-only in practice.
 *
 * Nothing here (or anywhere in V1) feeds back into Radar ranking, ESL
 * scoring, lane/source weights or the Writer.
 */

export type FeedbackEvent = {
  content_id: string;
  action:
    | "publish"
    | "unpublish"
    | "reject"
    | "title_edit"
    | "body_edit"
    | "category_change"
    | "source_change"
    | "image_change";
  actor_id?: string | null;
  origin?: string | null;
  reason?: string | null;
  before_value?: string | null;
  after_value?: string | null;
  edit_ratio?: number | null;
  edit_magnitude?: "none" | "minor" | "moderate" | "major" | null;
  meta?: Record<string, unknown> | null;
};

/** Columns needed to snapshot/compare an article for feedback purposes. */
export type ContentSnapshot = {
  id: string;
  title: string;
  body: string | null;
  status: string;
  origin: string;
  category_slug: string | null;
  source_name: string | null;
  source_url: string | null;
  cover_image_url: string | null;
};

export const SNAPSHOT_FIELDS =
  "id,title,body,status,origin,category_slug,source_name,source_url,cover_image_url";

function svc(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

/** Insert feedback events; never throws. */
export async function logFeedbackEvents(events: FeedbackEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    const { error } = await svc().from("editorial_feedback_events").insert(events);
    if (error) console.error("[feedback] insert failed:", error.message);
  } catch (e) {
    console.error("[feedback] insert threw:", e);
  }
}

/**
 * Capture the AI-original baseline for an origin='ai' article, if not already
 * captured. `pre` must be the row's state BEFORE the human edit being applied
 * — until the first human edit, that state IS the AI original (the pipeline
 * writes the row once and never updates it). Idempotent: on conflict the
 * first snapshot wins.
 */
export async function ensureAiBaseline(pre: ContentSnapshot): Promise<void> {
  if (pre.origin !== "ai") return;
  try {
    const { error } = await svc()
      .from("editorial_ai_baseline")
      .insert({
        content_id: pre.id,
        title: pre.title,
        body: pre.body,
        category_slug: pre.category_slug,
        source_name: pre.source_name,
        source_url: pre.source_url,
        cover_image_url: pre.cover_image_url,
      })
      .select("content_id");
    // 23505 (already captured) is the expected steady state after edit #1.
    if (error && !/duplicate|23505/i.test(error.message + (error.code ?? ""))) {
      console.error("[feedback] baseline insert failed:", error.message);
    }
  } catch (e) {
    console.error("[feedback] baseline threw:", e);
  }
}

/**
 * Record a publish decision, plus final-vs-AI-original title/body edit
 * magnitude when a baseline exists (no baseline = never edited = no edit
 * events, which analytics read as magnitude "none"). Never throws.
 */
export async function recordPublishFeedback(
  contentId: string,
  actorId: string | null,
  prevStatus?: string | null,
): Promise<void> {
  try {
    const client = svc();
    const [{ data: row }, { data: base }] = await Promise.all([
      client.from("content").select(SNAPSHOT_FIELDS).eq("id", contentId).maybeSingle(),
      client.from("editorial_ai_baseline").select("*").eq("content_id", contentId).maybeSingle(),
    ]);
    const current = row as ContentSnapshot | null;
    if (!current) return;
    const events: FeedbackEvent[] = [
      {
        content_id: contentId,
        action: "publish",
        actor_id: actorId,
        origin: current.origin,
        before_value: prevStatus ?? null,
        after_value: "published",
      },
    ];
    const baseline = base as
      | (ContentSnapshot & { content_id: string })
      | null;
    if (baseline && current.origin === "ai") {
      const t = assessTitleEdit(baseline.title, current.title);
      if (t.material) {
        events.push({
          content_id: contentId,
          action: "title_edit",
          actor_id: actorId,
          origin: current.origin,
          before_value: baseline.title,
          after_value: current.title,
          edit_ratio: t.ratio,
          edit_magnitude: t.magnitude,
        });
      }
      const b = assessBodyEdit(baseline.body ?? "", current.body ?? "");
      if (b.magnitude !== "none") {
        events.push({
          content_id: contentId,
          action: "body_edit",
          actor_id: actorId,
          origin: current.origin,
          edit_ratio: b.ratio,
          edit_magnitude: b.magnitude,
        });
      }
    }
    await logFeedbackEvents(events);
  } catch (e) {
    console.error("[feedback] publish feedback threw:", e);
  }
}

/**
 * Diff a human save against the previous row state and log the cheap
 * behavioral signals (source / image / category changed). Title/body edit
 * magnitude is deliberately NOT measured per-save — it is measured once, at
 * publish time, against the AI baseline. Never throws.
 */
export function saveChangeEvents(
  prev: ContentSnapshot,
  next: {
    category_slug: string | null;
    source_url: string | null;
    source_name: string | null;
    cover_image_url: string | null;
  },
  actorId: string | null,
): FeedbackEvent[] {
  const events: FeedbackEvent[] = [];
  const common = { content_id: prev.id, actor_id: actorId, origin: prev.origin };
  if ((prev.category_slug ?? "") !== (next.category_slug ?? "")) {
    events.push({
      ...common,
      action: "category_change",
      before_value: prev.category_slug,
      after_value: next.category_slug,
    });
  }
  if (prev.origin === "ai") {
    if (urlHost(prev.source_url) !== urlHost(next.source_url)) {
      events.push({
        ...common,
        action: "source_change",
        before_value: prev.source_url,
        after_value: next.source_url,
        meta: { before_name: prev.source_name, after_name: next.source_name },
      });
    }
    if ((prev.cover_image_url ?? "") !== (next.cover_image_url ?? "")) {
      events.push({
        ...common,
        action: "image_change",
        before_value: prev.cover_image_url,
        after_value: next.cover_image_url,
      });
    }
  }
  return events;
}
