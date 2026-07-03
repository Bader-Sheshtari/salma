"use client";

import { useActionState } from "react";
import { deleteCategory, type SaveResult } from "../../actions";

export function DeleteCategoryForm({ slug }: { slug: string }) {
  const [state, formAction, pending] = useActionState<SaveResult, FormData>(deleteCategory, null);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={formAction}>
        <input type="hidden" name="slug" value={slug} />
        <button
          disabled={pending}
          className="rounded-lg border border-line px-3 py-2 text-[12.5px] font-semibold text-coral hover:bg-cream disabled:opacity-60"
        >
          {pending ? "…" : "حذف"}
        </button>
      </form>
      {state?.error ? (
        <span className="max-w-[16rem] text-[12px] text-coral">{state.error}</span>
      ) : null}
    </div>
  );
}
