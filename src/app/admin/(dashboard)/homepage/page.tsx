import { listHomepageSections } from "@/lib/admin-queries";
import { moveHomepageSection } from "../../actions";
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
        رتّب الأقسام، فعّلها أو أوقفها، وتحكّم في العنوان ونمط العرض وعدد العناصر وزر «عرض الكل».
      </p>

      <ul className="flex flex-col gap-3">
        {sections.map((s, i) => (
          <li
            key={s.id}
            className={`rounded-2xl border bg-white p-4 ${s.is_enabled ? "border-line" : "border-line/60 opacity-70"}`}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-sans text-[11px] font-bold text-gray">#{s.sort_order}</span>
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
