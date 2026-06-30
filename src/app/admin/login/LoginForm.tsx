"use client";

import { useActionState } from "react";
import { login, type LoginResult } from "../auth-actions";

export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginResult, FormData>(login, null);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="text-[13px] font-semibold text-ink">
        البريد الإلكتروني
        <input
          name="email"
          type="email"
          required
          dir="ltr"
          autoComplete="username"
          className="mt-1.5 w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal"
        />
      </label>
      <label className="text-[13px] font-semibold text-ink">
        كلمة المرور
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1.5 w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal"
        />
      </label>
      {state?.error ? <div className="text-[12.5px] text-coral">{state.error}</div> : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-lg bg-teal py-2.5 text-sm font-bold text-white disabled:opacity-60"
      >
        {pending ? "جارٍ الدخول…" : "دخول"}
      </button>
    </form>
  );
}
