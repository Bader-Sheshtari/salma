import { listDepartments } from "@/lib/admin-queries";
import { deleteDepartment } from "../../actions";
import { DepartmentForm } from "./DepartmentForm";

export const dynamic = "force-dynamic";

export default async function DepartmentsAdmin() {
  const departments = await listDepartments();

  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-2xl font-bold">الأقسام الطبية</h1>

      <DepartmentForm />

      <div className="mt-5 overflow-hidden rounded-2xl border border-line bg-white">
        {departments.length === 0 ? (
          <div className="p-6 text-[14px] text-gray">لا توجد أقسام بعد.</div>
        ) : (
          <ul className="divide-y divide-line">
            {departments.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 p-3.5">
                <DepartmentForm department={d} compact />
                <form action={deleteDepartment}>
                  <input type="hidden" name="id" value={d.id} />
                  <button className="rounded-lg border border-line px-3 py-2 text-[12.5px] font-semibold text-coral hover:bg-cream">
                    حذف
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
