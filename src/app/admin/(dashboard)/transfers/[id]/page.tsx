import { notFound } from "next/navigation";
import { getTransferForEdit, listDepartments } from "@/lib/admin-queries";
import { TransferForm } from "../TransferForm";

export const dynamic = "force-dynamic";

export default async function EditTransfer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [transfer, departments] = await Promise.all([getTransferForEdit(id), listDepartments()]);
  if (!transfer) notFound();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">تحرير انتقال</h1>
      <TransferForm transfer={transfer} departments={departments} />
    </div>
  );
}
