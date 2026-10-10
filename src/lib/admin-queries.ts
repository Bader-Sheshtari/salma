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
import {
  CONTENT_TABS,
  PAGE_SIZE,
  type ContentCountRow,
  type ContentSearchRow,
  type SearchContentParams,
} from "@/lib/content-search";
import {
  HISTORY_PAGE_SIZE,
  SYSTEM_ACTOR_LABEL,
  type AuditCursor,
  type AuditDetails,
  type AuditEvent,
  type VersionMeta,
  type VersionSnapshot,
} from "@/lib/content-history";

export type IngestionRun = Tables<"ingestion_runs">;
export type RunArticle = { id: string; title: string; status: string };
export type EditorialPolicy = Tables<"editorial_policy">;
export type NewsSource = Tables<"news_sources">;
export type AdminUser = Tables<"profiles">;

/** Rank used to sort the accounts list: owner, super admins, admins, then editors. */
const ROLE_RANK: Record<string, number> = { owner: 0, super_admin: 1, admin: 2, editor: 3 };

/** All dashboard-capable accounts (owner/super_admin/admin/editor), highest role first. */
export async function listAdmins(): Promise<AdminUser[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .in("role", ["owner", "super_admin", "admin", "editor"])
    .order("created_at", { ascending: true });
  const rows = (data as AdminUser[]) ?? [];
  return rows.sort(
    (a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9),
  );
}

/** Invitation row as listed for managers (list_invitations(): no token_hash). */
export type ListedInvitation = {
  id: string;
  kind: string;
  email: string;
  role: string | null;
  invited_by: string | null;
  invited_by_name: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  superseded_by: string | null;
};

/**
 * Open staff invitations (pending or expired; not accepted / cancelled /
 * superseded), newest first. Via the SECURITY DEFINER RPC list_invitations()
 * (manager-guarded; the table itself is not client-readable). Not in the
 * generated types yet → untyped call. Returns [] on error (e.g. pre-migration).
 */
export async function listOpenInvitations(): Promise<(ListedInvitation & { expired: boolean })[]> {
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { data, error } = await supabase.rpc("list_invitations");
  if (error) {
    console.error("[users] list_invitations failed:", error.message);
    return [];
  }
  const now = Date.now();
  return ((data as ListedInvitation[] | null) ?? [])
    .filter((i) => i.kind === "invite" && !i.accepted_at && !i.cancelled_at && !i.superseded_by)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((i) => ({ ...i, expired: new Date(i.expires_at).getTime() < now }));
}

/** id → display name for the given profile ids (manager-readable profiles). */
export async function profileNames(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("id, full_name, email").in("id", unique);
  const out: Record<string, string> = {};
  for (const p of (data as { id: string; full_name: string | null; email: string | null }[] | null) ?? []) {
    out[p.id] = p.full_name?.trim() || p.email || "—";
  }
  return out;
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

/**
 * Explicit admin `content` column list: every column EXCEPT the derived search
 * columns (`search_norm`, `body_tsv`, added by the Phase 2 search migration),
 * which are large and only used server-side by search_content.
 */
const CONTENT_COLUMNS =
  "ai_summary,author_id,body,category_slug,cover_credit_name,cover_credit_url,cover_image_url,created_at,created_by,dedupe_key,deleted_at,deleted_by,excerpt,first_published_at,id,is_breaking,is_featured,last_edited_at,last_edited_by,last_published_at,origin,original_title,original_url,published_at,published_by,read_minutes,relevance_score,reviewed_at,reviewed_by,slug,source_image_url,source_lang,source_name,source_url,status,title,type,unpublished_at,unpublished_by,updated_at,version,video_duration,video_url";

export async function listContent(status?: string): Promise<Content[]> {
  const supabase = await createClient();
  let q = supabase
    .from("content")
    .select(CONTENT_COLUMNS)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data } = await q;
  return (data as Content[]) ?? [];
}

// ---- Content Management (Phase 2: server-side search) -------------------

/**
 * One page of the admin content list via the `search_content` RPC (keyset
 * pagination, never returns body). Requests one extra row to know whether a
 * next page exists. The RPC is not in the generated Database types yet, so the
 * call goes through an untyped client and the rows are cast to the local shape.
 * Errors are surfaced (not swallowed) so the page can say the list failed.
 */
export async function searchContent(
  params: SearchContentParams,
): Promise<{ rows: ContentSearchRow[]; hasMore: boolean; error: string | null }> {
  const supabase = await createClient();
  const client = supabase as unknown as SupabaseClient;
  const limit = Math.min(100, Math.max(1, params.limit || PAGE_SIZE));
  const { data, error } = await client.rpc("search_content", {
    p_q: params.q,
    p_status: params.status,
    p_category: params.category,
    p_from: params.from,
    p_to: params.to,
    p_author: params.author,
    p_author_system: params.authorSystem,
    p_reviewer: params.reviewer,
    p_publisher: params.publisher,
    // Omit p_sort unless the user explicitly chose one (RPC default is per tab).
    ...(params.sort ? { p_sort: params.sort } : {}),
    p_cursor_ts: params.cursorTs,
    p_cursor_id: params.cursorId,
    p_limit: limit + 1, // limit ≤ 100 → ≤ 101 (RPC clamps to 101)
  });
  if (error) {
    console.error("[content] search_content failed:", error.message);
    return { rows: [], hasMore: false, error: error.message };
  }
  const rows = (data ?? []) as ContentSearchRow[];
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit, error: null };
}

