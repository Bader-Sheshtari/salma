/**
 * Shared (client + server) model for the admin Content Management screen
 * (/admin/content): URL state parsing, RPC parameter mapping, labels and the
 * row shape returned by the `search_content` RPC. No server-only imports here —
 * client components import the types/helpers too.
 */

export const CONTENT_TABS = [
  { key: "all", label: "الكل" },
  { key: "published", label: "منشور" },
  { key: "draft", label: "مسودة" },
  { key: "pending", label: "قيد المراجعة" },
  { key: "unpublished", label: "غير منشور" },
  { key: "rejected", label: "مرفوض" },
  { key: "trash", label: "المحذوفات" },
] as const;

export type ContentTab = (typeof CONTENT_TABS)[number]["key"];
const TAB_KEYS: readonly string[] = CONTENT_TABS.map((t) => t.key);
/** Real (non-trash, non-all) statuses — used by the الحالة filter inside الكل. */
export const REAL_STATUSES = ["published", "draft", "pending", "unpublished", "rejected"] as const;

export const STATUS_LABEL_AR: Record<string, string> = {
  published: "منشور",
  draft: "مسودة",
  pending: "قيد المراجعة",
  unpublished: "غير منشور",
  rejected: "مرفوض",
  trash: "محذوف",
};

export const TYPE_LABEL_AR: Record<string, string> = {
  news: "خبر",
  article: "مقال",
  video: "فيديو",
  investigation: "تحقيق",
};

export type ContentSort = "published_desc" | "published_asc" | "edited_desc" | "deleted_desc";
const SORTS: readonly string[] = ["published_desc", "published_asc", "edited_desc", "deleted_desc"];

export const SORT_LABEL_AR: Record<ContentSort, string> = {
  published_desc: "الأحدث نشرًا",
  published_asc: "الأقدم نشرًا",
  edited_desc: "آخر تعديل",
  deleted_desc: "الأحدث حذفًا",
};

/** Author filter value meaning "created by the pipeline" (created_by is null). */
export const SYSTEM_AUTHOR = "system";
export const SYSTEM_AUTHOR_LABEL = "سلمى (آلي)";

export const PAGE_SIZE = 50;

/** One row of `public.search_content(...)` (never includes body). */
export type ContentSearchRow = {
  id: string;
  title: string;
  slug: string;
  type: string;
  status: string;
  category_slug: string | null;
  category_name_ar: string | null;
  published_at: string | null;
  last_edited_at: string | null;
  deleted_at: string | null;
  author_name: string | null;
  deleted_by_name: string | null;
  version: number | null;
};

/** One row of `public.content_counts()`. */
export type ContentCountRow = {
  scope: string;
  status: string;
  category_slug: string | null;
  n: number | string;
};

/** Parameters for the `search_content` RPC (camelCase app-side). */
export type SearchContentParams = {
  q: string | null;
  status: string; // 'all' | real status | 'trash'
  category: string | null;
  from: string | null;
  to: string | null;
  author: string | null; // uuid
  authorSystem: boolean;
  reviewer: string | null;
  publisher: string | null;
  /** Explicit user choice only; null → RPC omits p_sort (per-tab default). */
  sort: ContentSort | null;
  /** Opaque timestamptz string exactly as the RPC returned it (never a Date). */
  cursorTs: string | null;
  cursorId: string | null;
  limit: number;
};

