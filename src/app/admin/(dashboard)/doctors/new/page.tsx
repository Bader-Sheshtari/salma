import { listDepartments } from "@/lib/admin-queries";
import { DoctorForm } from "../DoctorForm";

export const dynamic = "force-dynamic";

export default async function NewDoctor() {
  const departments = await listDepartments();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">إضافة طبيب</h1>
      <DoctorForm departments={departments} />
    </div>
  );
}
