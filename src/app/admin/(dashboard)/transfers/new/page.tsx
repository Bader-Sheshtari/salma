import { TransferForm } from "../TransferForm";

export const dynamic = "force-dynamic";

export default function NewTransfer() {
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">إضافة انتقال</h1>
      <TransferForm />
    </div>
  );
}
