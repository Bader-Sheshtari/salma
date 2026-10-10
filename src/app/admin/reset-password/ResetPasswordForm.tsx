"use client";

import { useActionState } from "react";
import { completeReset, type FlowResult } from "../user-actions";
import { passwordError } from "@/lib/passwords";
import { PasswordInput } from "../PasswordInput";
import { PasswordChecklist, usePasswordPair } from "../PasswordChecklist";

/** On success the server action redirects to /admin/login?reset=1. */
export function ResetPasswordForm({ token }: { token: string }) {
  const pw = usePasswordPair();
  const [state, formAction, pending] = useActionState<FlowResult, FormData>(async (_prev, fd) => {
    const password = fd.get("password");
    const confirm = fd.get("confirm");
    // Instant client hint; the server re-validates everything (incl. the email rule).
    const hint = passwordError(password, confirm);
    if (hint) return { error: hint };
    return completeReset(token, password, confirm);
  }, null);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <PasswordInput
          name="password"
          label="كلمة المرور الجديدة"
          autoComplete="new-password"
          value={pw.password}
          onChange={pw.setPassword}
          describedBy="rp-pw-rules"
        />
        <PasswordChecklist id="rp-pw-rules" password={pw.password} check={pw.check} matches={pw.matches} />
      </div>
      <PasswordInput
        name="confirm"
        label="تأكيد كلمة المرور"
        autoComplete="new-password"
        value={pw.confirm}
        onChange={pw.setConfirm}
        error={pw.mismatchError}
      />
      {state && "error" in state ? (
        <div role="alert" className="rounded-lg bg-coral/10 px-3 py-2 text-[12.5px] text-ink">
          {state.error}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={!pw.valid || pending}
        className="mt-1 rounded-lg bg-teal py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "جارٍ الحفظ…" : "حفظ كلمة المرور"}
      </button>
    </form>
  );
}
