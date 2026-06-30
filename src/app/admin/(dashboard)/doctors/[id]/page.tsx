import { notFound } from "next/navigation";
import { getDoctorForEdit, listDepartments } from "@/lib/admin-queries";
import { DoctorForm } from "../DoctorForm";

export const dynamic = "force-dynamic";

export default async function EditDoctor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [doctor, departments] = await Promise.all([getDoctorForEdit(id), listDepartments()]);
  if (!doctor) notFound();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">تحرير طبيب</h1>
      <DoctorForm doctor={doctor} departments={departments} />
    </div>
  );
}
