"use client";

import { useActionState } from "react";
import { acceptInvitation, type FlowResult } from "../user-actions";
import { PASSWORD_HINT, PASSWORD_MIN, passwordError } from "@/lib/passwords";
import { PasswordInput, authField, authLabel } from "../PasswordInput";

/** On success the server action redirects to /admin/login?accepted=1. */
export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const [state, formAction, pending] = useActionState<FlowResult, FormData>(async (_prev, fd) => {
    const password = fd.get("password");
    const confirm = fd.get("confirm");
    // Instant client hint; the server re-validates everything.
    const hint = passwordError(password, confirm, { email });
    if (hint) return { error: hint };
    return acceptInvitation(token, fd.get("full_name"), fd.get("phone"), password, confirm);
  }, null);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className={authLabel}>
        الاسم الكامل
        <input name="full_name" required minLength={2} maxLength={80} autoComplete="name" className={authField} />
      </label>
      <label className={authLabel}>
        رقم الهاتف <span className="font-normal text-gray">(اختياري)</span>
        <input
          name="phone"
          type="tel"
          dir="ltr"
          maxLength={30}
          autoComplete="tel"
          placeholder="+965 …"
          className={`${authField} text-left`}
        />
      </label>
      <PasswordInput
        name="password"
        label="كلمة المرور"
        autoComplete="new-password"
        minLength={PASSWORD_MIN}
        hint={PASSWORD_HINT}
      />
      <PasswordInput
        name="confirm"
        label="تأكيد كلمة المرور"
        autoComplete="new-password"
        minLength={PASSWORD_MIN}
      />
      {state && "error" in state ? (
        <div role="alert" className="text-[12.5px] text-coral">
          {state.error}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-lg bg-teal py-2.5 text-sm font-bold text-white disabled:opacity-60"
      >
        {pending ? "جارٍ التفعيل…" : "تفعيل الحساب"}
      </button>
    </form>
  );
}
