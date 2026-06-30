import Link from "next/link";
import { IngestForm } from "./IngestForm";

export const dynamic = "force-dynamic";

export default function IngestPage() {
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="mb-2 text-2xl font-bold">جلب الأخبار بالذكاء الاصطناعي</h1>
          <p className="text-[13.5px] text-gray">
            يجلب الوكيل أخباراً صحية حقيقية من مصادر موثوقة مع روابطها، وتبقى بانتظار مراجعتك قبل النشر.
          </p>
        </div>
        <Link
          href="/admin/ingest/runs"
          className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-ink hover:bg-cream"
        >
          سجلّ الجلب ←
        </Link>
      </div>
      <IngestForm />
    </div>
  );
}
