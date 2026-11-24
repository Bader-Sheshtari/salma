// Pure lead-board selection + homepage de-duplication.
// Extracted from queries.ts so the logic is unit-testable without the Next.js
// server runtime (type-only imports keep this file runnable under `node --test`).
import type { Tables } from "@/lib/supabase/database.types";

type Content = Tables<"content">;

/** The non-hero slots of the homepage lead board (Direction E / refined H1). */
export type LeadBoard = {
  /** End rail: first item image-led feature, second a text story. */
  supporting: Content[];
  /** Start rail «الأحدث». */
  latest: Content[];
  /** «المزيد من الأخبار» text row under the board. */
  more: Content[];
};

/** Slot counts of the lead board, per the approved refined-H1 composition. */
export const LEAD_BOARD_COUNTS = { supporting: 2, latest: 4, more: 3 } as const;

/**
 * Lead-board story selection — single source of truth for
 * docs/SALMA_HOMEPAGE_IMPLEMENTATION_PLAN.md §2 (DB, DC) and §DUP.
 *
 * Input: `pool` = published, non-deleted, non-video stories, newest first;
 * `heroPool` = the hero carousel as already curated (admin `is_featured` pick
 * first, then latest — that logic is untouched and lives in `getHomepage`, so
 * admin hero curation always precedes and is never overridden here).
 * No editorial choice is hardcoded (no IDs/slugs). Slots fill in this
 * deterministic order — hero → supporting → «الأحدث» → «المزيد» (the ruled
 * resolution of DB/DC's mutual-exclusion wording):
 *
 *  1. Supporting rail (DB): eligible = in `pool` and not in the hero carousel;
 *     ranked (a) `is_breaking` first, (b) then stories with a cover image (the
 *     rail is image-led), (c) then freshness (`published_at` DESC — the pool
 *     order, kept by a stable sort). Takes LEAD_BOARD_COUNTS.supporting.
 *  2. «الأحدث» (DC): the most recently published eligible stories across all
 *     categories, excluding hero + supporting. Takes LEAD_BOARD_COUNTS.latest.
 *  3. «المزيد من الأخبار»: the next most recent eligible stories, excluding all
 *     of the above. Takes LEAD_BOARD_COUNTS.more.
 *
 * A story therefore appears at most once on the board.
 */
export function selectLeadBoard(pool: Content[], heroPool: Content[]): LeadBoard {
  const used = new Set(heroPool.map((c) => c.id));
  const eligible = () => pool.filter((c) => !used.has(c.id));
  const take = (list: Content[], n: number) => {
    const picked = list.slice(0, n);
    for (const c of picked) used.add(c.id);
    return picked;
  };

  const rank = (c: Content) => (c.is_breaking ? 2 : 0) + (c.cover_image_url ? 1 : 0);
  // Array.prototype.sort is stable, so equal ranks keep published_at DESC order.
  const supporting = take([...eligible()].sort((a, b) => rank(b) - rank(a)), LEAD_BOARD_COUNTS.supporting);
  const latest = take(eligible(), LEAD_BOARD_COUNTS.latest);
  const more = take(eligible(), LEAD_BOARD_COUNTS.more);
  return { supporting, latest, more };
}

/**
 * §DUP for one category section (plan §2), with the §DUP-V visibility
 * guarantee (owner ruling 2026-11-24): an ENABLED section that has eligible
 * published stories never disappears because of lead-board de-duplication.
 * `own` = the section's stories, newest first. Admin `items_limit` caps every
 * branch. Deterministic ladder:
 *
 *  1. Default — strict §DUP: drop every lead-board story. If the section is
 *     still full, done.
 *  2. Sanctioned fallback (§DUP): a section short of `items_limit` may
 *     re-admit ITS OWN hero-carousel stories (the carousel is transient) —
 *     never supporting/«الأحدث»/«المزيد» stories. If anything renders, done.
 *  3. Last resort (§DUP-V): only when steps 1–2 leave the section EMPTY while
 *     it has stories (i.e. every one of them sits in non-hero board slots),
 *     controlled duplication: render its own stories as-is, newest first,
 *     capped at `items_limit`.
 */
export function dedupSectionItems(
  own: Content[],
  limit: number,
  leadBoardIds: ReadonlySet<string>,
  heroIds: ReadonlySet<string>,
): Content[] {
  const strict = own.filter((c) => !leadBoardIds.has(c.id)).slice(0, limit);
  if (strict.length >= limit) return strict;
  const withHero = own.filter((c) => !leadBoardIds.has(c.id) || heroIds.has(c.id)).slice(0, limit);
  if (withHero.length > 0) return withHero;
  return own.slice(0, limit);
}