/** Tab totals + per-category counts for the content screen. */
export type ContentCounts = {
  /** status → total (non-deleted), plus 'all' and 'trash' (as emitted by the RPC). */
  byStatus: Record<string, number>;
  /** status (incl. 'all') → category_slug → count. */
  byStatusCat: Record<string, Record<string, number>>;
};

export async function getContentCounts(): Promise<ContentCounts> {
  const supabase = await createClient();
  const client = supabase as unknown as SupabaseClient;
  const { data, error } = await client.rpc("content_counts");
  const byStatus: Record<string, number> = {};
  const byStatusCat: Record<string, Record<string, number>> = {};
  if (error) {
    console.error("[content] content_counts failed:", error.message);
    return { byStatus, byStatusCat };
  }
  // The RPC omits zero-count combinations: seed every tab with 0.
  for (const t of CONTENT_TABS) {
    byStatus[t.key] = 0;
    byStatusCat[t.key] = {};
  }
  // Rows: scope 'status' → (status incl. 'all'/'trash', category NULL, n);
  //       scope 'category' → (status incl. 'all', category_slug, n) — NULL slug
  //       (uncategorised) has no strip chip and is skipped.
  for (const r of (data ?? []) as ContentCountRow[]) {
    const n = Number(r.n) || 0;
    if (r.scope === "status") {
      byStatus[r.status] = n;
    } else if (r.scope === "category" && r.category_slug) {
      (byStatusCat[r.status] ??= {})[r.category_slug] = n;
    }
  }
  return { byStatus, byStatusCat };
}

export type AdminProfileOption = { id: string; name: string };

