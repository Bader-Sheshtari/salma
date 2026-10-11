import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SOURCE_LABELS_AR } from "@/lib/reader-analytics";

/**
 * Compact per-article reader analytics (§Reader Analytics V1): views /
 * engaged / completion over 7 and 30 days + the top traffic source.
 * Secondary to the editorial controls — one slim strip, staff-visible
 * (the RPC itself is staff-gated). Renders nothing for never-published
 * articles or when analytics are unavailable.
 */

type Window = {
  views: number;
  engaged: number;
  completed: number;
  completion_rate: number | null;
  top_source: string | null;
};

export async function ArticleStatsPanel({
  contentId,
  everPublished,
}: {
  contentId: string;
  everPublished: boolean;
}) {
  if (!everPublished) return null;
  let stats: { d7?: Window; d30?: Window } | null = null;
  try {
    const supabase = await createClient();
    const { data, error } = await (supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
    }).rpc("reader_article_stats", { p_content_id: contentId });
    if (!error) stats = data as { d7?: Window; d30?: Window };
  } catch {
    return null;
  }
  if (!stats?.d7 || !stats?.d30) return null;

  const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}٪`);
  const row = (label: string, w: Window) => (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
      <span className="w-20 shrink-0 text-[11.5px] font-bold text-gray">{label}</span>
      <span className="font-sans text-[12px]">
        <span className="font-bold text-teal">{w.views}</span> مشاهدة
      </span>
      <span className="font-sans text-[12px]">
        <span className="font-bold text-teal">{w.engaged}</span> متفاعلة
      </span>
      <span className="font-sans text-[12px]">اكتمال {pct(w.completion_rate)}</span>
      {w.top_source ? (
        <span className="text-[11.5px] text-gray">
          أبرز مصدر: {SOURCE_LABELS_AR[w.top_source] ?? w.top_source}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="mb-5 max-w-2xl rounded-2xl border border-line bg-white p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-bold">أداء المقال لدى القراء</div>
        <Link href="/admin/analytics" className="font-sans text-[11px] text-teal hover:underline">
          التحليلات الكاملة ←
        </Link>
      </div>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {row("آخر ٧ أيام", stats.d7)}
        {row("آخر ٣٠ يوماً", stats.d30)}
      </div>
    </div>
  );
}
