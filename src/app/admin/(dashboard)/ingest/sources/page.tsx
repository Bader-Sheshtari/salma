import Link from "next/link";
import { listNewsSources } from "@/lib/admin-queries";
import { SourcesManager } from "./SourcesManager";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const sources = await listNewsSources();

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="mb-1 text-2xl font-bold">سِجِلّ المصادر</h1>
          <p className="max-w-2xl text-[13.5px] text-gray">
            هذا السِّجِلّ هو المرجع المُعتمد لترتيب المصادر في وكيل جلب الأخبار: أي المصادر يُبحث فيها،
            وأيّها يُقبل كمصدر نهائي، وأولوية المصادر الأساسية على المُجمِّعات.
          </p>
        </div>
        <Link
          href="/admin/ingest"
          className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-ink hover:bg-cream"
        >
          ← العودة للجلب
        </Link>
      </div>

      <div className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-[12.5px] leading-relaxed text-amber-900">
        <strong className="font-bold">تنبيه:</strong> ثقة المصدر لا تعني تلقائياً أن الخبر ذو قيمة تحريرية.
        قد تُرفض بيانات المؤسسات الرسمية ذات الطابع الاحتفالي أو الدعائي (مؤتمرات، زيارات، تكريمات،
        مذكرات تفاهم بلا مخرجات) حتى لو كان المصدر موثوقاً، ما لم تتضمّن تطويراً حقيقياً يهمّ القارئ.
      </div>

      <SourcesManager sources={sources} />
    </div>
  );
}
