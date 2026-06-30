import Link from "next/link";
import { listComments } from "@/lib/admin-queries";
import { moderateComment } from "../../actions";
import { timeAgoAr } from "@/lib/format";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "pending", label: "بانتظار المراجعة" },
  { key: "approved", label: "منشورة" },
  { key: "rejected", label: "مرفوضة" },
];

type Props = { searchParams: Promise<{ status?: string }> };

export default async function CommentsModeration({ searchParams }: Props) {
  const { status = "pending" } = await searchParams;
  const comments = await listComments(status);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">التعليقات</h1>

      <div className="salma-scroll mb-4 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/comments?status=${t.key}`}
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
              status === t.key ? "bg-teal text-white" : "border border-line bg-white text-gray"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {comments.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white p-6 text-[14px] text-gray">
          لا توجد تعليقات.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {comments.map((c) => (
            <li key={c.id} className="rounded-2xl border border-line bg-white p-4">
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-bold">{c.author_name}</span>
                <span className="font-sans text-[11px] text-gray">{timeAgoAr(c.created_at)}</span>
              </div>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{c.body}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {status !== "approved" ? (
                  <form action={moderateComment}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="action" value="approve" />
                    <button className="rounded-lg bg-teal px-3.5 py-1.5 text-[12.5px] font-semibold text-white">
                      اعتماد
                    </button>
                  </form>
                ) : null}
                {status !== "rejected" ? (
                  <form action={moderateComment}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="action" value="reject" />
                    <button className="rounded-lg border border-line px-3.5 py-1.5 text-[12.5px] font-semibold">
                      رفض
                    </button>
                  </form>
                ) : null}
                <form action={moderateComment}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="action" value="delete" />
                  <button className="rounded-lg border border-line px-3.5 py-1.5 text-[12.5px] font-semibold text-coral">
                    حذف
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
