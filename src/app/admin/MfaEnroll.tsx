"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { recordMfaEnabled } from "./security-actions";
import { authField } from "./PasswordInput";

/** Arabic-Indic → Latin digits, digits only, max 6. */
function toCode(v: string): string {
  return v
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, "")
    .slice(0, 6);
}

/** 6-digit TOTP field (LTR, numeric keyboard, OTP autofill). */
export function CodeInput({
  id,
  value,
  onChange,
  autoFocus = false,
  label = "رمز المصادقة",
}: {
  id: string;
  value: string;
  onChange: (code: string) => void;
  autoFocus?: boolean;
  label?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        maxLength={12}
        placeholder="000000"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(toCode(e.target.value))}
        className={`${authField} text-center font-mono text-lg tracking-[0.4em]`}
      />
    </div>
  );
}

/** Wording per owner (U3 spec A). */
export const MFA_INTRO =
  "المصادقة الثنائية — تضيف طبقة حماية إضافية لحسابك باستخدام تطبيق مصادقة مثل Google Authenticator أو Microsoft Authenticator أو 1Password.";

const CODE_ERROR = "الرمز غير صحيح أو انتهت صلاحيته.";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; factorId: string; qr: string; secret: string }
  | { kind: "done" };

/** GoTrue returns `data:image/svg+xml;utf-8,<svg…>` unencoded — re-encode safely. */
function qrSrc(raw: string): string {
  const prefix = "data:image/svg+xml;utf-8,";
  return raw.startsWith(prefix)
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw.slice(prefix.length))}`
    : raw;
}

function enrollErrorMessage(code: string | undefined): string {
  // Enrollment refused by project config (TOTP enroll/verify disabled).
  if (code === "mfa_totp_enroll_not_enabled" || code === "mfa_totp_verify_not_enabled") {
    return "تعذّر بدء التفعيل — تحقق من تفعيل TOTP في لوحة Supabase: Authentication ← MFA.";
  }
  if (code === "insufficient_aal") return "أكمل التحقق بالرمز الحالي أولًا ثم أعد المحاولة.";
  if (code === "too_many_enrolled_mfa_factors") return "بلغ الحساب الحد الأقصى لعوامل المصادقة.";
  return "تعذّر بدء إعداد المصادقة الثنائية — حدّث الصفحة وأعد المحاولة.";
}

/**
 * TOTP enrollment (shared by /admin/mfa-setup and the account security tab).
 * Runs in the browser against GoTrue with the cookie session: clears stale
 * UNVERIFIED totp factors, enrolls a new one, shows QR + manual secret, then
 * challenge + verify (session becomes aal2) and audits via a server action.
 * The secret is never sent to our server, logged, or stored.
 */
export function MfaEnroll({
  reconfigured = false,
  continueHref,
  continueLabel = "متابعة",
  onDone,
}: {
  reconfigured?: boolean;
  /** After success: navigate here (setup page). */
  continueHref?: string;
  continueLabel?: string;
  /** After success: callback instead of navigation (inline use). */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  async function start() {
    const supabase = createClient();
    try {
      const { data: list, error: listErr } = await supabase.auth.mfa.listFactors();
      if (listErr) throw listErr;
      // Stale, never-verified enrollments (abandoned attempts) → remove first.
      for (const f of list?.all ?? []) {
        if (f.factor_type === "totp" && f.status === "unverified") {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }
      let res = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Salma Admin", issuer: "Salma" });
      if (res.error?.code === "mfa_factor_name_conflict") {
        res = await supabase.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: `Salma Admin ${Date.now().toString(36)}`,
          issuer: "Salma",
        });
      }
      if (res.error || !res.data) {
        setPhase({ kind: "error", message: enrollErrorMessage(res.error?.code) });
        return;
      }
      setPhase({
        kind: "ready",
        factorId: res.data.id,
        qr: qrSrc(res.data.totp.qr_code),
        secret: res.data.totp.secret,
      });
    } catch (e) {
      setPhase({ kind: "error", message: enrollErrorMessage((e as { code?: string } | null)?.code) });
    }
  }

  useEffect(() => {
    if (started.current) return; // StrictMode double-mount: enroll once
    started.current = true;
    void start();
  }, []);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (phase.kind !== "ready" || code.length !== 6 || busy) return;
    setBusy(true);
    setError("");
    const supabase = createClient();
    try {
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: phase.factorId });
      if (chErr || !ch) throw chErr ?? new Error("challenge");
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId: phase.factorId,
        challengeId: ch.id,
        code,
      });
      if (vErr) throw vErr;
    } catch {
      setError(CODE_ERROR);
      setCode("");
      setBusy(false);
      return;
    }
    // Session is aal2 now. Audit (best-effort; never blocks success).
    try {
      await recordMfaEnabled(reconfigured);
    } catch {
      /* audit failure is logged server-side */
    }
    setCode("");
    setBusy(false);
    setPhase({ kind: "done" }); // drops the secret from memory
  }

  async function copySecret() {
    if (phase.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(phase.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function finish() {
    if (continueHref) {
      router.replace(continueHref);
      router.refresh();
    } else {
      onDone?.();
      router.refresh();
    }
  }

  if (phase.kind === "loading") {
    return <p className="py-6 text-center text-[13px] text-gray">جارٍ تجهيز رمز الإعداد…</p>;
  }

  if (phase.kind === "error") {
    return (
      <div role="alert" className="rounded-lg bg-coral/10 px-3 py-2.5 text-[12.5px] leading-6 text-ink">
        {phase.message}
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="flex flex-col gap-3">
        <div role="status" className="rounded-xl border border-teal/30 bg-teal/10 p-4">
          <div className="text-[14px] font-bold text-teal">المصادقة الثنائية مفعّلة</div>
          <p className="mt-1 text-[12.5px] leading-6 text-gray">
            سيُطلب منك رمز من تطبيق المصادقة عند كل تسجيل دخول.
          </p>
        </div>
        <button
          type="button"
          onClick={finish}
          className="rounded-lg bg-teal py-2.5 text-sm font-bold text-white"
        >
          {continueLabel}
        </button>
      </div>
    );
  }

  const grouped = phase.secret.replace(/(.{4})/g, "$1 ").trim();

  return (
    <div className="flex flex-col gap-4">
      <ol className="list-decimal pr-5 text-[12.5px] leading-6 text-gray">
        <li>افتح تطبيق المصادقة وامسح رمز QR التالي.</li>
        <li>أو أدخل المفتاح يدويًا إن تعذّر المسح.</li>
        <li>أدخل الرمز المكوّن من 6 أرقام الذي يظهر في التطبيق.</li>
      </ol>
      <div className="flex justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG data URL from GoTrue */}
        <img
          src={phase.qr}
          alt="رمز QR لإضافة حساب سلمى إلى تطبيق المصادقة"
          width={184}
          height={184}
          className="rounded-lg border border-line bg-white p-2"
        />
      </div>
      <div>
        <div className="text-[12px] font-semibold text-gray">المفتاح اليدوي</div>
        <div className="mt-1 flex items-stretch gap-2">
          <code
            dir="ltr"
            className="flex-1 select-all break-all rounded-lg border border-line bg-cream/50 px-3 py-2 font-mono text-[12.5px] text-ink"
          >
            {grouped}
          </code>
          <button
            type="button"
            onClick={copySecret}
            className="shrink-0 rounded-lg border border-line bg-white px-3 text-[12px] font-semibold hover:bg-cream"
          >
            {copied ? "تم النسخ ✓" : "نسخ"}
          </button>
        </div>
        <p className="mt-1.5 text-[11.5px] leading-5 text-gray">
          احفظ مفتاح الإعداد اليدوي في مدير كلمات المرور كنسخة احتياطية لاستعادة الوصول.
        </p>
      </div>
      <form onSubmit={verify} noValidate className="flex flex-col gap-3">
        <CodeInput id="mfa-enroll-code" value={code} onChange={setCode} />
        {error ? (
          <div role="alert" className="text-[12.5px] text-coral">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="rounded-lg bg-teal py-2.5 text-sm font-bold text-white disabled:opacity-60"
        >
          {busy ? "جارٍ التحقق…" : "تفعيل المصادقة الثنائية"}
        </button>
      </form>
    </div>
  );
}
