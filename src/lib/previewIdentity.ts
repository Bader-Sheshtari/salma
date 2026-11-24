// PREVIEW-ONLY identity configuration (pre-launch review aid).
//
// Production ALWAYS renders real Admin data: this overlay is applied by
// `getHomepage` only when BOTH `process.env.NODE_ENV === "development"` AND
// `process.env.SALMA_PREVIEW_IDENTITY === "1"` (see `npm run dev:preview`).
// In a production build NODE_ENV is inlined as "production", so the guarded
// branch is statically dead and this sheet is never applied.
//
// The real activation happens through the Admin UI at launch (plan §ORD /
// DF): the owner (or the implementer on his instruction) sets each section's
// accent, display_style, sort_order and items_limit to the values below.
//
// Because this is a data overlay standing in for Admin rows, matching by
// category_slug (and the transfers feature key) is acceptable HERE. Slugs must
// never leak into components — components only ever see `accent` /
// `display_style` through the DF map (`lib/sectionIdentity.ts`).

import type { Tables } from "@/lib/supabase/database.types";

type SectionRow = Tables<"homepage_sections">;

type SheetEntry = Partial<Pick<SectionRow, "accent" | "display_style" | "sort_order" | "items_limit">>;

/** The approved activation sheet (owner, pre-launch). Key = category_slug,
 * or the section `key` for feature sections. */
export const PREVIEW_ACTIVATION_SHEET: Record<string, SheetEntry> = {
  kuwait: { accent: "frost-rule", display_style: "featured", sort_order: 10, items_limit: 5 },
  gulf: { accent: "teal", display_style: "grid", sort_order: 20, items_limit: 3 },
  "health-economy": { accent: "pink", display_style: "featured", sort_order: 30, items_limit: 5 },
  world: { accent: "jet", display_style: "featured", sort_order: 40, items_limit: 4 },
  "feature:doctor_transfers": { accent: "vanilla", sort_order: 50, items_limit: 3 },
  lifestyle: { accent: "frost", display_style: "carousel", sort_order: 60, items_limit: 6 },
  "dawi-news": { accent: "mauve", display_style: "featured", sort_order: 70, items_limit: 3 },
  investigations: { accent: "wine", display_style: "list", sort_order: 80, items_limit: 4 },
};

/** True only in local development with the explicit preview flag. */
export function previewIdentityEnabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env.SALMA_PREVIEW_IDENTITY === "1";
}

/** Overlays the activation sheet onto the enabled Admin rows (preview only),
 * re-sorting by the overlaid sort_order. Rows not in the sheet are untouched. */
export function applyPreviewIdentity(rows: SectionRow[]): SectionRow[] {
  return rows
    .map((r) => {
      const entry = PREVIEW_ACTIVATION_SHEET[r.kind === "category" && r.category_slug ? r.category_slug : r.key];
      return entry ? { ...r, ...entry } : r;
    })
    .sort((a, b) => a.sort_order - b.sort_order);
}
