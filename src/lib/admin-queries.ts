import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Content, ContentSource, ContentMedia, Comment } from "@/lib/queries";
import type { Tables } from "@/lib/supabase/database.types";

export type IngestionRun = Tables<"ingestion_runs">;
export type RunArticle = { id: string; title: string; status: string };
export type EditorialPolicy = Tables<"editorial_policy">;

export type AdminCounts = {
  published: number;
  draft: number;
  pending_content: number;
  pending_comments: number;
};

export async function getAdminCounts(): Promise<AdminCounts> {
  const supabase = await createClient();
  const base = () => supabase.from("content").select("*", { count: "exact", head: true });

  const [published, draft, pendingContent, pendingComments] = await Promise.all([
    base().eq("status", "published").is("deleted_at", null),
    base().eq("status", "draft").is("deleted_at", null),
    base().eq("status", "pending").is("deleted_at", null),
    supabase.from("comments").select("*", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  return {
    published: published.count ?? 0,
    draft: draft.count ?? 0,
    pending_content: pendingContent.count ?? 0,
    pending_comments: pendingComments.count ?? 0,
  };
}

export async function listContent(status?: string): Promise<Content[]> {
  const supabase = await createClient();
  let q = supabase
    .from("content")
    .select("*")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data } = await q;
  return (data as Content[]) ?? [];
}

export async function getContentForEdit(
  id: string,
): Promise<{ content: Content; sources: ContentSource[]; media: ContentMedia[] } | null> {
  const supabase = await createClient();
  const { data: content } = await supabase.from("content").select("*").eq("id", id).maybeSingle();
  if (!content) return null;
  const [{ data: sources }, { data: media }] = await Promise.all([
    supabase.from("content_sources").select("*").eq("content_id", id).order("created_at"),
    supabase.from("content_media").select("*").eq("content_id", id).order("sort_order"),
  ]);
  return {
    content: content as Content,
    sources: (sources as ContentSource[]) ?? [],
    media: (media as ContentMedia[]) ?? [],
  };
}

/**
 * List recent AI-ingestion runs plus a lookup of the articles each run created
 * (id → title/status), so the history page can link straight to them.
 */
export async function listIngestionRuns(
  limit = 50,
): Promise<{ runs: IngestionRun[]; articles: Record<string, RunArticle> }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ingestion_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  const runs = (data as IngestionRun[]) ?? [];

  const ids = [...new Set(runs.flatMap((r) => r.created_ids))];
  const articles: Record<string, RunArticle> = {};
  if (ids.length > 0) {
    const { data: rows } = await supabase
      .from("content")
      .select("id,title,status")
      .in("id", ids);
    for (const row of (rows as RunArticle[]) ?? []) articles[row.id] = row;
  }

  return { runs, articles };
}

/** Fetch the single editorial-policy row that drives the ingestion agent. */
export async function getEditorialPolicy(): Promise<EditorialPolicy | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("editorial_policy").select("*").limit(1).maybeSingle();
  return (data as EditorialPolicy | null) ?? null;
}

export async function listComments(status: string): Promise<Comment[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("comments")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false });
  return (data as Comment[]) ?? [];
}
