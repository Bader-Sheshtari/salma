"use client";

import { useActionState, useState } from "react";
import { changeOwnPassword, type FlowResult } from "../../user-actions";
import { passwordError } from "@/lib/passwords";
import { PasswordInput } from "../../PasswordInput";
import { PasswordChecklist, usePasswordPair } from "../../PasswordChecklist";

const GENERIC_ERROR = "حدث خطأ — حاول مرة أخرى.";

export function OwnPasswordForm({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const pw = usePasswordPair(email);
  const [state, action, pending] = useActionState<FlowResult, FormData>(async (_prev, fd) => {
    const cur = fd.get("current");
    const next = fd.get("password");
    const confirm = fd.get("confirm");
    // Instant client hint; the server re-validates everything.
    const hint = passwordError(next, confirm, { email });
    if (hint) return { error: hint };
    let res: FlowResult;
    try {
      res = await changeOwnPassword(cur, next, confirm);
    } catch {
      return { error: GENERIC_ERROR };
    }
    // Clear every password field after a successful change.
    if (res && "ok" in res) {
      setCurrent("");
      pw.reset();
    }
    return res;
  }, null);

  const canSubmit = current.length > 0 && pw.valid && !pending;

  return (
    <form action={action} className="flex max-w-md flex-col gap-4" noValidate>
      <PasswordInput
        name="current"
        label="كلمة المرور الحالية"
        autoComplete="current-password"
        value={current}
        onChange={setCurrent}
      />
      <div className="flex flex-col gap-2">
        <PasswordInput
          name="password"
          label="كلمة المرور الجديدة"
          autoComplete="new-password"
          value={pw.password}
          onChange={pw.setPassword}
          describedBy="op-pw-rules"
        />
        <PasswordChecklist id="op-pw-rules" password={pw.password} check={pw.check} matches={pw.matches} />
      </div>
      <PasswordInput
        name="confirm"
        label="تأكيد كلمة المرور الجديدة"
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
      {state && "ok" in state ? (
        <div role="status" className="rounded-lg bg-teal/10 px-3 py-2 text-[12.5px] text-teal">
          {state.ok}
        </div>
      ) : null}
      <button
        disabled={!canSubmit}
        className="self-start rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "جارٍ التحديث…" : "تغيير كلمة المرور"}
      </button>
    </form>
  );
}
