import { listRadarArticles, listRadarContentLinks, listCategories } from "@/lib/admin-queries";
import RadarInbox from "./RadarInbox";

export const dynamic = "force-dynamic";

// Fast News Radar admin page. Editorial triage of articles discovered by the
// radar-shadow collector, plus the one-click publish path (via radar-actions).
export default async function RadarPage() {
  const [items, categories] = await Promise.all([
    listRadarArticles(),
    listCategories(),
  ]);
  // Slugs/status for the content rows the radar rows link to, so the card can
  // open the actual published article (and the existing article for duplicates).
  const contentLinks = await listRadarContentLinks(
    items.flatMap((a) => [a.published_content_id, a.matched_content_id]),
  );

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-2xl font-bold">رادار الأخبار</h1>
        <span className="rounded-md bg-ink px-2 py-0.5 font-sans text-[10px] font-bold tracking-wide text-white">
          RADAR · SHADOW
        </span>
      </div>
      <p className="mb-4 text-[13px] text-gray">
        اكتشاف عالمي متعدد اللغات للأخبار الصحية. النشر إلى سلمى يتم يدويًا فقط عند الضغط على «نشر في سلمى».
      </p>
      <RadarInbox
        items={items}
        categories={categories.map((c) => ({ slug: c.slug, name_ar: c.name_ar }))}
        contentLinks={contentLinks}
      />
    </div>
  );
}
