"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { isNeedsReauth, type NeedsReauth } from "@/lib/reauth-shared";
import { performReauth } from "../security-actions";
import { PasswordInput, authField, authLabel } from "../PasswordInput";
import { Modal } from "./users/Modal";

type Guarded = <T>(run: () => Promise<T | NeedsReauth>) => Promise<T | null>;

const ReauthContext = createContext<Guarded>(async (run) => {
  const res = await run();
  return isNeedsReauth(res) ? null : res;
});

/**
 * Run a sensitive server action under the re-auth protocol: if it answers
 * {needsReauth:true}, show «تأكيد الهوية», call performReauth, then retry the
 * original action ONCE. Resolves null when the user cancels; a second
 * consecutive needsReauth also resolves null but shows an error dialog.
 */
export function useReauth(): Guarded {
  return useContext(ReauthContext);
}

/** Hosts the re-auth modal for a page (users page, account security tab). */
export function ReauthProvider({ hasFactors, children }: { hasFactors: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setOpen(true);
      }),
    [],
  );

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const guarded = useCallback<Guarded>(
    async (run) => {
      const first = await run();
      if (!isNeedsReauth(first)) return first;
      if (!(await ask())) return null;
      const second = await run(); // exactly one automatic retry
      if (isNeedsReauth(second)) {
        // Re-auth succeeded but the action still refuses it (e.g. the session
        // marker was not seen) — say so instead of silently doing nothing.
        setFailed(true);
        return null;
      }
      return second;
    },
    [ask],
  );

  return (
    <ReauthContext.Provider value={guarded}>
      {children}
      {open ? <ReauthModal hasFactors={hasFactors} onDone={finish} /> : null}
      {failed ? (
        <Modal title="تعذّر تأكيد الهوية" titleId="reauth-failed-title" onClose={() => setFailed(false)} busy={false}>
          <div role="alert" className="mt-2 rounded-lg bg-coral/10 px-3 py-2 text-[12.5px] leading-6 text-ink">
            لم يُقبل تأكيد الهوية لهذه الجلسة، فلم يُنفَّذ الإجراء. أعد المحاولة، وإن تكرر ذلك فسجّل الخروج ثم الدخول من جديد.
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setFailed(false)}
              className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold hover:bg-cream"
            >
              إغلاق
            </button>
          </div>
        </Modal>
      ) : null}
    </ReauthContext.Provider>
  );
}

function ReauthModal({ hasFactors, onDone }: { hasFactors: boolean; onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const codeOk = !hasFactors || /^[0-9٠-٩]{6}$/.test(code);
  const canSubmit = password.length > 0 && codeOk && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const res = await performReauth(password, hasFactors ? code : undefined);
      if ("ok" in res) {
        setPassword("");
        setCode("");
        onDone(true);
        return;
      }
      setError(res.error);
      setCode("");
    } catch {
      setError("حدث خطأ — حاول مرة أخرى.");
    }
    setBusy(false);
  }

  return (
    <Modal title="تأكيد الهوية" titleId="reauth-title" onClose={() => onDone(false)} busy={busy}>
      <p className="mt-1 text-[12.5px] leading-6 text-gray">
        لأمان حسابات الفريق، أدخل كلمة المرور الحالية{hasFactors ? " ورمز المصادقة" : ""} للمتابعة.
      </p>
      <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-3.5">
        <PasswordInput
          name="reauth-password"
          label="كلمة المرور الحالية"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
        />
        {hasFactors ? (
          <div>
            <label htmlFor="reauth-code" className={authLabel}>
              رمز المصادقة
            </label>
            <input
              id="reauth-code"
              name="reauth-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              dir="ltr"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9٠-٩]/g, "").slice(0, 6))}
              className={`${authField} text-center font-mono tracking-[0.4em]`}
            />
            <p className="mt-1 text-[11.5px] text-gray">الرمز المكوّن من 6 أرقام في تطبيق المصادقة.</p>
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="rounded-lg bg-coral/10 px-3 py-2 text-[12.5px] text-ink">
            {error}
          </div>
        ) : null}
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDone(false)}
            className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold hover:bg-cream disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "جارٍ التحقق…" : "تأكيد"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
