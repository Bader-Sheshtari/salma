import Link from "next/link";
import { listContent, listCategories } from "@/lib/admin-queries";
import ContentInbox from "./ContentInbox";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "", label: "الكل" },
  { key: "published", label: "منشور" },
  { key: "pending", label: "بانتظار المراجعة" },
  { key: "draft", label: "مسودّة" },
  { key: "rejected", label: "مرفوض" },
];

type Props = { searchParams: Promise<{ status?: string }> };

export default async function ContentList({ searchParams }: Props) {
  const { status = "" } = await searchParams;
  const [items, categories] = await Promise.all([
    listContent(status || undefined),
    listCategories(),
  ]);

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

      <ContentInbox items={items} categories={categories} />
    </div>
  );
}
