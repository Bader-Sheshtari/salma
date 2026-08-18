import Link from "next/link";
import type { Content } from "@/lib/queries";
import { hrefFor } from "./cards";

export function BreakingTicker({ items }: { items: Content[] }) {
  if (items.length === 0) return null;
  // Duplicate the list so the marquee loops seamlessly.
  const loop = [...items, ...items];

  return (
    <div className="salma-ticker flex items-stretch overflow-hidden bg-coral text-ink">
      <div className="z-[2] flex shrink-0 items-center gap-2 bg-ink px-4 py-3 text-[13px] font-bold text-white">
        <span className="salma-pulse h-2 w-2 rounded-full bg-white" />
        عاجل
      </div>
      {/* items-stretch + flex links: each headline fills the bar's full height
          (~44px tap target) while the text stays vertically centred. Links are
          as tall as the clip box, so their focus ring is drawn inset. */}
      <div className="salma-ticker-rail salma-scroll flex flex-1 items-stretch overflow-hidden">
        <div className="salma-marquee flex gap-9 whitespace-nowrap px-4 text-[13px] font-semibold">
          {loop.map((c, i) => (
            <Link
              key={`${c.id}-${i}`}
              href={hrefFor(c)}
              className="salma-focus-inset flex items-center transition-colors hover:text-white"
            >
              {c.title}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
