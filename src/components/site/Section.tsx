import Link from "next/link";
import type { ReactNode } from "react";

export function SectionTitle({
  title,
  sub,
  bar = "var(--salma-green)",
  color,
  href,
  action,
}: {
  title: string;
  sub?: string;
  bar?: string;
  color?: string;
  href?: string;
  action?: string;
}) {
  return (
    <div className="mb-3.5 flex items-end justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span className="w-1 rounded-sm" style={{ height: sub ? 24 : 22, background: bar }} />
        <div>
          <div className="text-[17px] font-bold sm:text-lg" style={color ? { color } : undefined}>
            {title}
          </div>
          {sub ? (
            <div className="mt-0.5 font-sans text-[11px] tracking-wide text-gray">{sub}</div>
          ) : null}
        </div>
      </div>
      {action && href ? (
        // 16px text link → ~44px hit area (fills the mb-3.5 gap below, never the rail)
        <Link
          href={href}
          className="relative text-xs font-semibold text-green before:absolute before:-inset-x-2 before:-inset-y-3.5 hover:opacity-80"
        >
          {action}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Horizontal scroll rail on mobile, responsive grid on larger screens.
 * Each item gets a fixed width while scrolling, then flexes in the grid.
 */
export function Rail({
  items,
  cols,
  itemWidth = "w-[230px]",
}: {
  items: ReactNode[];
  cols: string;
  itemWidth?: string;
}) {
  return (
    // -m/p (4px): the scroll container's padding box grows so the first card's
    // focus ring isn't clipped at the top/start edge; layout is unchanged.
    <div
      className={`salma-scroll -mx-1 -mt-1 flex gap-3 overflow-x-auto px-1 pt-1 pb-1 sm:grid sm:overflow-visible ${cols}`}
    >
      {items.map((item, i) => (
        <div key={i} className={`${itemWidth} shrink-0 sm:w-auto`}>
          {item}
        </div>
      ))}
    </div>
  );
}
