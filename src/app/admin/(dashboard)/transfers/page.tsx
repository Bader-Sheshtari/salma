import Link from "next/link";
import { listTransfers } from "@/lib/admin-queries";
import { softDeleteTransfer } from "../../actions";
import { timeAgoAr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TransfersList() {
  const transfers = await listTransfers();

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">انتقال الأطباء</h1>
        <Link href="/admin/transfers/new" className="rounded-lg bg-teal px-4 py-2.5 text-[13px] font-bold text-white">
          + إضافة
        </Link>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        {transfers.length === 0 ? (
          <div className="p-6 text-[14px] text-gray">لا توجد انتقالات بعد.</div>
        ) : (
          <ul className="divide-y divide-line">
            {transfers.map((t) => (
              <li key={t.id} className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-line bg-cream">
                    {t.doctor_photo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.doctor_photo_url} alt={t.doctor_name} className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-lg text-gray">🩺</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold">{t.doctor_name}</span>
                      {t.specialty ? (
                        <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10px] font-semibold text-teal">
                          {t.specialty}
                        </span>
                      ) : null}
                      {t.status !== "published" ? (
                        <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10px] font-semibold text-gray">
                          {t.status === "pending" ? "قيد المراجعة" : "مسودة"}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 font-sans text-[11px] text-gray">
                      {t.from_hospital ?? "—"} ← {t.to_hospital ?? "—"} · {timeAgoAr(t.updated_at)}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Link href={`/admin/transfers/${t.id}`} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-cream">
                    تحرير
                  </Link>
                  <form action={softDeleteTransfer}>
                    <input type="hidden" name="id" value={t.id} />
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
