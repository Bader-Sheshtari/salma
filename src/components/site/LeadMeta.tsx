import type { Content } from "@/lib/queries";
import { timeAgoAr } from "@/lib/format";

/**
 * Lead-board building blocks shared by the server-rendered rails (HomeView) and
 * the client hero (RotatingHero). Hook-free on purpose so both can import it.
 *
 * Meta DNA per the approved refined H1: reading-time pill (or relative time) ·
 * category mark + name. The category tag is rendered only when a name is
 * passed — the lead board is a mixed collection, so it always shows (§LBL).
 * Category colour per section identity arrives with the DF map (Phase 3);
 * until then the mark is neutral amethyst.
 */
export function LeadMeta({
  c,
  categoryName,
  mode = "read",
}: {
  c: Pick<Content, "read_minutes" | "published_at">;
  categoryName?: string;
  mode?: "read" | "time";
}) {
  const n = c.read_minutes;
  const showRead = mode === "read" && !!n;
  return (
    // 13px below 768px (no visible text under 13px on mobile), 11px desktop.
    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] leading-snug text-amethyst-600 md:text-[11px]">
      {showRead ? (
        <span className="rounded-full bg-amethyst-100 px-2 pb-px pt-0.5 text-amethyst">
          <span className="font-sans">{n}</span> {n === 1 ? "دقيقة" : "دقائق"} قراءة
        </span>
      ) : c.published_at ? (
        <time dateTime={c.published_at}>{timeAgoAr(c.published_at)}</time>
      ) : null}
      {categoryName ? (
        <>
          <span aria-hidden className="opacity-60">
            ·
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-[3px] w-3.5 shrink-0 rounded-sm bg-amethyst-400" />
            {categoryName}
          </span>
        </>
      ) : null}
    </p>
  );
}

/** 48px icon tile for text-only stories (brand pulse glyph on a mauve-20 tile). */
export function PulseTile() {
  return (
    <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-xl bg-mauve-20">
      <svg
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-6 text-amethyst"
      >
        <path d="M3 17h7l3-8 5 14 3-6h8" />
      </svg>
    </span>
  );
}
