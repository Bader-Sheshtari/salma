import Link from "next/link";

export type Crumb = { label: string; href?: string };

/** Shorten a long label (e.g. an article title) for a crumb, with «…». */
export function truncateCrumb(label: string, max = 40): string {
  const s = label.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Admin breadcrumb trail (RTL, «←» separators). The last item is the current
 * page and is never linked. Below md, trails longer than three items collapse
 * their middle crumbs into «…», keeping the first and the last two.
 */
export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  const n = items.length;
  const collapsible = n > 3;
  const isMiddle = (i: number) => collapsible && i > 0 && i < n - 2;
  const sep = (
    <span aria-hidden className="shrink-0 text-gray/60">
      ←
    </span>
  );

  return (
    <nav aria-label="مسار التنقل" className="mb-2">
      <ol className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] text-gray">
        {items.map((c, i) => {
          const last = i === n - 1;
          return (
            <li
              key={`${i}-${c.label}`}
              className={`flex min-w-0 items-center gap-1.5 ${isMiddle(i) ? "hidden md:flex" : ""} ${
                last ? "shrink" : "shrink-0"
              }`}
            >
              {i > 0 ? sep : null}
              {last || !c.href ? (
                <span
                  aria-current={last ? "page" : undefined}
                  title={c.label}
                  className={`truncate ${last ? "font-semibold text-ink" : ""}`}
                >
                  {c.label}
                </span>
              ) : (
                <Link href={c.href} title={c.label} className="truncate hover:text-teal hover:underline">
                  {c.label}
                </Link>
              )}
              {/* Mobile-only «…» standing in for the collapsed middle crumbs. */}
              {collapsible && i === 0 ? (
                <span aria-hidden className="flex items-center gap-1.5 md:hidden">
                  {sep}…
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
