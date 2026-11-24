import type { Content } from "@/lib/queries";
import { timeAgoAr } from "@/lib/format";
import { identityFor, showCategoryTag } from "@/lib/sectionIdentity";

/** Lookups the story meta needs: category names and each category's section
 * identity (category → its homepage section's `accent`, via the DF map). */
export type CategoryLookups = {
  names: Record<string, string>;
  accents: Record<string, string | null>;
};

/**
 * Story meta DNA shared by the lead board (server rails + client hero) and the
 * homepage sections. Hook-free so both server and client components import it.
 *
 *   reading-time pill (or relative time) · category mark + name
 *
 * §LBL — the category tag follows the ONE documented condition
 * `showCategoryTag(story, collection)`: mixed collections (lead board) pass
 * `collectionCategory = null` → tag always shows; single-category sections
 * pass their own slug → same-category tags are omitted.
 * The mark colour comes from the story category's section identity (DF map),
 * never from a hardcoded slug; unknown → neutral amethyst.
 */
export function LeadMeta({
  c,
  lookups,
  collectionCategory = null,
  mode = "read",
  pill = "bg-amethyst-100",
  body = "text-amethyst-600",
}: {
  c: Pick<Content, "read_minutes" | "published_at" | "category_slug">;
  lookups: CategoryLookups;
  collectionCategory?: string | null;
  mode?: "read" | "time";
  /** Reading-pill background of the surface the meta sits on. */
  pill?: string;
  /** Meta text colour of the surface the meta sits on (≥4.5:1). */
  body?: string;
}) {
  const n = c.read_minutes;
  const showRead = mode === "read" && !!n;
  const slug = c.category_slug;
  const tag = slug && showCategoryTag(slug, collectionCategory) ? lookups.names[slug] : undefined;
  const mark = slug ? identityFor(lookups.accents[slug]).mark : "";
  if (!showRead && !c.published_at && !tag) return null;
  return (
    // 13px below 768px (no visible text under 13px on mobile), 11px desktop.
    <p className={`mt-2 flex flex-wrap items-center gap-1.5 text-[13px] leading-snug md:text-[11px] ${body}`}>
      {showRead ? (
        <span className={`rounded-full px-2 pb-px pt-0.5 text-amethyst ${pill}`}>
          <span className="font-sans">{n}</span> {n === 1 ? "دقيقة" : "دقائق"} قراءة
        </span>
      ) : c.published_at ? (
        <time dateTime={c.published_at}>{timeAgoAr(c.published_at)}</time>
      ) : null}
      {tag ? (
        <>
          {showRead || c.published_at ? (
            <span aria-hidden className="opacity-60">
              ·
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5" data-cat-tag={slug}>
            <span aria-hidden className={`h-[3px] w-3.5 shrink-0 rounded-sm ${mark}`} />
            {tag}
          </span>
        </>
      ) : null}
    </p>
  );
}

/**
 * 48px icon tile for text-only stories. Tint = the story category's identity
 * tile (DF map); glyph = story type (video: play · article: page · news and
 * anything else: the brand pulse). Graphic only.
 */
export function StoryTile({ type, tile = "bg-mauve-20" }: { type?: string | null; tile?: string }) {
  const glyph =
    type === "video" ? (
      <path d="M12 9.5v13l10-6.5z" fill="currentColor" />
    ) : type === "article" ? (
      <>
        <path d="M9 6h11l4 4v16H9z" />
        <path d="M13 15h7M13 19h7M13 11h4" />
      </>
    ) : (
      <path d="M3 17h7l3-8 5 14 3-6h8" />
    );
  return (
    <span aria-hidden className={`grid size-12 shrink-0 place-items-center rounded-xl ${tile}`}>
      <svg
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-6 text-amethyst"
      >
        {glyph}
      </svg>
    </span>
  );
}

/** Tile tint for a story: its category's identity tile (paper default). */
export function tileFor(c: Pick<Content, "category_slug">, lookups: CategoryLookups): string {
  return identityFor(c.category_slug ? lookups.accents[c.category_slug] : null).tile;
}
