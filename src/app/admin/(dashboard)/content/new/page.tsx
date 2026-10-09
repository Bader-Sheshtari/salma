import { getCategories } from "@/lib/queries";
import Breadcrumbs from "../../Breadcrumbs";
import { ContentForm } from "../ContentForm";
import { requireStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NewContent() {
  // Content area: any staff role (editor and above).
  await requireStaff();
  const categories = await getCategories();
  return (
    <div>
      <Breadcrumbs items={[{ label: "المحتوى", href: "/admin/content" }, { label: "مادة جديدة" }]} />
      <h1 className="mb-5 text-2xl font-bold">إضافة محتوى</h1>
      <ContentForm categories={categories} />
    </div>
  );
}
