import { notFound } from "next/navigation";
import { getTransferForEdit, getTransferPrivate } from "@/lib/admin-queries";
import { requireAdmin, isManagerRole } from "@/lib/auth";
import { TransferForm } from "../TransferForm";

export const dynamic = "force-dynamic";

export default async function EditTransfer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAdmin();
  const canSeeSource = isManagerRole(actor.role);
  const [transfer, priv] = await Promise.all([
    getTransferForEdit(id),
    canSeeSource ? getTransferPrivate(id) : Promise.resolve({ ok: true, note: null } as const),
  ]);
  if (!transfer) notFound();

  const sourceLoadError = canSeeSource && !priv.ok;
  const internalSourceNote = priv.ok ? priv.note : null;

  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">تحرير انتقال</h1>
      <TransferForm
        transfer={transfer}
        canSeeSource={canSeeSource}
        internalSourceNote={internalSourceNote}
        sourceLoadError={sourceLoadError}
      />
    </div>
  );
}
