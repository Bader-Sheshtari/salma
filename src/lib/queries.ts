import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

export type Content = Tables<"content">;
export type Category = Tables<"categories">;
export type ContentSource = Tables<"content_sources">;
export type ContentMedia = Tables<"content_media">;
export type Comment = Tables<"comments">;
export type Department = Tables<"departments">;
export type Doctor = Tables<"doctors">;
export type DoctorRating = Tables<"doctor_ratings">;
export type DoctorTransfer = Tables<"doctor_transfers">;

const CARD_FIELDS =
  "id,type,title,slug,excerpt,category_slug,cover_image_url,video_duration,read_minutes,published_at,is_breaking";

export async function getCategories(): Promise<Category[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("categories")
    .select("*")
    .order("sort_order");
  return data ?? [];
}

export type HomepageData = {
  hero: Content | null;
  breaking: Content[];
  kuwait: Content[];
  videos: Content[];
  economy: Content[];
  investigations: Content[];
  lifestyle: Content[];
  gulfWorld: Content[];
};

export async function getHomepage(): Promise<HomepageData> {
  const supabase = await createClient();

  const base = () =>
    supabase
      .from("content")
      .select(CARD_FIELDS)
      .eq("status", "published")
      .is("deleted_at", null);

  const [hero, breaking, kuwait, videos, economy, investigations, lifestyle, gulfWorld] =
    await Promise.all([
      base().eq("is_featured", true).order("published_at", { ascending: false }).limit(1).maybeSingle(),
      base().eq("is_breaking", true).order("published_at", { ascending: false }).limit(8),
      base().eq("category_slug", "kuwait").eq("is_featured", false).order("published_at", { ascending: false }).limit(5),
      base().eq("type", "video").order("published_at", { ascending: false }).limit(6),
      base().eq("category_slug", "health-economy").order("published_at", { ascending: false }).limit(4),
      base().eq("type", "investigation").order("published_at", { ascending: false }).limit(3),
      base().eq("category_slug", "lifestyle").order("published_at", { ascending: false }).limit(6),
      base().in("category_slug", ["gulf", "world"]).order("published_at", { ascending: false }).limit(4),
    ]);

  return {
    hero: (hero.data as unknown as Content) ?? null,
    breaking: (breaking.data as Content[]) ?? [],
    kuwait: (kuwait.data as Content[]) ?? [],
    videos: (videos.data as Content[]) ?? [],
    economy: (economy.data as Content[]) ?? [],
    investigations: (investigations.data as Content[]) ?? [],
    lifestyle: (lifestyle.data as Content[]) ?? [],
    gulfWorld: (gulfWorld.data as Content[]) ?? [],
  };
}

export type ContentDetail = {
  content: Content;
  sources: ContentSource[];
  media: ContentMedia[];
  comments: Comment[];
};

export const getContentBySlug = cache(async (rawSlug: string): Promise<ContentDetail | null> => {
  // Route params arrive percent-encoded for non-ASCII (Arabic) slugs; decode
  // before matching the raw value stored in the DB.
  let slug = rawSlug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    // already decoded
  }
  const supabase = await createClient();
  const { data } = await supabase
    .from("content")
    .select("*")
    .eq("slug", slug)
    .eq("status", "published")
    .is("deleted_at", null)
    .maybeSingle();

  if (!data) return null;
  const content = data as Content;

  const [{ data: sources }, { data: media }, { data: comments }] = await Promise.all([
    supabase.from("content_sources").select("*").eq("content_id", content.id),
    supabase
      .from("content_media")
      .select("*")
      .eq("content_id", content.id)
      .order("sort_order", { ascending: true }),
    supabase
      .from("comments")
      .select("*")
      .eq("content_id", content.id)
      .eq("status", "approved")
      .order("created_at", { ascending: false }),
  ]);

  return {
    content,
    sources: sources ?? [],
    media: (media as ContentMedia[]) ?? [],
    comments: comments ?? [],
  };
});

