import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Slugify a title into a URL-safe token. Strips Arabic diacritics and keeps
 * Arabic/Latin letters + numbers, lowercased and capped at 80 chars. */
export function slugify(input: string): string {
  return input
    .trim()
    .replace(/[\u064B-\u065F\u0610-\u061A]/g, "") // strip Arabic diacritics
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .toLowerCase();
}

type SluggableTable = "content" | "departments" | "doctors" | "doctor_transfers";

/**
 * Return a slug unique within `table`, appending `-2`, `-3`… on collision.
 * Pass `softDelete: false` for tables without a `deleted_at` column
 * (e.g. departments), otherwise soft-deleted rows are ignored.
 */
export async function ensureUniqueSlug(
  table: SluggableTable,
  base: string,
  excludeId?: string,
  softDelete = true,
): Promise<string> {
  const supabase = await createClient();
  const root = base || "item";
  let candidate = root;

  for (let n = 1; n < 50; n++) {
    let query = supabase.from(table).select("id").eq("slug", candidate).limit(1);
    if (softDelete) query = query.is("deleted_at", null);
    if (excludeId) query = query.neq("id", excludeId);

    const { data } = await query;
    if (!data || data.length === 0) return candidate;
    candidate = `${root}-${n + 1}`;
  }

  return `${root}-${Date.now()}`;
}
