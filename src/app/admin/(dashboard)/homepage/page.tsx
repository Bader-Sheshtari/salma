import { listHomepageSections, listHeroOptions } from "@/lib/admin-queries";
import { moveHomepageSection, setHomepageSectionPosition, setMainContent } from "../../actions";
import { HomepageSectionForm } from "./HomepageSectionForm";
import { HomepageVisibilityToggle } from "./HomepageVisibilityToggle";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = { category: "قسم", feature: "ميزة" };
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
        تحكّم بترتيب ظهور الأقسام على الصفحة الرئيسية — بالأسهم أو بكتابة رقم الموضع مباشرةً — وفعّلها أو
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
      <ul className="flex flex-col gap-3">
        {sections.map((s, i) => (
          <li
            key={s.id}
            className="rounded-2xl border border-line bg-white p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <form action={setHomepageSectionPosition} className="flex items-center gap-1">
                  <input type="hidden" name="id" value={s.id} />
                  <span className="font-sans text-[11px] font-bold text-gray">الموضع</span>
                  <input
                    name="position"
                    type="number"
                    min={1}
                    max={sections.length}
                    defaultValue={i + 1}
                    aria-label="الموضع"
                    className="w-14 rounded-lg border border-gray/40 px-2 py-1 text-center font-sans text-[13px] outline-none focus:border-teal"
                  />
                  <button className="rounded-lg border border-line px-2 py-1 text-[12px] font-semibold hover:bg-cream">
                    نقل
                  </button>
                </form>
                <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10px] font-semibold text-teal">
                  {KIND_LABELS[s.kind] ?? s.kind}
                </span>
                <span dir="ltr" className="font-sans text-[11px] text-gray">{s.key}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <form action={moveHomepageSection}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="dir" value="up" />
                  <button
                    disabled={i === 0}
                    className="rounded-lg border border-line px-2.5 py-1 text-[13px] font-bold disabled:opacity-40 hover:bg-cream"
                    aria-label="تحريك للأعلى"
                  >
                    ↑
                  </button>
                </form>
                <form action={moveHomepageSection}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="dir" value="down" />
                  <button
                    disabled={i === sections.length - 1}
                    className="rounded-lg border border-line px-2.5 py-1 text-[13px] font-bold disabled:opacity-40 hover:bg-cream"
                    aria-label="تحريك للأسفل"
                  >
                    ↓
                  </button>
                </form>
              </div>
            </div>
            <HomepageVisibilityToggle section={s} />
            <HomepageSectionForm section={s} />
          </li>
        ))}
      </ul>
    </div>
  );
}