/** The URL-driven state of /admin/content. Empty string = not set. */
export type ContentQuery = {
  tab: ContentTab;
  st: string; // status filter inside الكل only
  cat: string;
  q: string;
  from: string;
  to: string;
  author: string; // uuid | 'system'
  reviewer: string;
  publisher: string;
  sort: string; // explicit sort ('' = tab default)
  cursorTs: string;
  cursorId: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const uuidOr = (v: string | null | undefined) => (v && UUID_RE.test(v) ? v : "");
const dateOr = (v: string | null | undefined) => (v && DATE_RE.test(v) ? v : "");
const isoOr = (v: string | null | undefined) =>
  v && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : "";

/** Normalize a user-typed query: trimmed, capped, and ignored below 2 chars. */
export function cleanQ(v: string | null | undefined): string {
  const s = (v ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return s.length >= 2 ? s : "";
}

type RawParams = Record<string, string | string[] | undefined>;
const one = (sp: RawParams, k: string) => {
  const v = sp[k];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

export function parseContentQuery(sp: RawParams): ContentQuery {
  const status = one(sp, "status");
  const tab = (TAB_KEYS.includes(status) ? status : "published") as ContentTab;
  const st = one(sp, "st");
  const author = one(sp, "author");
  const sort = one(sp, "sort");
  const cat = one(sp, "cat");
  return {
    tab,
    st: tab === "all" && (REAL_STATUSES as readonly string[]).includes(st) ? st : "",
    cat: SLUG_RE.test(cat) ? cat : "",
    q: cleanQ(one(sp, "q")),
    from: dateOr(one(sp, "from")),
    to: dateOr(one(sp, "to")),
    author: author === SYSTEM_AUTHOR ? SYSTEM_AUTHOR : uuidOr(author),
    reviewer: uuidOr(one(sp, "reviewer")),
    publisher: uuidOr(one(sp, "publisher")),
    sort: tab !== "trash" && SORTS.includes(sort) && sort !== "deleted_desc" ? sort : "",
    cursorTs: isoOr(one(sp, "cursor_ts")),
    cursorId: uuidOr(one(sp, "cursor_id")),
  };
}

/**
 * Default sort per view — MUST mirror search_content's p_sort NULL default:
 * trash → deleted_desc; published → published_desc; everything else
 * (all/search, draft, pending, unpublished, rejected) → edited_desc.
 */
export function defaultSort(status: string): ContentSort {
  if (status === "trash") return "deleted_desc";
  if (status === "published") return "published_desc";
  return "edited_desc";
}

/** The sort the RPC will actually apply (explicit choice, else the default). */
export function resolveSort(status: string, sort: ContentSort | null): ContentSort {
  const s = sort === "deleted_desc" && status !== "trash" ? null : sort;
  return s ?? defaultSort(status);
}

export function effectiveSort(q: ContentQuery): ContentSort {
  return resolveSort(q.tab, (q.sort as ContentSort) || null);
}

/** Which sorts the الترتيب dropdown offers in a tab ([] = dropdown hidden). */
export function sortOptions(tab: ContentTab): ContentSort[] {
  if (tab === "published" || tab === "unpublished" || tab === "all") {
    return ["published_desc", "published_asc", "edited_desc"];
  }
  return [];
}

export function toSearchParams(q: ContentQuery): SearchContentParams {
  return {
    q: q.q || null,
    status: q.tab === "all" && q.st ? q.st : q.tab,
    category: q.cat || null,
    from: q.from || null,
    to: q.to || null,
    author: q.author && q.author !== SYSTEM_AUTHOR ? q.author : null,
    authorSystem: q.author === SYSTEM_AUTHOR,
    reviewer: q.reviewer || null,
    publisher: q.publisher || null,
    sort: (q.sort as ContentSort) || null,
    cursorTs: q.cursorTs || null,
    cursorId: q.cursorId || null,
    limit: PAGE_SIZE,
  };
}

/** Re-validate params arriving from the client (server action input). */
export function sanitizeSearchParams(p: SearchContentParams): SearchContentParams {
  const status = String(p?.status ?? "");
  const sort = String(p?.sort ?? "");
  const cat = String(p?.category ?? "");
  return {
    q: cleanQ(p?.q) || null,
    status: TAB_KEYS.includes(status) ? status : "published",
    category: SLUG_RE.test(cat) ? cat : null,
    from: dateOr(p?.from) || null,
    to: dateOr(p?.to) || null,
    author: uuidOr(p?.author) || null,
    authorSystem: p?.authorSystem === true,
    reviewer: uuidOr(p?.reviewer) || null,
    publisher: uuidOr(p?.publisher) || null,
    sort: (SORTS.includes(sort) ? sort : null) as ContentSort | null,
    cursorTs: isoOr(p?.cursorTs) || null,
    cursorId: uuidOr(p?.cursorId) || null,
    limit: Math.min(100, Math.max(1, Math.floor(Number(p?.limit) || PAGE_SIZE))),
  };
}

/** Keyset cursor (sort column value + id) of the last row of a page. */
export function cursorOf(
  row: ContentSearchRow,
  status: string,
  explicitSort: ContentSort | null,
): { ts: string | null; id: string } {
  const sort = resolveSort(status, explicitSort);
  const ts =
    sort === "edited_desc"
      ? row.last_edited_at
      : sort === "deleted_desc"
        ? row.deleted_at
        : row.published_at;
  return { ts, id: row.id };
}

/** ContentQuery → URL params record (only set keys; never the cursor). */
export function queryToParams(q: ContentQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.tab !== "published") out.status = q.tab;
  if (q.st) out.st = q.st;
  if (q.cat) out.cat = q.cat;
  if (q.q) out.q = q.q;
  if (q.from) out.from = q.from;
  if (q.to) out.to = q.to;
  if (q.author) out.author = q.author;
  if (q.reviewer) out.reviewer = q.reviewer;
  if (q.publisher) out.publisher = q.publisher;
  if (q.sort) out.sort = q.sort;
  return out;
}

/** Build an /admin/content href from a params record (empty values dropped). */
export function contentHref(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `/admin/content?${s}` : "/admin/content";
}
