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
  "id,type,title,slug,excerpt,category_slug,cover_image_url,video_url,video_duration,read_minutes,published_at,is_breaking";

export async function getCategories(): Promise<Category[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("categories")
    .select("*")
    .order("sort_order");
  return data ?? [];
}

export type HomepageSection = Tables<"homepage_sections">;

/** A rendered homepage lane: its config plus the items it resolved to. Category
 * sections fill `content`; the doctor-transfers feature fills `transfers`. */
export type HomeSectionItems = {
  section: HomepageSection;
  content: Content[];
  transfers: DoctorTransfer[];
};

export type HomepageData = {
  hero: Content | null;
  /** Ordered pool the homepage hero rotates through: the featured pick first,
   * then the most recent published articles. Deduped, videos excluded. */
  heroPool: Content[];
  breaking: Content[];
  videos: Content[];
  sections: HomeSectionItems[];
};

export async function getHomepage(): Promise<HomepageData> {
  const supabase = await createClient();

  const base = () =>
    supabase
      .from("content")
      .select(CARD_FIELDS)
      .eq("status", "published")
      .is("deleted_at", null);

  const [heroRes, latestRes, breakingRes, videosRes, sectionsRes] = await Promise.all([
    base().eq("is_featured", true).order("published_at", { ascending: false }).limit(1).maybeSingle(),
    base().neq("type", "video").order("published_at", { ascending: false }).limit(6),
    base().eq("is_breaking", true).order("published_at", { ascending: false }).limit(8),
    base().eq("type", "video").order("published_at", { ascending: false }).limit(6),
    supabase
      .from("homepage_sections")
      .select("*")
      .eq("is_enabled", true)
      .order("sort_order", { ascending: true }),
  ]);

  const hero = (heroRes.data as unknown as Content) ?? null;
  const sectionRows = (sectionsRes.data as HomepageSection[]) ?? [];

  // Build the hero rotation pool: featured pick first, then latest articles,
  // deduped, capped at 5 so the rotation stays focused on the top stories.
  const latest = (latestRes.data as Content[]) ?? [];
  const heroPool: Content[] = [];
  const seen = new Set<string>();
  for (const c of [...(hero ? [hero] : []), ...latest]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    heroPool.push(c);
    if (heroPool.length >= 5) break;
  }

  // Resolve each enabled section's items in parallel. `feature:social` has no
  // UI yet (built in a later stage), so it is skipped here.
  const resolved = await Promise.all(
    sectionRows.map(async (section): Promise<HomeSectionItems | null> => {
      if (section.kind === "category" && section.category_slug) {
        const { data } = await base()
          .eq("category_slug", section.category_slug)
          .order("published_at", { ascending: false })
          .limit(section.items_limit);
        const content = ((data as Content[]) ?? []).filter((c) => c.id !== hero?.id);
        return content.length > 0 ? { section, content, transfers: [] } : null;
      }
      if (section.key === "feature:doctor_transfers") {
        const transfers = await getTransfers(section.items_limit);
        return transfers.length > 0 ? { section, content: [], transfers } : null;
      }
      return null;
    }),
  );

  return {
    hero,
    heroPool,
    breaking: (breakingRes.data as Content[]) ?? [],
    videos: (videosRes.data as Content[]) ?? [],
    sections: resolved.filter((s): s is HomeSectionItems => s !== null),
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

/** Public transfer feed (انتقال الأطباء), newest first by publish time. */
export async function getTransfers(limit?: number): Promise<DoctorTransfer[]> {
  const supabase = await createClient();
  let q = supabase
    .from("doctor_transfers")
    .select("*")
    .eq("status", "published")
    .is("deleted_at", null)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (limit) q = q.limit(limit);
  const { data } = await q;
  return (data as DoctorTransfer[]) ?? [];
}

/** A single published transfer by slug, for the detail page. */
export const getTransferBySlug = cache(async (rawSlug: string): Promise<DoctorTransfer | null> => {
  let slug = rawSlug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    // already decoded
  }
  const supabase = await createClient();
  const { data } = await supabase
    .from("doctor_transfers")
    .select("*")
    .eq("slug", slug)
    .eq("status", "published")
    .is("deleted_at", null)
    .maybeSingle();
  return (data as DoctorTransfer | null) ?? null;
});

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
