import { SynthesizeForm } from "./SynthesizeForm";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SynthesizePage() {
  // Hard gate (defense in depth — the layout only admits staff).
  await requireAdmin();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">تحويل رابط إلى مقال</h1>
      <SynthesizeForm />
    </div>
  );
}
