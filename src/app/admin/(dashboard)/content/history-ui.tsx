import { timeAgoAr } from "@/lib/format";
import { absAr } from "@/lib/content-history";

/** Relative Arabic date with the absolute (Kuwait) date/time on hover. */
export function RelTime({ iso }: { iso: string | null }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={absAr(iso)} suppressHydrationWarning>
      {timeAgoAr(iso)}
    </time>
  );
}
