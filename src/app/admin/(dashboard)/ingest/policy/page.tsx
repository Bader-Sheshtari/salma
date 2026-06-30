import Link from "next/link";
import { getEditorialPolicy } from "@/lib/admin-queries";
import { PolicyForm } from "./PolicyForm";

export const dynamic = "force-dynamic";

export default async function PolicyPage() {
  const policy = await getEditorialPolicy();

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="mb-1 text-2xl font-bold">السياسة التحريرية</h1>
          <p className="max-w-2xl text-[13.5px] text-gray">
            تتحكّم هذه الإعدادات في وكيل جلب الأخبار: المناطق التي يبحث فيها، المواضيع التي يستبعدها،
            المواضيع ذات الأولوية، والمصادر الموثوقة. تُطبَّق فوراً على عمليات الجلب التالية.
          </p>
        </div>
        <Link
          href="/admin/ingest"
          className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-ink hover:bg-cream"
        >
          ← العودة للجلب
        </Link>
      </div>

      <PolicyForm policy={policy} />
    </div>
  );
}
