import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { RadarArticle } from "@/lib/radar";
import type {
  Category,
  Content,
  ContentSource,
  ContentMedia,
  Comment,
  Department,
  Doctor,
  DoctorRating,
} from "@/lib/queries";
import type { Tables } from "@/lib/supabase/database.types";

export type IngestionRun = Tables<"ingestion_runs">;
export type RunArticle = { id: string; title: string; status: string };
export type EditorialPolicy = Tables<"editorial_policy">;
export type NewsSource = Tables<"news_sources">;
export type AdminUser = Tables<"profiles">;

/** Rank used to sort the admins list: owner first, then super admins, then admins. */
const ROLE_RANK: Record<string, number> = { owner: 0, super_admin: 1, admin: 2 };

/** All dashboard-capable accounts (owner/super_admin/admin), highest role first. */
export async function listAdmins(): Promise<AdminUser[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .in("role", ["owner", "super_admin", "admin"])
    .order("created_at", { ascending: true });
  const rows = (data as AdminUser[]) ?? [];
  return rows.sort(
    (a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9),
  );
}

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

/**
 * Fast News Radar (SHADOW MODE): most-recently-observed shadow articles with
 * their ranking/dedupe fields. Read-only. The radar_shadow_* tables are not in
 * the generated Database types, so we query through an untyped client view and
 * cast to the hand-written RadarArticle shape.
 */
export async function listRadarArticles(limit = 500): Promise<RadarArticle[]> {
  const supabase = await createClient();
  const client = supabase as unknown as SupabaseClient;
  const { data } = await client
    .from("radar_shadow_articles")
    .select("*")
    // Primary editorial order is detection time (newest first). A deterministic
    // secondary key (row id) breaks ties so the MANY rows sharing an identical
    // batch first_seen_at keep a stable order across revalidations — a workflow
    // status change (which UPDATEs the row and can move its heap tuple) must
    // never reorder the feed. publish_status never influences ordering.
    .order("first_seen_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  return (data ?? []) as RadarArticle[];
}

// Resolve the slug + status of the content rows a Radar row points at
// (published_content_id / matched_content_id) so the Radar card can link the
// "open the article" / "open the existing article" actions to the actual public
// Salma article (/article/<slug>) rather than a raw id. Read-only; a missing id
// simply yields no entry (the card then falls back to a non-link state).
export type RadarContentLink = { slug: string; status: string };
export async function listRadarContentLinks(
  ids: (string | null)[],
): Promise<Record<string, RadarContentLink>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return {};
  const supabase = await createClient();
  const client = supabase as unknown as SupabaseClient;
  const { data } = await client.from("content").select("id,slug,status").in("id", unique);
  const map: Record<string, RadarContentLink> = {};
  for (const r of (data ?? []) as { id: string; slug: string; status: string }[]) {
    map[r.id] = { slug: r.slug, status: r.status };
  }
  return map;
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

/** Evidence Intelligence sidecar row for one content item (admin read-only). */
export type EvidenceIntelligenceRow = {
  analysis_status: "complete" | "not_applicable" | "insufficient_source" | "analysis_failed";
  analyzed_url: string | null;
  analyzed_domain: string | null;
  evidence_strength: string | null;
  card: Record<string, unknown> | null;
  model: string | null;
  updated_at: string;
};

/**
 * The Evidence Intelligence card for a content item, if the ESL pipeline
 * produced one. Direct content_id link first; falls back to the ESL selection's
 * cluster key (covers a promotion where the content link write was lost).
 * Returns null for content with no evidence row (e.g. manual articles) — the
 * editor simply shows nothing rather than an empty card.
 */
export async function getEvidenceForContent(id: string): Promise<EvidenceIntelligenceRow | null> {
  const supabase = await createClient();
  const client = supabase as unknown as SupabaseClient;
  const cols = "analysis_status,analyzed_url,analyzed_domain,evidence_strength,card,model,updated_at";
  const { data: direct } = await client
    .from("radar_evidence_intelligence")
    .select(cols)
    .eq("content_id", id)
    .maybeSingle();
  if (direct) return direct as EvidenceIntelligenceRow;
  const { data: sel } = await client
    .from("radar_editorial_selection")
    .select("cluster_key")
    .eq("promoted_content_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const clusterKey = (sel as { cluster_key?: string } | null)?.cluster_key;
  if (!clusterKey) return null;
  const { data: byCluster } = await client
    .from("radar_evidence_intelligence")
    .select(cols)
    .eq("cluster_key", clusterKey)
    .maybeSingle();
  return (byCluster as EvidenceIntelligenceRow | null) ?? null;
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

/**
 * The structured source registry that is authoritative for source ranking in
 * the ingestion agent. Ordered tier-first (1 → blocked), then region and name,
 * so the admin list reads top-authority sources first.
 */
export async function listNewsSources(): Promise<NewsSource[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("news_sources")
    .select("*")
    .order("tier", { ascending: true })
    .order("region", { ascending: true })
    .order("name", { ascending: true });
  return (data as NewsSource[]) ?? [];
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

// ---- Categories (admin) ------------------------------------------------

/** All site categories (nav lines + section topics), ordered as they appear. */
export async function listCategories(): Promise<Category[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("categories")
    .select("*")
    .order("sort_order")
    .order("name_ar");
  return (data as Category[]) ?? [];
}

// ---- Doctors / departments / transfers (admin) -------------------------

export async function listDepartments(): Promise<Department[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("departments")
    .select("*")
    .order("sort_order")
    .order("name_ar");
  return (data as Department[]) ?? [];
}

export async function listDoctors(): Promise<Doctor[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("doctors")
    .select("*")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  return (data as Doctor[]) ?? [];
}

export async function getDoctorForEdit(id: string): Promise<Doctor | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("doctors").select("*").eq("id", id).maybeSingle();
  return (data as Doctor | null) ?? null;
}

export type RatingRow = DoctorRating & { doctor_name: string | null; doctor_slug: string | null };

export async function listRatings(status: string): Promise<RatingRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("doctor_ratings")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false });
  const rows = (data as DoctorRating[]) ?? [];

  const ids = [...new Set(rows.map((r) => r.doctor_id))];
  const names = new Map<string, { name: string; slug: string }>();
  if (ids.length > 0) {
    const { data: docs } = await supabase.from("doctors").select("id,name_ar,slug").in("id", ids);
    for (const d of (docs as { id: string; name_ar: string; slug: string }[]) ?? []) {
      names.set(d.id, { name: d.name_ar, slug: d.slug });
    }
  }
  return rows.map((r) => ({
    ...r,
    doctor_name: names.get(r.doctor_id)?.name ?? null,
    doctor_slug: names.get(r.doctor_id)?.slug ?? null,
  }));
}

