import { getCategories } from "@/lib/queries";
import { ContentForm } from "../ContentForm";

export const dynamic = "force-dynamic";

export default async function NewContent() {
  const categories = await getCategories();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">إضافة محتوى</h1>
      <ContentForm categories={categories} />
    </div>
  );
}
