import { notFound } from "next/navigation";
import { getTransferForEdit } from "@/lib/admin-queries";
import { TransferForm } from "../TransferForm";

export const dynamic = "force-dynamic";

export default async function EditTransfer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const transfer = await getTransferForEdit(id);
  if (!transfer) notFound();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">تحرير انتقال</h1>
      <TransferForm transfer={transfer} />
    </div>
  );
}
