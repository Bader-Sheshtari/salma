import { listRadarArticles, listCategories } from "@/lib/admin-queries";
import RadarInbox from "./RadarInbox";

export const dynamic = "force-dynamic";

// Fast News Radar (SHADOW MODE) admin page. Read-only editorial triage of
// articles discovered by the radar-shadow collector. Not connected to the
// Writer, Editorial Director, Fidelity, content, or publishing.
export default async function RadarPage() {
  const [items, categories] = await Promise.all([
    listRadarArticles(),
    listCategories(),
  ]);

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-2xl font-bold">رادار الأخبار</h1>
        <span className="rounded-md bg-ink px-2 py-0.5 font-sans text-[10px] font-bold tracking-wide text-white">
          RADAR · SHADOW
        </span>
      </div>
      <p className="mb-4 text-[13px] text-gray">
        اكتشاف عالمي متعدد اللغات للأخبار الصحية — للمراجعة فقط، غير متصل بالنشر أو خط الإنتاج.
      </p>
      <RadarInbox
        items={items}
        categories={categories.map((c) => ({ slug: c.slug, name_ar: c.name_ar }))}
      />
    </div>
  );
}
