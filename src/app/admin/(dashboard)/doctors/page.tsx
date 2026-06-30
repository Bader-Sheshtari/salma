import Link from "next/link";
import { listDoctors, listDepartments } from "@/lib/admin-queries";
import { softDeleteDoctor } from "../../actions";
import { timeAgoAr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DoctorsList() {
  const [doctors, departments] = await Promise.all([listDoctors(), listDepartments()]);
  const deptName = new Map(departments.map((d) => [d.id, d.name_ar]));

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">الأطباء</h1>
        <div className="flex gap-2">
          <Link href="/admin/doctors/ratings" className="rounded-lg border border-line px-4 py-2.5 text-[13px] font-semibold hover:bg-cream">
            التقييمات
          </Link>
          <Link href="/admin/doctors/new" className="rounded-lg bg-teal px-4 py-2.5 text-[13px] font-bold text-white">
            + إضافة
          </Link>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        {doctors.length === 0 ? (
          <div className="p-6 text-[14px] text-gray">لا يوجد أطباء بعد.</div>
        ) : (
          <ul className="divide-y divide-line">
            {doctors.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-semibold">{d.name_ar}</span>
                    <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10px] font-semibold text-teal">
                      {d.department_id ? deptName.get(d.department_id) ?? "—" : "—"}
                    </span>
                  </div>
                  <div className="mt-1 font-sans text-[11px] text-gray">
                    ★ {Number(d.rating_avg).toFixed(1)} ({d.rating_count}) · {d.hospital ?? "—"} · {timeAgoAr(d.updated_at)}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Link href={`/admin/doctors/${d.id}`} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-cream">
                    تحرير
                  </Link>
                  <form action={softDeleteDoctor}>
                    <input type="hidden" name="id" value={d.id} />
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
