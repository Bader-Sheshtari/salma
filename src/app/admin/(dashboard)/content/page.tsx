import Link from "next/link";
import { listContent } from "@/lib/admin-queries";
import { setStatus, softDeleteContent } from "../../actions";
import { timeAgoAr } from "@/lib/format";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "", label: "الكل" },
  { key: "published", label: "منشور" },
  { key: "pending", label: "بانتظار المراجعة" },
  { key: "draft", label: "مسودّة" },
];

const STATUS_LABEL: Record<string, string> = {
  published: "منشور",
  pending: "مراجعة",
  draft: "مسودّة",
  rejected: "مرفوض",
};

type Props = { searchParams: Promise<{ status?: string }> };

export default async function ContentList({ searchParams }: Props) {
  const { status = "" } = await searchParams;
  const items = await listContent(status || undefined);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">المحتوى</h1>
        <Link href="/admin/content/new" className="rounded-lg bg-teal px-4 py-2.5 text-[13px] font-bold text-white">
          + إضافة
        </Link>
      </div>

      <div className="salma-scroll mb-4 flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key ? `/admin/content?status=${f.key}` : "/admin/content"}
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
              status === f.key ? "bg-teal text-white" : "border border-line bg-white text-gray"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        {items.length === 0 ? (
          <div className="p-6 text-[14px] text-gray">لا يوجد محتوى.</div>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10px] font-semibold text-teal">
                      {c.type}
                    </span>
                    <span className="rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold text-white" style={{ background: c.status === "published" ? "var(--salma-teal)" : c.status === "pending" ? "var(--salma-blue)" : "var(--salma-gray)" }}>
                      {STATUS_LABEL[c.status] ?? c.status}
                    </span>
                    <span className="truncate text-[14px] font-semibold">{c.title}</span>
                  </div>
                  <div className="mt-1 font-sans text-[11px] text-gray">
                    {c.category_slug ?? "—"} · {timeAgoAr(c.updated_at)}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Link href={`/admin/content/${c.id}`} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-cream">
                    تحرير
                  </Link>
                  {c.status !== "published" ? (
                    <form action={setStatus}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="status" value="published" />
                      <button className="rounded-lg bg-teal px-3 py-1.5 text-[12.5px] font-semibold text-white">نشر</button>
                    </form>
                  ) : (
                    <form action={setStatus}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="status" value="draft" />
                      <button className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold">إلغاء النشر</button>
                    </form>
                  )}
                  <form action={softDeleteContent}>
                    <input type="hidden" name="id" value={c.id} />
                    <button className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold text-coral hover:bg-cream">حذف</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
