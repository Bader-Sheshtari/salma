"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { logout } from "../auth-actions";
import { CodeInput } from "../MfaEnroll";

const CODE_ERROR = "الرمز غير صحيح أو انتهت صلاحيته.";

/**
 * Second login step for enrolled accounts: verify a TOTP code against the
 * session's verified factor (browser client — the session lives in cookies;
 * success upgrades it to aal2), then continue to `dest`. One generic error for
 * every failure (no factor / account details leak).
 */
export function MfaStep({ dest }: { dest: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError("");
    try {
      const supabase = createClient();
      const { data, error: listErr } = await supabase.auth.mfa.listFactors();
      const factors = data?.totp ?? [];
      let ok = false;
      if (!listErr) {
        for (const f of factors) {
          const { error: vErr } = await supabase.auth.mfa.challengeAndVerify({ factorId: f.id, code });
          if (!vErr) {
            ok = true;
            break;
          }
        }
      }
      if (ok) {
        router.replace(dest);
        router.refresh();
        return;
      }
    } catch {
      // fall through to the generic error
    }
    setError(CODE_ERROR);
    setCode("");
    setBusy(false);
  }

  return (
    <div>
      <h1 className="text-[16px] font-bold text-ink">التحقق بخطوتين</h1>
      <p className="mt-1 text-[13px] leading-6 text-gray">
        أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة لإكمال الدخول.
      </p>
      <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-3">
        <CodeInput id="mfa-login-code" value={code} onChange={setCode} autoFocus />
        {error ? (
          <div role="alert" className="text-[12.5px] text-coral">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="mt-1 rounded-lg bg-teal py-2.5 text-sm font-bold text-white disabled:opacity-60"
        >
          {busy ? "جارٍ التحقق…" : "تحقق"}
        </button>
      </form>
      <form action={logout} className="mt-4 text-center">
        <button className="text-[12.5px] font-semibold text-gray hover:text-ink hover:underline">
          تسجيل الخروج واستخدام حساب آخر
        </button>
      </form>
    </div>
  );
}
