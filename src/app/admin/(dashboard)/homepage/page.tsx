import { listHomepageSections } from "@/lib/admin-queries";
import { moveHomepageSection, setHomepageSectionPosition } from "../../actions";
import { HomepageSectionForm } from "./HomepageSectionForm";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = { category: "قسم", feature: "ميزة" };

export default async function HomepageSectionsPage() {
  const sections = await listHomepageSections();

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">أقسام الصفحة الرئيسية</h1>
      </div>
      <p className="mb-5 text-[13px] text-gray">
        تحكّم بترتيب ظهور الأقسام على الصفحة الرئيسية — بالأسهم أو بكتابة رقم الموضع مباشرةً — وفعّلها أو
        أوقفها، وعدّل العنوان ونمط العرض وعدد العناصر وزر «عرض الكل».
      </p>

      <ul className="flex flex-col gap-3">
        {sections.map((s, i) => (
          <li
            key={s.id}
            className={`rounded-2xl border bg-white p-4 ${s.is_enabled ? "border-line" : "border-line/60 opacity-70"}`}
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
            <HomepageSectionForm section={s} />
          </li>
        ))}
      </ul>
    </div>
  );
}
