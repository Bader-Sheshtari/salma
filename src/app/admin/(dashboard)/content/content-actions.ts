"use server";

import { requireAdmin } from "@/lib/auth";
import { searchContent } from "@/lib/admin-queries";
import { sanitizeSearchParams, type SearchContentParams } from "@/lib/content-search";

/**
 * «تحميل المزيد»: next keyset page for the content table. Read-only proxy over
 * `search_content`; params come from the client so they are re-validated here.
 */
export async function loadMoreContent(params: SearchContentParams) {
  await requireAdmin();
  return searchContent(sanitizeSearchParams(params));
}
