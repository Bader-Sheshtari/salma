import Link from "next/link";
import { listRatings } from "@/lib/admin-queries";
import { moderateRating } from "../../../actions";
import { timeAgoAr } from "@/lib/format";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "pending", label: "بانتظار المراجعة" },
  { key: "approved", label: "منشورة" },
  { key: "rejected", label: "مرفوضة" },
];

function stars(n: number): string {
  return "★".repeat(n) + "☆".repeat(5 - n);
}

type Props = { searchParams: Promise<{ status?: string }> };

export default async function RatingsModeration({ searchParams }: Props) {
  const { status = "pending" } = await searchParams;
  const ratings = await listRatings(status);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">تقييمات الأطباء</h1>
        <Link href="/admin/doctors" className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold hover:bg-cream">
          ← الأطباء
        </Link>
      </div>

      <div className="salma-scroll mb-4 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/doctors/ratings?status=${t.key}`}
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
              status === t.key ? "bg-teal text-white" : "border border-line bg-white text-gray"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {ratings.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white p-6 text-[14px] text-gray">
          لا توجد تقييمات.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {ratings.map((r) => (
            <li key={r.id} className="rounded-2xl border border-line bg-white p-4">
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-bold">{r.author_name}</span>
                <span className="font-sans text-[11px] text-gray">{timeAgoAr(r.created_at)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[14px]">
                <span className="text-amber-500">{stars(r.stars)}</span>
                {r.doctor_slug ? (
                  <Link href={`/doctors/${r.doctor_slug}`} className="text-[12.5px] font-semibold text-teal underline">
                    {r.doctor_name ?? "طبيب"}
                  </Link>
                ) : (
                  <span className="text-[12.5px] text-gray">{r.doctor_name ?? "طبيب"}</span>
                )}
              </div>
              {r.body ? <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{r.body}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {status !== "approved" ? (
                  <form action={moderateRating}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="action" value="approve" />
                    <button className="rounded-lg bg-teal px-3.5 py-1.5 text-[12.5px] font-semibold text-white">اعتماد</button>
                  </form>
                ) : null}
                {status !== "rejected" ? (
                  <form action={moderateRating}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="action" value="reject" />
                    <button className="rounded-lg border border-line px-3.5 py-1.5 text-[12.5px] font-semibold">رفض</button>
                  </form>
                ) : null}
                <form action={moderateRating}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="action" value="delete" />
                  <button className="rounded-lg border border-line px-3.5 py-1.5 text-[12.5px] font-semibold text-coral">حذف</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
