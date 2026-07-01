"use client";

import { useActionState } from "react";
import { changeOwnPassword, type AdminUserResult } from "../../actions";

const field =
  "w-full rounded-lg border border-gray/40 px-3 py-2 text-sm outline-none focus:border-teal";

export function OwnPasswordForm() {
  const [state, action, pending] = useActionState<AdminUserResult, FormData>(
    changeOwnPassword,
    null,
  );

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="block text-[12px] font-semibold text-gray">
        كلمة المرور الجديدة
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={`${field} mt-1`}
        />
      </label>
      <button
        disabled={pending}
        className="rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:opacity-60"
      >
        {pending ? "…" : "تحديث"}
      </button>
      {state && "error" in state ? (
        <span className="text-[12px] text-coral">{state.error}</span>
      ) : null}
      {state && "ok" in state ? <span className="text-[12px] text-teal">{state.ok}</span> : null}
    </form>
  );
}
