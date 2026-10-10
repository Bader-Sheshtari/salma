"use client";

import { useActionState } from "react";
import { completeReset, type FlowResult } from "../user-actions";
import { PASSWORD_HINT, PASSWORD_MIN, passwordError } from "@/lib/passwords";
import { PasswordInput } from "../PasswordInput";

/** On success the server action redirects to /admin/login?reset=1. */
export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<FlowResult, FormData>(async (_prev, fd) => {
    const password = fd.get("password");
    const confirm = fd.get("confirm");
    // Instant client hint; the server re-validates everything (incl. the email rule).
    const hint = passwordError(password, confirm);
    if (hint) return { error: hint };
    return completeReset(token, password, confirm);
  }, null);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <PasswordInput
        name="password"
        label="كلمة المرور الجديدة"
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
        {pending ? "جارٍ الحفظ…" : "حفظ كلمة المرور"}
      </button>
    </form>
  );
}
