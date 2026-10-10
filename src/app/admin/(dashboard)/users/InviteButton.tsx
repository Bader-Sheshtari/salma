"use client";

import { useState, useTransition } from "react";
import { createInvitation } from "../../user-actions";
import { ROLE_LABEL } from "@/lib/roles";
import { Modal } from "./Modal";
import { IssuedLinkBody, issuedTitle, type IssuedLink } from "./LinkModal";
import { useReauth } from "../ReauthProvider";

const field =
  "mt-1 block w-full rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal aria-[invalid=true]:border-coral";
const label = "block text-[12.5px] font-semibold text-ink";

/** Client mirror of the server's email rule (display only — the server re-validates). */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GENERIC_ERROR = "حدث خطأ — حاول مرة أخرى.";

/**
 * «دعوة مستخدم» → dialog (email + role from the actor's assignable set). On
 * success the same dialog swaps to the one-time link (shown once only).
 */
export function InviteButton({ roles }: { roles: string[] }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [touched, setTouched] = useState({ email: false, role: false });
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const [busy, start] = useTransition();
  const guarded = useReauth();

  if (!roles.length) return null;

  const emailTrim = email.trim();
  const emailOk = EMAIL_RE.test(emailTrim) && emailTrim.length <= 254;
  const roleOk = roles.includes(role);
  const emailError = touched.email && emailTrim && !emailOk ? "صيغة البريد الإلكتروني غير صحيحة." : "";
  const emailMissing = touched.email && !emailTrim ? "أدخل البريد الإلكتروني." : "";
  const roleError = touched.role && !roleOk ? "اختر الدور." : "";

  function openDialog() {
    setEmail("");
    setRole("");
    setTouched({ email: false, role: false });
    setError("");
    setIssued(null);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setIssued(null);
  }

  function submit() {
    setTouched({ email: true, role: true });
    if (!emailOk || !roleOk) return;
    setError("");
    start(async () => {
      try {
        const res = await guarded(() => createInvitation(emailTrim, role));
        if (!res) return;
        if ("error" in res) {
          setError(res.error);
          return;
        }
        setIssued({ link: res.link, email: res.email, expiresAt: res.expiresAt, kind: res.kind });
      } catch {
        setError(GENERIC_ERROR);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white hover:bg-teal/90"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        دعوة مستخدم
      </button>

      {open ? (
        <Modal
          // Remount the shell when swapping to the success state (moves focus to «نسخ»).
          key={issued ? "issued" : "form"}
          title={issued ? issuedTitle(issued) : "دعوة مستخدم"}
          titleId="invite-title"
          onClose={close}
          busy={busy}
        >
          {issued ? (
            <IssuedLinkBody issued={issued} onDone={close} />
          ) : (
            <>
              <p className="mt-1 text-[12.5px] leading-6 text-gray">
                يُنشأ رابط دعوة صالح 7 أيام. يختار المدعو اسمه وكلمة مروره بنفسه — لا تُرسل أي رسالة
                تلقائياً.
              </p>
              <form
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                className="mt-4 flex flex-col gap-3.5"
              >
                <div>
                  <label htmlFor="invite-email" className={label}>
                    البريد الإلكتروني
                  </label>
                  <input
                    id="invite-email"
                    name="email"
                    type="email"
                    required
                    dir="ltr"
                    maxLength={254}
                    autoComplete="off"
                    placeholder="name@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                    aria-invalid={emailError || emailMissing ? true : undefined}
                    aria-describedby={emailError || emailMissing ? "invite-email-err" : undefined}
                    className={`${field} text-left`}
                  />
                  {emailError || emailMissing ? (
                    <p id="invite-email-err" className="mt-1 text-[12px] text-coral">
                      {emailError || emailMissing}
                    </p>
                  ) : null}
                </div>
                <div>
                  <label htmlFor="invite-role" className={label}>
                    الدور
                  </label>
                  <select
                    id="invite-role"
                    name="role"
                    required
                    value={role}
                    onChange={(e) => {
                      setRole(e.target.value);
                      setTouched((t) => ({ ...t, role: true }));
                    }}
                    onBlur={() => setTouched((t) => ({ ...t, role: true }))}
                    aria-invalid={roleError ? true : undefined}
                    aria-describedby={roleError ? "invite-role-err" : undefined}
                    className={field}
                  >
                    <option value="" disabled>
                      اختر الدور
                    </option>
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r] ?? r}
                      </option>
                    ))}
                  </select>
                  {roleError ? (
                    <p id="invite-role-err" className="mt-1 text-[12px] text-coral">
                      {roleError}
                    </p>
                  ) : null}
                </div>
                {error ? (
                  <div role="alert" className="rounded-lg bg-coral/10 px-3 py-2 text-[12.5px] text-ink">
                    {error}
                  </div>
                ) : null}
                <div className="mt-1 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={close}
                    className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold hover:bg-cream disabled:opacity-50"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !emailOk || !roleOk}
                    className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? "جارٍ الإنشاء…" : "إنشاء رابط الدعوة"}
                  </button>
                </div>
              </form>
            </>
          )}
        </Modal>
      ) : null}
    </>
  );
}
