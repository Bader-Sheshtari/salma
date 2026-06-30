import Link from "next/link";
import { getAdminCounts } from "@/lib/admin-queries";

export const dynamic = "force-dynamic";

function Stat({ label, value, href, accent }: { label: string; value: number; href: string; accent: string }) {
  return (
    <Link
      href={href}
      className="rounded-2xl border border-line bg-white p-5 transition hover:shadow-md"
    >
      <div className="text-3xl font-bold" style={{ color: accent }}>
        {value}
      </div>
      <div className="mt-1 text-[13px] font-semibold text-gray">{label}</div>
    </Link>
  );
}

export default async function AdminHome() {
  const c = await getAdminCounts();

  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">لوحة التحكم</h1>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="منشور" value={c.published} href="/admin/content?status=published" accent="var(--salma-teal)" />
        <Stat label="مسودّات" value={c.draft} href="/admin/content?status=draft" accent="var(--salma-gray)" />
        <Stat label="بانتظار المراجعة" value={c.pending_content} href="/admin/content?status=pending" accent="var(--salma-blue)" />
        <Stat label="تعليقات معلّقة" value={c.pending_comments} href="/admin/comments" accent="var(--salma-coral)" />
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/admin/content/new" className="rounded-lg bg-teal px-4 py-2.5 text-[13.5px] font-bold text-white">
          + إضافة محتوى
        </Link>
        <Link href="/admin/content" className="rounded-lg border border-line bg-white px-4 py-2.5 text-[13.5px] font-semibold">
          إدارة المحتوى
        </Link>
        <Link href="/admin/comments" className="rounded-lg border border-line bg-white px-4 py-2.5 text-[13.5px] font-semibold">
          مراجعة التعليقات
        </Link>
      </div>
    </div>
  );
}
