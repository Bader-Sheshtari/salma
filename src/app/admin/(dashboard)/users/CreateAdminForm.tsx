"use client";

import { useActionState, useEffect, useRef } from "react";
import { createAdmin, type AdminUserResult } from "../../actions";
import { ROLE_LABEL } from "@/lib/roles";

const field =
  "w-full rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal";
const label = "block text-[12px] font-semibold text-gray";

/** `roles` = the actor's assignable set (server-computed; the action re-validates). */
export function CreateAdminForm({ roles }: { roles: string[] }) {
  const [state, action, pending] = useActionState<AdminUserResult, FormData>(createAdmin, null);
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the form (incl. the temp password) once the account is created.
  useEffect(() => {
    if (state && "ok" in state) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          الاسم (اختياري)
          <input name="full_name" className={`${field} mt-1`} />
        </label>
        <label className={label}>
          البريد الإلكتروني
          <input name="email" type="email" required dir="ltr" className={`${field} mt-1`} />
        </label>
        <label className={label}>
          كلمة مرور مؤقتة
          <input
            name="password"
            type="text"
            required
            minLength={8}
            dir="ltr"
            autoComplete="off"
            placeholder="8 أحرف على الأقل"
            className={`${field} mt-1`}
          />
        </label>
        <label className={label}>
          الدور
          <select
            name="role"
            defaultValue={roles.includes("editor") ? "editor" : roles[0]}
            className={`${field} mt-1`}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r] ?? r}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state && "error" in state ? (
        <div className="text-[12px] text-coral">{state.error}</div>
      ) : null}
      {state && "ok" in state ? <div className="text-[12px] text-teal">{state.ok}</div> : null}

      <button
        disabled={pending}
        className="self-start rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:opacity-60"
      >
        {pending ? "جارٍ الإنشاء…" : "إنشاء الحساب"}
      </button>
    </form>
  );
}
