"use client";

import { useActionState, useState } from "react";
import { acceptInvitation, type FlowResult } from "../user-actions";
import { passwordError } from "@/lib/passwords";
import { PasswordInput, authField, authLabel } from "../PasswordInput";
import { PasswordChecklist, usePasswordPair } from "../PasswordChecklist";

const NAME_MIN = 2;
const NAME_MAX = 80;

/** Client mirror of the server's phone rule (display only). */
function phoneLooksValid(raw: string): boolean {
  const v = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, " ")
    .trim();
  return !v || /^\+?[0-9][0-9 -]{5,22}$/.test(v);
}

/** On success the server action redirects to /admin/login?accepted=1. */
export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [touched, setTouched] = useState({ name: false, phone: false });
  const pw = usePasswordPair(email);

  const nameLen = fullName.replace(/\s+/g, " ").trim().length;
  const nameOk = nameLen >= NAME_MIN && nameLen <= NAME_MAX;
  const phoneOk = phoneLooksValid(phone);

  const [state, formAction, pending] = useActionState<FlowResult, FormData>(async (_prev, fd) => {
    const password = fd.get("password");
    const confirm = fd.get("confirm");
    // Instant client hint; the server re-validates everything.
    const hint = passwordError(password, confirm, { email });
    if (hint) return { error: hint };
    return acceptInvitation(token, fd.get("full_name"), fd.get("phone"), password, confirm);
  }, null);

  const canSubmit = nameOk && phoneOk && pw.valid && !pending;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <div>
        <label htmlFor="ai-name" className={authLabel}>
          الاسم الكامل
        </label>
        <input
          id="ai-name"
          name="full_name"
          required
          maxLength={NAME_MAX}
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          aria-invalid={touched.name && !nameOk ? true : undefined}
          aria-describedby={touched.name && !nameOk ? "ai-name-err" : undefined}
          className={authField}
        />
        {touched.name && !nameOk ? (
          <p id="ai-name-err" className="mt-1 text-[12px] text-coral">
            أدخل اسمك الكامل (حرفان على الأقل).
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="ai-phone" className={authLabel}>
          رقم الهاتف <span className="font-normal text-gray">(اختياري)</span>
        </label>
        <input
          id="ai-phone"
          name="phone"
          type="tel"
          dir="ltr"
          maxLength={30}
          autoComplete="tel"
          placeholder="+965 …"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
          aria-invalid={touched.phone && !phoneOk ? true : undefined}
          aria-describedby={touched.phone && !phoneOk ? "ai-phone-err" : undefined}
          className={`${authField} text-left`}
        />
        {touched.phone && !phoneOk ? (
          <p id="ai-phone-err" className="mt-1 text-[12px] text-coral">
            رقم الهاتف غير صالح.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <PasswordInput
          name="password"
          label="كلمة المرور الجديدة"
          autoComplete="new-password"
          value={pw.password}
          onChange={pw.setPassword}
          describedBy="ai-pw-rules"
        />
        <PasswordChecklist id="ai-pw-rules" password={pw.password} check={pw.check} matches={pw.matches} />
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
        disabled={!canSubmit}
        className="mt-1 rounded-lg bg-teal py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "جارٍ إنشاء الحساب…" : "إنشاء الحساب"}
      </button>
    </form>
  );
}
