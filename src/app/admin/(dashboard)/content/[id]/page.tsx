import { notFound } from "next/navigation";
import { getCategories } from "@/lib/queries";
import { getContentForEdit } from "@/lib/admin-queries";
import { ContentForm } from "../ContentForm";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function EditContent({ params }: Props) {
  const { id } = await params;
  const [categories, data] = await Promise.all([getCategories(), getContentForEdit(id)]);
  if (!data) notFound();

  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">تحرير المحتوى</h1>
      <ContentForm content={data.content} sources={data.sources} media={data.media} categories={categories} />
    </div>
  );
}
