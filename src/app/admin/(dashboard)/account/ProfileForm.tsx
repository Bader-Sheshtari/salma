"use client";

import { useActionState, useState } from "react";
import { updateOwnProfile, type FlowResult } from "../../user-actions";

const field =
  "mt-1 block w-full rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal";
const readOnlyBox =
  "mt-1 flex min-h-[38px] items-center rounded-lg border border-line bg-cream/50 px-3 py-2 text-sm text-ink";
const label = "block text-[12px] font-semibold text-gray";

const GENERIC_ERROR = "حدث خطأ — حاول مرة أخرى.";

export function ProfileForm({
  fullName,
  phone,
  email,
  role,
  status,
}: {
  fullName: string;
  phone: string;
  email: string;
  /** Pre-rendered role chip (read-only). */
  role: React.ReactNode;
  /** Pre-rendered status chip (read-only). */
  status: React.ReactNode;
}) {
  const [name, setName] = useState(fullName);
  const [tel, setTel] = useState(phone);
  const [state, action, pending] = useActionState<FlowResult, FormData>(async (_prev, fd) => {
    try {
      return await updateOwnProfile(fd.get("full_name"), fd.get("phone"));
    } catch {
      return { error: GENERIC_ERROR };
    }
  }, null);

  const nameLen = name.replace(/\s+/g, " ").trim().length;
  const nameOk = nameLen >= 2 && nameLen <= 80;
  const dirty = name !== fullName || tel !== phone;

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <div>
          <label htmlFor="pf-name" className={label}>
            الاسم
          </label>
          <input
            id="pf-name"
            name="full_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            autoComplete="name"
            aria-invalid={!nameOk ? true : undefined}
            className={field}
          />
          {!nameOk ? <p className="mt-1 text-[11.5px] text-coral">أدخل الاسم (حرفان على الأقل).</p> : null}
        </div>
        <div>
          <span className={label}>
            البريد الإلكتروني <span className="font-normal">(للعرض فقط)</span>
          </span>
          <div dir="ltr" className={`${readOnlyBox} justify-end font-sans break-all`}>
            {email || "—"}
          </div>
        </div>
        <div>
          <label htmlFor="pf-phone" className={label}>
            رقم الهاتف <span className="font-normal">(اختياري)</span>
          </label>
          <input
            id="pf-phone"
            name="phone"
            type="tel"
            value={tel}
            onChange={(e) => setTel(e.target.value)}
            dir="ltr"
            maxLength={30}
            autoComplete="tel"
            placeholder="+965 …"
            className={`${field} text-left`}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className={label}>الدور</span>
            <div className={readOnlyBox}>{role}</div>
          </div>
          <div>
            <span className={label}>الحالة</span>
            <div className={readOnlyBox}>{status}</div>
          </div>
        </div>
      </div>
      <p className="text-[11.5px] text-gray">
        البريد والدور والحالة يديرها المسؤول عن الحسابات ولا يمكن تعديلها من هنا.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={pending || !dirty || !nameOk}
          className="rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "جارٍ الحفظ…" : "حفظ التغييرات"}
        </button>
        {state && "error" in state ? (
          <span role="alert" className="text-[12px] text-coral">
            {state.error}
          </span>
        ) : null}
        {state && "ok" in state ? (
          <span role="status" className="text-[12px] text-teal">
            {state.ok}
          </span>
        ) : null}
      </div>
    </form>
  );
}
