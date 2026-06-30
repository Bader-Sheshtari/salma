import Link from "next/link";
import type { Content } from "@/lib/queries";
import { hrefFor } from "./cards";

export function BreakingTicker({ items }: { items: Content[] }) {
  if (items.length === 0) return null;
  // Duplicate the list so the marquee loops seamlessly.
  const loop = [...items, ...items];

  return (
    <div className="flex items-stretch overflow-hidden bg-ink text-white">
      <div className="z-[2] flex shrink-0 items-center gap-1.5 bg-coral px-3 py-2.5 text-xs font-bold text-ink">
        <span
          className="h-1.5 w-1.5 rounded-full bg-ink"
          style={{ animation: "salmaPulse 1.1s infinite" }}
        />
        عاجل
      </div>
      <div className="flex flex-1 items-center overflow-hidden">
        <div
          className="flex gap-9 whitespace-nowrap px-4 text-[12.5px] font-medium"
          style={{ animation: "salmaMarquee 28s linear infinite" }}
        >
          {loop.map((c, i) => (
            <Link key={`${c.id}-${i}`} href={hrefFor(c)} className="hover:text-gold">
              {c.title}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
