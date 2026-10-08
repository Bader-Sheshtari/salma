"use server";

import { requireAdmin } from "@/lib/auth";
import { getContentAuditLog, getContentVersions, searchContent } from "@/lib/admin-queries";
import { sanitizeSearchParams, type SearchContentParams } from "@/lib/content-search";
import type { AuditCursor } from "@/lib/content-history";

/**
 * «تحميل المزيد»: next keyset page for the content table. Read-only proxy over
 * `search_content`; params come from the client so they are re-validated here.
 */
export async function loadMoreContent(params: SearchContentParams) {
  await requireAdmin();
  return searchContent(sanitizeSearchParams(params));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgREST timestamptz text, e.g. 2026-10-07T10:00:00.123456+00:00
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

/** «تحميل المزيد» for the activity timeline (keyset on created_at, id). */
export async function loadMoreAuditLog(contentId: string, cursor: AuditCursor) {
  await requireAdmin();
  const id = String(contentId);
  const ts = String(cursor?.ts ?? "");
  const cid = Number(cursor?.id);
  if (!UUID_RE.test(id) || !TS_RE.test(ts) || !Number.isSafeInteger(cid)) {
    return { events: [], hasMore: false, error: "invalid cursor" };
  }
  return getContentAuditLog(id, { ts, id: cid });
}

/** «تحميل المزيد» for the versions list (keyset on version_no). */
export async function loadMoreVersions(contentId: string, beforeVersionNo: number) {
  await requireAdmin();
  const id = String(contentId);
  const before = Number(beforeVersionNo);
  if (!UUID_RE.test(id) || !Number.isSafeInteger(before) || before < 1) {
    return { versions: [], hasMore: false, error: "invalid cursor" };
  }
  return getContentVersions(id, before);
}
