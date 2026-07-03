"use client";

import { useActionState, useState } from "react";
import { saveCategory, type SaveResult } from "../../actions";
import { suggestSlug } from "@/lib/translit";
import type { Category } from "@/lib/queries";

const field =
  "w-full rounded-lg border border-gray/40 px-3 py-2 text-sm outline-none focus:border-teal";

export function CategoryForm({
  category,
  compact,
}: {
  category?: Category;
  compact?: boolean;
}) {
  const [state, formAction, pending] = useActionState<SaveResult, FormData>(saveCategory, null);

  // Live Latin-slug suggestion for the create form. `slugEdited` locks the
  // suggestion off once the admin types their own slug, so we never overwrite
  // a manual choice.
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const displayedSlug = slugEdited ? slug : suggestSlug(nameAr, nameEn);

  if (compact && category) {
    return (
      <form action={formAction} className="flex flex-1 flex-wrap items-center gap-2">
        <input type="hidden" name="original_slug" value={category.slug} />
        <input
          name="name_ar"
          defaultValue={category.name_ar}
          required
          className={`${field} min-w-[8rem] flex-1`}
        />
        <input
          name="name_en"
          defaultValue={category.name_en ?? ""}
          placeholder="EN"
          dir="ltr"
          className="w-28 rounded-lg border border-gray/40 px-2 py-2 text-sm outline-none focus:border-teal"
        />
        <input
          name="accent"
          type="color"
          defaultValue={category.accent}
          title="لون القسم"
          className="h-9 w-10 cursor-pointer rounded-lg border border-gray/40"
        />
        <input
          name="sort_order"
          type="number"
          defaultValue={category.sort_order}
          title="الترتيب"
          className="w-16 rounded-lg border border-gray/40 px-2 py-2 text-sm outline-none focus:border-teal"
        />
        <label className="flex items-center gap-1 text-[12px] text-gray">
          <input type="checkbox" name="show_in_nav" defaultChecked={category.show_in_nav} />
          في القائمة
        </label>
        <button
          disabled={pending}
          className="rounded-lg bg-teal px-3 py-2 text-[12.5px] font-semibold text-white disabled:opacity-60"
        >
          {pending ? "…" : "حفظ"}
        </button>
        {state?.error ? <span className="text-[12px] text-coral">{state.error}</span> : null}
      </form>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4">
      <div className="text-[13px] font-bold">إضافة قسم جديد</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          name="name_ar"
          value={nameAr}
          onChange={(e) => setNameAr(e.target.value)}
          placeholder="اسم القسم بالعربية (مثال: أخبار داوي)"
          required
          className={field}
        />
        <input
          name="name_en"
          value={nameEn}
          onChange={(e) => setNameEn(e.target.value)}
          placeholder="Name in English (optional)"
          dir="ltr"
          className={field}
        />
        <div className="flex flex-col gap-1 sm:col-span-2">
          <input
            name="slug"
            value={displayedSlug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
            placeholder="الرابط (اختياري، مثال: dawi-news)"
            dir="ltr"
            className={field}
          />
          <span className="text-[11px] text-gray">
            {slugEdited
              ? "سيُستخدم هذا الرابط في عنوان الصفحة."
              : "يُقترح تلقائياً بحروف لاتينية — يمكنك تعديله."}
          </span>
        </div>
        <input name="sort_order" type="number" placeholder="الترتيب" className={field} />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[13px]">
          اللون
          <input
            name="accent"
            type="color"
            defaultValue="#449785"
            className="h-9 w-12 cursor-pointer rounded-lg border border-gray/40"
          />
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" name="show_in_nav" defaultChecked />
          إظهار في القائمة العلوية
        </label>
        <button
          disabled={pending}
          className="ms-auto rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:opacity-60"
        >
          {pending ? "جارٍ الحفظ…" : "إضافة"}
        </button>
      </div>
      {state?.error ? <div className="text-[13px] text-coral">{state.error}</div> : null}
    </form>
  );
}
