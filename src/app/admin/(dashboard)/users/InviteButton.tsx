"use client";

import { useState, useTransition } from "react";
import { createInvitation } from "../../user-actions";
import { ROLE_LABEL } from "@/lib/roles";
import { Modal } from "./Modal";
import { useShowIssuedLink } from "./LinkModal";

const field =
  "mt-1 block w-full rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal";
const label = "block text-[12.5px] font-semibold text-gray";

/** «دعوة مستخدم» → dialog (email + role from the actor's assignable set) → one-time link modal. */
export function InviteButton({ roles }: { roles: string[] }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const setIssued = useShowIssuedLink();
  const [busy, start] = useTransition();

  if (!roles.length) return null;

  function submit(fd: FormData) {
    setError("");
    start(async () => {
      const res = await createInvitation(fd.get("email"), fd.get("role"));
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setIssued({ link: res.link, email: res.email, expiresAt: res.expiresAt, kind: res.kind });
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
        className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white"
      >
        دعوة مستخدم
      </button>

      {open ? (
        <Modal title="دعوة مستخدم" titleId="invite-title" onClose={() => setOpen(false)} busy={busy}>
          <p className="mt-1 text-[12.5px] leading-6 text-gray">
            يُنشأ رابط دعوة صالح 7 أيام. يختار المدعو اسمه وكلمة مروره بنفسه — لا تُرسل أي رسالة
            تلقائياً.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(new FormData(e.currentTarget));
            }}
            className="mt-3 flex flex-col gap-3"
          >
            <label className={label}>
              البريد الإلكتروني
              <input name="email" type="email" required dir="ltr" maxLength={254} className={field} />
            </label>
            <label className={label}>
              الدور
              <select
                name="role"
                defaultValue={roles.includes("editor") ? "editor" : roles[0]}
                className={field}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r] ?? r}
                  </option>
                ))}
              </select>
            </label>
            {error ? (
              <div role="alert" className="text-[12.5px] text-coral">
                {error}
              </div>
            ) : null}
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold hover:bg-cream disabled:opacity-50"
              >
                إلغاء
              </button>
              <button
                disabled={busy}
                className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {busy ? "جارٍ الإنشاء…" : "إنشاء رابط الدعوة"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

    </>
  );
}