export async function getContentByCategory(slug: string): Promise<Content[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("content")
    .select(CARD_FIELDS)
    .eq("status", "published")
    .is("deleted_at", null)
    .eq("category_slug", slug)
    .order("published_at", { ascending: false });
  return (data as Content[]) ?? [];
}

export async function searchContent(query: string): Promise<Content[]> {
  const q = query.trim();
  if (!q) return [];
  const supabase = await createClient();
  const escaped = q.replace(/[%_,]/g, " ");
  const { data } = await supabase
    .from("content")
    .select(CARD_FIELDS)
    .eq("status", "published")
    .is("deleted_at", null)
    .or(`title.ilike.%${escaped}%,excerpt.ilike.%${escaped}%,body.ilike.%${escaped}%`)
    .order("published_at", { ascending: false })
    .limit(40);
  return (data as Content[]) ?? [];
}

export async function getRelated(content: Content, limit = 4): Promise<Content[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("content")
    .select(CARD_FIELDS)
    .eq("status", "published")
    .is("deleted_at", null)
    .eq("category_slug", content.category_slug ?? "")
    .neq("id", content.id)
    .order("published_at", { ascending: false })
    .limit(limit);
  return (data as Content[]) ?? [];
}

// ---- Doctors / departments / transfers ---------------------------------

export async function getDepartments(): Promise<Department[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("departments")
    .select("*")
    .order("sort_order")
    .order("name_ar");
  return (data as Department[]) ?? [];
}

/** Public doctor directory, newest first, optionally filtered by department. */
export async function getDoctors(departmentId?: string): Promise<Doctor[]> {
  const supabase = await createClient();
  let q = supabase
    .from("doctors")
    .select("*")
    .is("deleted_at", null)
    .order("rating_avg", { ascending: false })
    .order("name_ar");
  if (departmentId) q = q.eq("department_id", departmentId);
  const { data } = await q;
  return (data as Doctor[]) ?? [];
}

export type DoctorDetail = {
  doctor: Doctor;
  department: Department | null;
  ratings: DoctorRating[];
};

export const getDoctorBySlug = cache(async (rawSlug: string): Promise<DoctorDetail | null> => {
  let slug = rawSlug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    // already decoded
  }
  const supabase = await createClient();
  const { data } = await supabase
    .from("doctors")
    .select("*")
    .eq("slug", slug)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const doctor = data as Doctor;

  const [{ data: department }, { data: ratings }] = await Promise.all([
    doctor.department_id
      ? supabase.from("departments").select("*").eq("id", doctor.department_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("doctor_ratings")
      .select("*")
      .eq("doctor_id", doctor.id)
      .eq("status", "approved")
      .order("created_at", { ascending: false }),
  ]);

  return {
    doctor,
    department: (department as Department | null) ?? null,
    ratings: (ratings as DoctorRating[]) ?? [],
  };
});

export type TransferRow = DoctorTransfer & { department_name: string | null };

/** Public transfer feed (انتقال الأطباء), newest first. */
export async function getTransfers(): Promise<TransferRow[]> {
  const supabase = await createClient();
  const [{ data: transfers }, departments] = await Promise.all([
    supabase
      .from("doctor_transfers")
      .select("*")
      .eq("status", "published")
      .is("deleted_at", null)
      .order("transfer_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    getDepartments(),
  ]);
  const byId = new Map(departments.map((d) => [d.id, d.name_ar]));
  return ((transfers as DoctorTransfer[]) ?? []).map((t) => ({
    ...t,
    department_name: t.department_id ? byId.get(t.department_id) ?? null : null,
  }));
}

export type SitemapEntry = Pick<Content, "slug" | "type" | "updated_at" | "published_at">;

/** All published, non-deleted items for the sitemap. */
export async function getSitemapEntries(): Promise<SitemapEntry[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("content")
    .select("slug,type,updated_at,published_at")
    .eq("status", "published")
    .is("deleted_at", null)
    .order("published_at", { ascending: false })
    .limit(5000);
  return (data as SitemapEntry[]) ?? [];
}
