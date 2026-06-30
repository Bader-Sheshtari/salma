"use client";

import { useActionState } from "react";
import { saveDepartment, type SaveResult } from "../../actions";
import type { Department } from "@/lib/queries";

const field =
  "w-full rounded-lg border border-gray/40 px-3 py-2 text-sm outline-none focus:border-teal";

export function DepartmentForm({
  department,
  compact,
}: {
  department?: Department;
  compact?: boolean;
}) {
  const [state, formAction, pending] = useActionState<SaveResult, FormData>(saveDepartment, null);

  if (compact && department) {
    return (
      <form action={formAction} className="flex flex-1 flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={department.id} />
        <input name="name_ar" defaultValue={department.name_ar} required className={`${field} flex-1`} />
        <input
          name="sort_order"
          type="number"
          defaultValue={department.sort_order}
          className="w-20 rounded-lg border border-gray/40 px-2 py-2 text-sm outline-none focus:border-teal"
        />
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
      <div className="text-[13px] font-bold">إضافة قسم</div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <input name="name_ar" placeholder="اسم القسم (مثال: القلب)" required className={field} />
        <input name="sort_order" type="number" placeholder="الترتيب" className="w-28 rounded-lg border border-gray/40 px-3 py-2 text-sm outline-none focus:border-teal" />
        <button
          disabled={pending}
          className="rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:opacity-60"
        >
          {pending ? "جارٍ الحفظ…" : "إضافة"}
        </button>
      </div>
      {state?.error ? <div className="text-[13px] text-coral">{state.error}</div> : null}
    </form>
  );
}
