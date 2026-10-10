"use client";

import { useActionState } from "react";
import { updateOwnProfile, type FlowResult } from "../../user-actions";

const field =
  "mt-1 block w-full rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal";
const label = "block text-[12px] font-semibold text-gray";

export function ProfileForm({ fullName, phone }: { fullName: string; phone: string }) {
  const [state, action, pending] = useActionState<FlowResult, FormData>(
    (_prev, fd) => updateOwnProfile(fd.get("full_name"), fd.get("phone")),
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          الاسم
          <input
            name="full_name"
            defaultValue={fullName}
            required
            minLength={2}
            maxLength={80}
            autoComplete="name"
            className={field}
          />
        </label>
        <label className={label}>
          رقم الهاتف (اختياري)
          <input
            name="phone"
            type="tel"
            defaultValue={phone}
            dir="ltr"
            maxLength={30}
            autoComplete="tel"
            className={`${field} text-left`}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={pending}
          className="rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:opacity-60"
        >
          {pending ? "جارٍ الحفظ…" : "حفظ"}
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
