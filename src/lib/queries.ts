import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";
import { scoreFields } from "@/lib/search";
import { videoThumbnail } from "@/lib/format";

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

/** A single unified search hit across all content types Salma publishes. */
export type SearchResult = {
  id: string;
  kind: "content" | "transfer" | "category" | "doctor";
  typeLabel: string;
  title: string;
  href: string;
  categoryName: string | null;
  image: string | null;
  summary: string | null;
  publishedAt: string | null;
  source: string | null;
  score: number;
};

const CONTENT_TYPE_LABEL: Record<string, string> = {
  news: "خبر",
  article: "مقال",
  video: "فيديو",
  investigation: "تحقيق",
  study: "دراسة",
};

/**
 * Internal, Arabic-aware search across everything published on Salma: content
 * (news/articles/studies/videos), doctor transfers, categories, and doctors.
 * The DB only fetches the (small) published corpus; normalization, typo-tolerant
 * fuzzy matching and cross-type ranking happen in JS via `scoreFields`, so the
 * search never leaves Salma and never touches the internet. Results are ranked
 * by relevance, then recency.
 */
export async function searchAll(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const supabase = await createClient();

  const [contentRes, transfersRes, categoriesRes, doctorsRes, departmentsRes] = await Promise.all([
    supabase
      .from("content")
      .select(
        "id,type,title,slug,excerpt,ai_summary,body,category_slug,cover_image_url,video_url,source_name,published_at",
      )
      .eq("status", "published")
      .is("deleted_at", null),
    supabase
      .from("doctor_transfers")
      .select(
        "id,doctor_name,specialty,from_hospital,to_hospital,summary,body,source_name,doctor_photo_url,slug,published_at",
      )
      .eq("status", "published")
      .is("deleted_at", null),
    supabase.from("categories").select("slug,name_ar,name_en"),
    supabase
      .from("doctors")
      .select("id,name_ar,title_ar,hospital,bio,department_id,photo_url,slug,created_at")
      .is("deleted_at", null),
    supabase.from("departments").select("id,name_ar"),
  ]);

  type CatRow = { slug: string; name_ar: string; name_en: string | null };
  type DeptRow = { id: string; name_ar: string };
  type ContentRow = {
    id: string; type: string; title: string; slug: string;
    excerpt: string | null; ai_summary: string | null; body: string | null;
    category_slug: string | null; cover_image_url: string | null;
    video_url: string | null; source_name: string | null; published_at: string | null;
  };
  type TransferRow = {
    id: string; doctor_name: string; specialty: string | null;
    from_hospital: string | null; to_hospital: string | null;
    summary: string | null; body: string | null; source_name: string | null;
    doctor_photo_url: string | null; slug: string; published_at: string | null;
  };
  type DoctorRow = {
    id: string; name_ar: string; title_ar: string | null; hospital: string | null;
    bio: string | null; department_id: string | null; photo_url: string | null;
    slug: string; created_at: string | null;
  };

  const categories = (categoriesRes.data as CatRow[]) ?? [];
  const catName = new Map(categories.map((c) => [c.slug, c.name_ar]));
  const departments = (departmentsRes.data as DeptRow[]) ?? [];
  const deptName = new Map(departments.map((d) => [d.id, d.name_ar]));

  const results: SearchResult[] = [];

  for (const c of (contentRes.data as ContentRow[]) ?? []) {
    const category = c.category_slug ? catName.get(c.category_slug) ?? null : null;
    const score = scoreFields(q, [
      { text: c.title, weight: 3 },
      { text: c.excerpt, weight: 1.5 },
      { text: c.ai_summary, weight: 1.5 },
      { text: category, weight: 1 },
      { text: c.source_name, weight: 1 },
      { text: c.body, weight: 0.5, fuzzy: false },
    ]);
    if (score <= 0) continue;
    results.push({
      id: c.id,
      kind: "content",
      typeLabel: CONTENT_TYPE_LABEL[c.type] ?? "محتوى",
      title: c.title,
      href: c.type === "video" ? `/video/${c.slug}` : `/article/${c.slug}`,
      categoryName: category,
      image: c.cover_image_url || videoThumbnail(c.video_url),
      summary: c.ai_summary || c.excerpt || null,
      publishedAt: c.published_at,
      source: c.source_name,
      score,
    });
  }

  for (const t of (transfersRes.data as TransferRow[]) ?? []) {
    const score = scoreFields(q, [
      { text: t.doctor_name, weight: 3 },
      { text: t.specialty, weight: 1.5 },
      { text: t.from_hospital, weight: 1 },
      { text: t.to_hospital, weight: 1 },
      { text: t.summary, weight: 1.5 },
      { text: t.source_name, weight: 1 },
      { text: t.body, weight: 0.5, fuzzy: false },
    ]);
    if (score <= 0) continue;
    results.push({
      id: t.id,
      kind: "transfer",
      typeLabel: "انتقال طبيب",
      title: t.doctor_name,
      href: `/transfers/${t.slug}`,
      categoryName: t.specialty,
      image: t.doctor_photo_url,
      summary: t.summary,
      publishedAt: t.published_at,
      source: t.source_name,
      score,
    });
  }

  for (const cat of categories) {
    const score = scoreFields(q, [
      { text: cat.name_ar, weight: 3 },
      { text: cat.name_en, weight: 2 },
    ]);
    if (score <= 0) continue;
    results.push({
      id: cat.slug,
      kind: "category",
      typeLabel: "قسم",
      title: cat.name_ar,
      href: `/category/${cat.slug}`,
      categoryName: null,
      image: null,
      summary: null,
      publishedAt: null,
      source: null,
      score,
    });
  }

  for (const d of (doctorsRes.data as DoctorRow[]) ?? []) {
    const specialty = d.department_id ? deptName.get(d.department_id) ?? null : null;
    const score = scoreFields(q, [
      { text: d.name_ar, weight: 3 },
      { text: specialty, weight: 1.5 },
      { text: d.title_ar, weight: 1.5 },
      { text: d.hospital, weight: 1 },
      { text: d.bio, weight: 0.5, fuzzy: false },
    ]);
    if (score <= 0) continue;
    results.push({
      id: d.id,
      kind: "doctor",
      typeLabel: "طبيب",
      title: d.name_ar,
      href: `/doctors/${d.slug}`,
      categoryName: specialty,
      image: d.photo_url,
      summary: d.bio,
      publishedAt: null,
      source: d.hospital,
      score,
    });
  }

  results.sort(
    (a, b) => b.score - a.score || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
  return results.slice(0, 40);
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
