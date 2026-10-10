"use client";

import { useState } from "react";
import {
  PASSWORD_COMMON_MSG,
  PASSWORD_EMAIL_MSG,
  PASSWORD_MISMATCH,
  PASSWORD_RULES,
  validatePassword,
  type PasswordCheck,
} from "@/lib/passwords";

/**
 * State for a new-password + confirmation pair, derived from the shared
 * validator (display only — the server re-validates everything).
 */
export function usePasswordPair(email?: string | null) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const check = validatePassword(password, { email });
  const matches = confirm.length > 0 && confirm === password;
  // Flag a mismatch only once the confirmation has clearly diverged
  // (not while it is still a correct prefix being typed).
  const mismatch =
    confirm.length > 0 &&
    confirm !== password &&
    (confirm.length >= password.length || !password.startsWith(confirm));
  return {
    password,
    setPassword,
    confirm,
    setConfirm,
    check,
    matches,
    mismatchError: mismatch ? PASSWORD_MISMATCH : null,
    /** All rules pass and the confirmation matches. */
    valid: check.ok && matches,
    reset() {
      setPassword("");
      setConfirm("");
    },
  };
}

function Mark({ ok }: { ok: boolean }) {
  return ok ? (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" className="shrink-0">
      <circle cx="8" cy="8" r="7" fill="currentColor" opacity=".15" />
      <path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" className="shrink-0">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" opacity=".55" />
    </svg>
  );
}

/**
 * Live, understated rule list under a new-password field. Each rule turns
 * teal with a check as it is satisfied; an optional positive line confirms the
 * confirmation matches. Guessable passwords get one calm line once the
 * composition rules pass.
 */
export function PasswordChecklist({
  id,
  password,
  check,
  matches,
}: {
  id?: string;
  password: string;
  check: PasswordCheck;
  matches: boolean;
}) {
  const guessable =
    password.length > 0 &&
    PASSWORD_RULES.every((r) => !check.failures.includes(r.key)) &&
    (check.failures.includes("common") || check.failures.includes("email"));

  return (
    <div id={id} className="rounded-lg bg-cream/50 px-3 py-2.5">
      <p className="text-[12px] font-semibold text-gray">يجب أن تحتوي كلمة المرور على:</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {PASSWORD_RULES.map((r) => {
          const ok = !check.failures.includes(r.key);
          return (
            <li
              key={r.key}
              className={`flex items-center gap-1.5 text-[12px] transition-colors ${ok ? "text-teal" : "text-gray"}`}
            >
              <Mark ok={ok} />
              <span>{r.label}</span>
              <span className="sr-only">{ok ? "(مستوفى)" : "(غير مستوفى)"}</span>
            </li>
          );
        })}
        {matches ? (
          <li className="flex items-center gap-1.5 text-[12px] text-teal">
            <Mark ok />
            <span>كلمتا المرور متطابقتان</span>
          </li>
        ) : null}
      </ul>
      {guessable ? (
        <p role="alert" className="mt-1.5 text-[12px] text-coral">
          {check.failures.includes("common") ? PASSWORD_COMMON_MSG : PASSWORD_EMAIL_MSG}
        </p>
      ) : null}
    </div>
  );
}