/** Dashboard accounts for the author/reviewer/publisher filter dropdowns. */
export async function listAdminProfiles(): Promise<AdminProfileOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id,full_name,email")
    .in("role", ["owner", "super_admin", "admin", "editor"])
    .order("full_name", { ascending: true });
  return ((data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map(
    (p) => ({ id: p.id, name: p.full_name || p.email || p.id.slice(0, 8) }),
  );
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
  const { data: content } = await supabase.from("content").select(CONTENT_COLUMNS).eq("id", id).maybeSingle();
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

// ---- Article history (Phase 4: activity timeline + versions) -------------

/**
 * id → display name for a set of profile ids (full name, else email). One small
 * query; unknown ids are simply absent (callers fall back to the system label).
 */
export async function getProfileNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("id,full_name,email").in("id", unique);
  for (const p of (data ?? []) as { id: string; full_name: string | null; email: string | null }[]) {
    names.set(p.id, p.full_name || p.email || p.id.slice(0, 8));
  }
  return names;
}

/**
 * One page of an article's activity timeline, newest first. Keyset on
 * (created_at, id) desc; requests one extra row to know whether more exist.
 * NULL actor → «سلمى (آلي)».
 */
export async function getContentAuditLog(
  contentId: string,
  cursor?: AuditCursor | null,
  limit = HISTORY_PAGE_SIZE,
): Promise<{ events: AuditEvent[]; hasMore: boolean; error: string | null }> {
  const supabase = await createClient();
  const n = Math.min(100, Math.max(1, limit));
  let q = supabase
    .from("content_audit_log")
    .select("id,event,from_status,to_status,actor_id,actor_kind,version_no,details,created_at")
    .eq("content_id", contentId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(n + 1);
  if (cursor) {
    q = q.or(`created_at.lt."${cursor.ts}",and(created_at.eq."${cursor.ts}",id.lt.${cursor.id})`);
  }
  const { data, error } = await q;
  if (error) {
    console.error("[content] audit log read failed:", error.message);
    return { events: [], hasMore: false, error: error.message };
  }
  type RawEvent = Omit<AuditEvent, "actor_name" | "details"> & { details: unknown };
  const rows = (data ?? []) as RawEvent[];
  const names = await getProfileNames(rows.map((r) => r.actor_id));
  const events = rows.slice(0, n).map((r) => ({
    ...r,
    details: (r.details && typeof r.details === "object" ? r.details : null) as AuditDetails | null,
    actor_name: (r.actor_id && names.get(r.actor_id)) || SYSTEM_ACTOR_LABEL,
  }));
  return { events, hasMore: rows.length > n, error: null };
}

type VersionMetaRaw = { version_no: number; edited_by: string | null; edited_at: string };

/** Who produced version 1: the article's creation. */
async function creationOf(contentId: string): Promise<{ by: string | null; at: string } | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("content")
    .select("created_by,created_at")
    .eq("id", contentId)
    .maybeSingle();
  const row = data as { created_by: string | null; created_at: string } | null;
  return row ? { by: row.created_by, at: row.created_at } : null;
}

/**
 * Attribute stored snapshots to their AUTHOR: snapshot N's edited_by/edited_at
 * record the edit that superseded it (created version N+1), so version N was
 * produced by snapshot N-1's edit — or by the article's creation for N = 1.
 * `rows` are desc by version_no and may include one look-ahead row.
 */
async function attributeVersions(
  contentId: string,
  shown: VersionMetaRaw[],
  all: VersionMetaRaw[],
): Promise<VersionMeta[]> {
  const byNo = new Map(all.map((r) => [r.version_no, r]));
  const needsCreation = shown.some((r) => r.version_no === 1);
  const created = needsCreation ? await creationOf(contentId) : null;
  const authorIds = shown.map((r) =>
    r.version_no === 1 ? (created?.by ?? null) : (byNo.get(r.version_no - 1)?.edited_by ?? null),
  );
  const names = await getProfileNames(authorIds);
  return shown.map((r, i) => {
    if (r.version_no === 1) {
      return {
        version_no: 1,
        author_name: (created?.by && names.get(created.by)) || SYSTEM_ACTOR_LABEL,
        authored_at: created?.at ?? null,
      };
    }
    const prev = byNo.get(r.version_no - 1);
    if (!prev) return { version_no: r.version_no, author_name: null, authored_at: null };
    return {
      version_no: r.version_no,
      author_name: (authorIds[i] && names.get(authorIds[i]!)) || SYSTEM_ACTOR_LABEL,
      authored_at: prev.edited_at,
    };
  });
}

/**
 * One page of an article's stored versions (metadata only — never body),
 * newest first, keyset on version_no. Fetches limit + 2 rows: one to know
 * whether more exist, one more to attribute the page's last version.
 */
export async function getContentVersions(
  contentId: string,
  beforeVersionNo?: number | null,
  limit = HISTORY_PAGE_SIZE,
): Promise<{ versions: VersionMeta[]; hasMore: boolean; error: string | null }> {
  const supabase = await createClient();
  const n = Math.min(100, Math.max(1, limit));
  let q = supabase
    .from("content_versions")
    .select("version_no,edited_by,edited_at")
    .eq("content_id", contentId)
    .order("version_no", { ascending: false })
    .limit(n + 2);
  if (beforeVersionNo != null) q = q.lt("version_no", beforeVersionNo);
  const { data, error } = await q;
  if (error) {
    console.error("[content] versions read failed:", error.message);
    return { versions: [], hasMore: false, error: error.message };
  }
  const rows = (data ?? []) as VersionMetaRaw[];
  const shown = rows.slice(0, n);
  return {
    versions: await attributeVersions(contentId, shown, rows),
    hasMore: rows.length > n,
    error: null,
  };
}

/** One full stored version (incl. body) + its author attribution, or null. */
export async function getContentVersion(
  contentId: string,
  versionNo: number,
): Promise<{ version: VersionSnapshot; meta: VersionMeta } | null> {
  const supabase = await createClient();
  const [{ data }, { data: prev }] = await Promise.all([
    supabase
      .from("content_versions")
      .select(
        "content_id,version_no,title,slug,excerpt,body,ai_summary,category_slug,type,cover_image_url,cover_credit_name,cover_credit_url,source_name,source_url,video_url,edited_by,edited_at",
      )
      .eq("content_id", contentId)
      .eq("version_no", versionNo)
      .maybeSingle(),
    supabase
      .from("content_versions")
      .select("version_no,edited_by,edited_at")
      .eq("content_id", contentId)
      .eq("version_no", versionNo - 1)
      .maybeSingle(),
  ]);
  if (!data) return null;
  const version = data as VersionSnapshot;
  const self: VersionMetaRaw = {
    version_no: version.version_no,
    edited_by: version.edited_by,
    edited_at: version.edited_at,
  };
  const all = prev ? [self, prev as VersionMetaRaw] : [self];
  const [meta] = await attributeVersions(contentId, [self], all);
  return { version, meta };
}

/** Evidence Intelligence sidecar row for one content item (admin read-only). */
export type EvidenceIntelligenceRow = {
  analysis_status: "complete" | "not_applicable" | "insufficient_source" | "analysis_failed";
  analyzed_url: string | null;
  analyzed_domain: string | null;
  evidence_strength: string | null;
  // Provenance: which source the card was actually derived from, and the
  // escalation-identified editorial primary when it could not be analyzed.
  evidence_source_status:
    | "primary_source_analyzed"
    | "supporting_source_analyzed"
    | "discovery_source_fallback"
    | "insufficient_source"
    | null;
  editorial_primary_url: string | null;
  editorial_primary_domain: string | null;
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
  const cols =
    "analysis_status,analyzed_url,analyzed_domain,evidence_strength,evidence_source_status,editorial_primary_url,editorial_primary_domain,card,model,updated_at";
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
