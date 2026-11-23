import Link from "next/link";
import type { Content } from "@/lib/queries";
import { hrefFor } from "./cards";

export function BreakingTicker({ items }: { items: Content[] }) {
  if (items.length === 0) return null;
  // Duplicate the list so the marquee loops seamlessly.
  const loop = [...items, ...items];

  return (
    <div className="salma-ticker flex min-h-11 items-stretch overflow-hidden bg-mauve text-amethyst">
      <div className="z-[2] flex shrink-0 items-center bg-mauve pe-3 ps-4">
        <span className="inline-flex items-center gap-2 rounded-full bg-amethyst px-3 pb-1 pt-1.5 text-[13.5px] font-bold leading-none text-white">
          <span className="salma-pulse h-2 w-2 rounded-full bg-mauve" />
          عاجل
        </span>
      </div>
      {/* items-stretch + flex links: each headline fills the bar's full height
          (~44px tap target) while the text stays vertically centred. Links are
          as tall as the clip box, so their focus ring is drawn inset. */}
      <div className="salma-ticker-rail salma-scroll flex flex-1 items-stretch overflow-hidden">
        <div className="salma-marquee flex gap-9 whitespace-nowrap px-4 text-[14.5px] font-medium">
          {loop.map((c, i) => (
            <Link
              key={`${c.id}-${i}`}
              href={hrefFor(c)}
              className="salma-focus-inset flex items-center gap-3 before:h-1 before:w-1 before:shrink-0 before:rounded-full before:bg-amethyst before:content-[''] hover:underline hover:underline-offset-4 focus-visible:outline-amethyst!"
            >
              {c.title}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
