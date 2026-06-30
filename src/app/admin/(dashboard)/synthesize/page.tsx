import { SynthesizeForm } from "./SynthesizeForm";

export const dynamic = "force-dynamic";

export default function SynthesizePage() {
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">تحويل رابط إلى مقال</h1>
      <SynthesizeForm />
    </div>
  );
}
