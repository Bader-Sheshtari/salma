import { listDepartments } from "@/lib/admin-queries";
import { DoctorForm } from "../DoctorForm";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NewDoctor() {
  // Hard gate (defense in depth — the layout only admits staff).
  await requireAdmin();
  const departments = await listDepartments();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">إضافة طبيب</h1>
      <DoctorForm departments={departments} />
    </div>
  );
}
