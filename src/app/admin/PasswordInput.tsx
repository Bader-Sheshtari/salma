"use client";

import { useState } from "react";

export const authField =
  "mt-1.5 w-full rounded-lg border border-gray/40 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-teal";
export const authLabel = "block text-[13px] font-semibold text-ink";

/** Password input with a show/hide toggle (LTR value, RTL label). */
export function PasswordInput({
  name,
  label,
  autoComplete,
  hint,
  minLength,
}: {
  name: string;
  label: string;
  autoComplete: "new-password" | "current-password";
  hint?: string;
  minLength?: number;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className={authLabel}>
      {label}
      <span className="relative mt-1.5 block">
        <input
          name={name}
          type={show ? "text" : "password"}
          required
          minLength={minLength}
          maxLength={128}
          dir="ltr"
          autoComplete={autoComplete}
          className={`${authField} mt-0 pl-14`}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
          className="absolute inset-y-0 left-2 my-auto h-7 rounded px-2 font-sans text-[11px] font-semibold text-gray hover:bg-cream"
        >
          {show ? "إخفاء" : "إظهار"}
        </button>
      </span>
      {hint ? <span className="mt-1 block text-[11.5px] font-normal text-gray">{hint}</span> : null}
    </label>
  );
}
