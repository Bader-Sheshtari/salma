"use client";

import { useActionState, useEffect, useRef } from "react";
import { changeOwnPassword, type FlowResult } from "../../user-actions";
import { PASSWORD_HINT, PASSWORD_MIN, passwordError } from "@/lib/passwords";
import { PasswordInput } from "../../PasswordInput";

export function OwnPasswordForm({ email }: { email: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<FlowResult, FormData>(async (_prev, fd) => {
    const current = fd.get("current");
    const next = fd.get("password");
    const confirm = fd.get("confirm");
    // Instant client hint; the server re-validates everything.
    const hint = passwordError(next, confirm, { email });
    if (hint) return { error: hint };
    return changeOwnPassword(current, next, confirm);
  }, null);

  // Clear every password field after a successful change.
  useEffect(() => {
    if (state && "ok" in state) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex max-w-md flex-col gap-3">
      <PasswordInput name="current" label="كلمة المرور الحالية" autoComplete="current-password" />
      <PasswordInput
        name="password"
        label="كلمة المرور الجديدة"
        autoComplete="new-password"
        minLength={PASSWORD_MIN}
        hint={PASSWORD_HINT}
      />
      <PasswordInput
        name="confirm"
        label="تأكيد كلمة المرور الجديدة"
        autoComplete="new-password"
        minLength={PASSWORD_MIN}
      />
      {state && "error" in state ? (
        <div role="alert" className="text-[12.5px] text-coral">
          {state.error}
        </div>
      ) : null}
      {state && "ok" in state ? (
        <div role="status" className="text-[12.5px] text-teal">
          {state.ok}
        </div>
      ) : null}
      <button
        disabled={pending}
        className="self-start rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:opacity-60"
      >
        {pending ? "جارٍ التحديث…" : "تغيير كلمة المرور"}
      </button>
    </form>
  );
}
