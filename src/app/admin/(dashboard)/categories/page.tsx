import { listCategories } from "@/lib/admin-queries";
import { CategoryForm } from "./CategoryForm";
import { DeleteCategoryForm } from "./DeleteCategoryForm";

export const dynamic = "force-dynamic";

export default async function CategoriesAdmin() {
  const categories = await listCategories();

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">الأقسام والصفحات</h1>
      <p className="mb-4 text-[13px] text-gray">
        كل قسم يظهر كصفحة وكسطر في القائمة العلوية. عند إضافة قسم جديد يُنشأ له قسمٌ في
        الصفحة الرئيسية (معطّل) يمكنك تفعيله وترتيبه من صفحة «الصفحة الرئيسية». لا يمكن حذف
        قسم يحتوي على مقالات.
      </p>

      <CategoryForm />

      <div className="mt-5 overflow-hidden rounded-2xl border border-line bg-white">
        {categories.length === 0 ? (
          <div className="p-6 text-[14px] text-gray">لا توجد أقسام بعد.</div>
        ) : (
          <ul className="divide-y divide-line">
            {categories.map((c) => (
              <li key={c.slug} className="flex flex-wrap items-center gap-2 p-3.5">
                <CategoryForm category={c} compact />
                <DeleteCategoryForm slug={c.slug} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
