import { listDepartments } from "@/lib/admin-queries";
import { TransferForm } from "../TransferForm";

export const dynamic = "force-dynamic";

export default async function NewTransfer() {
  const departments = await listDepartments();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">إضافة انتقال</h1>
      <TransferForm departments={departments} />
    </div>
  );
}