/** The admin-side transfer shape: only the minimal factual fields the admin
 * list and edit form use. Legacy columns (transfer_date, summary, body,
 * source_name, source_url, note, slug, department_id) are never selected. */
export type AdminDoctorTransfer = Pick<
  Tables<"doctor_transfers">,
  | "id" | "doctor_name" | "specialty" | "from_hospital" | "to_hospital"
  | "doctor_photo_url" | "status" | "published_at" | "created_at" | "updated_at"
>;

const ADMIN_TRANSFER_FIELDS =
  "id,doctor_name,specialty,from_hospital,to_hospital,doctor_photo_url,status,published_at,created_at,updated_at";

export async function listTransfers(): Promise<AdminDoctorTransfer[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("doctor_transfers")
    .select(ADMIN_TRANSFER_FIELDS)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  return (data as AdminDoctorTransfer[]) ?? [];
}

export async function getTransferForEdit(id: string): Promise<AdminDoctorTransfer | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("doctor_transfers")
    .select(ADMIN_TRANSFER_FIELDS)
    .eq("id", id)
    .maybeSingle();
  return (data as AdminDoctorTransfer | null) ?? null;
}

/**
 * Result of loading a transfer's confidential internal source. A read/permission
 * error must NOT be silently treated as "no source exists" — callers distinguish
 * `{ ok: false }` (could not load; leave the stored value untouched) from
 * `{ ok: true, note: null }` (loaded, but there is genuinely no source).
 */
export type PrivateSourceLoad = { ok: true; note: string | null } | { ok: false };

/** Manager-only: load the confidential internal source note for a transfer. */
export async function getTransferPrivate(id: string): Promise<PrivateSourceLoad> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("doctor_transfer_private")
    .select("internal_source_note")
    .eq("transfer_id", id)
    .maybeSingle();
  if (error) return { ok: false };
  const row = data as { internal_source_note: string | null } | null;
  return { ok: true, note: row?.internal_source_note ?? null };
}

// ---- Homepage sections (admin) -----------------------------------------

export type HeroOption = { id: string; title: string; type: string; is_featured: boolean };

/** Published, non-deleted content for the homepage-hero picker, newest first. */
export async function listHeroOptions(): Promise<HeroOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("content")
    .select("id,title,type,is_featured")
    .eq("status", "published")
    .is("deleted_at", null)
    .order("published_at", { ascending: false })
    .limit(100);
  return (data as HeroOption[]) ?? [];
}

export type HomepageSection = Tables<"homepage_sections">;

export async function listHomepageSections(): Promise<HomepageSection[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("homepage_sections")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("key");
  return (data as HomepageSection[]) ?? [];
}
