import { listHomepageSections, listHeroOptions } from "@/lib/admin-queries";
import { setMainContent } from "../../actions";
import { SectionOrderList } from "./SectionOrderList";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = { article: "مقال", video: "فيديو" };

export default async function HomepageSectionsPage() {
  const [sections, heroOptions] = await Promise.all([listHomepageSections(), listHeroOptions()]);
  // Mirror the homepage's hero pick: the newest featured item (options are newest-first).
  const currentHeroId = heroOptions.find((c) => c.is_featured)?.id ?? "";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">أقسام الصفحة الرئيسية</h1>
      </div>
      <p className="mb-5 text-[13px] text-gray">
        تحكّم بترتيب ظهور الأقسام على الصفحة الرئيسية — اسحب البطاقة من المقبض ⠿ لإعادة ترتيبها — وفعّلها أو
        أوقفها، وعدّل العنوان ونمط العرض وعدد العناصر وزر «عرض الكل».
      </p>

      <section className="mb-6 rounded-2xl border border-line bg-white p-4 sm:p-5">
        <h2 className="mb-1 text-[15px] font-bold">الخبر الرئيسي (الكبير في الأعلى)</h2>
        <p className="mb-3 text-[13px] text-gray">
          اختر المقال الذي يظهر كبيراً أعلى الصفحة الرئيسية. اترك الخيار فارغاً ليُختار تلقائياً أحدث خبر.
        </p>
        <form action={setMainContent} className="flex flex-wrap items-center gap-2">
          <select
            name="id"
            defaultValue={currentHeroId}
            className="min-w-0 flex-1 rounded-lg border border-gray/40 px-3 py-2 text-sm outline-none focus:border-teal sm:max-w-lg"
          >
            <option value="">— تلقائي (أحدث خبر) —</option>
            {heroOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} · {TYPE_LABELS[c.type] ?? c.type}
              </option>
            ))}
          </select>
          <button className="rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white hover:opacity-90">
            حفظ
          </button>
        </form>
      </section>

      <h2 className="mb-3 text-[15px] font-bold">ترتيب الأقسام</h2>
      <SectionOrderList sections={sections} />
    </div>
  );
}
