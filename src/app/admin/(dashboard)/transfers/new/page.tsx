import { requireAdmin, isManagerRole } from "@/lib/auth";
import { TransferForm } from "../TransferForm";

export const dynamic = "force-dynamic";

export default async function NewTransfer() {
  const actor = await requireAdmin();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">إضافة انتقال</h1>
      <TransferForm canSeeSource={isManagerRole(actor.role)} />
    </div>
  );
}
