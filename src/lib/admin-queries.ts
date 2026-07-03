import "server-only";
import { createClient } from "@/lib/supabase/server";
import type {
  Category,
  Content,
  ContentSource,
  ContentMedia,
  Comment,
  Department,
  Doctor,
  DoctorRating,
  DoctorTransfer,
} from "@/lib/queries";
import type { Tables } from "@/lib/supabase/database.types";

export type IngestionRun = Tables<"ingestion_runs">;
export type RunArticle = { id: string; title: string; status: string };
export type EditorialPolicy = Tables<"editorial_policy">;
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

export type AdminTransferRow = DoctorTransfer & { department_name: string | null };

export async function listTransfers(): Promise<AdminTransferRow[]> {
  const supabase = await createClient();
  const [{ data }, departments] = await Promise.all([
    supabase
      .from("doctor_transfers")
      .select("*")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false }),
    listDepartments(),
  ]);
  const byId = new Map(departments.map((d) => [d.id, d.name_ar]));
  return ((data as DoctorTransfer[]) ?? []).map((t) => ({
    ...t,
    department_name: t.department_id ? byId.get(t.department_id) ?? null : null,
  }));
}

export async function getTransferForEdit(id: string): Promise<DoctorTransfer | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("doctor_transfers").select("*").eq("id", id).maybeSingle();
  return (data as DoctorTransfer | null) ?? null;
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
