import Link from "next/link";
import type { Content } from "@/lib/queries";
import { hrefFor } from "./cards";

export function BreakingTicker({ items }: { items: Content[] }) {
  if (items.length === 0) return null;
  // Duplicate the list so the marquee loops seamlessly.
  const loop = [...items, ...items];

  return (
    <div className="flex items-stretch overflow-hidden bg-coral text-ink">
      <div className="z-[2] flex shrink-0 items-center gap-2 bg-ink px-4 py-3 text-[13px] font-bold text-white">
        <span
          className="h-2 w-2 rounded-full bg-white"
          style={{ animation: "salmaPulse 1.1s infinite" }}
        />
        عاجل
      </div>
      <div className="flex flex-1 items-center overflow-hidden">
        <div
          className="flex gap-9 whitespace-nowrap px-4 text-[13px] font-semibold"
          style={{ animation: "salmaMarquee 30s linear infinite" }}
        >
          {loop.map((c, i) => (
            <Link
              key={`${c.id}-${i}`}
              href={hrefFor(c)}
              className="transition-colors hover:text-white"
            >
              {c.title}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
