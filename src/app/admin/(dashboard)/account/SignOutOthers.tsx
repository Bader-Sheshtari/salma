"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signOutAllDevices } from "../../security-actions";
import { useReauth } from "../ReauthProvider";

const btn =
  "rounded-lg border border-line bg-white px-3.5 py-2 text-[12.5px] font-semibold hover:bg-cream disabled:opacity-50";

/** «تسجيل الخروج من جميع الأجهزة الأخرى» — confirm + re-auth gated; current session kept. */
export function SignOutOthers() {
  const router = useRouter();
  const guarded = useReauth();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, start] = useTransition();

  function run() {
    setError("");
    setNotice("");
    start(async () => {
      try {
        const res = await guarded(() => signOutAllDevices());
        if (!res) return;
        setConfirming(false);
        if ("error" in res) setError(res.error);
        else {
          setNotice(res.ok);
          router.refresh();
        }
      } catch {
        setError("حدث خطأ — حاول مرة أخرى.");
      }
    });
  }

  return (
    <div>
      <p className="text-[12.5px] leading-6 text-gray">
        يُنهي جلساتك على كل الأجهزة والمتصفحات الأخرى. تبقى هذه الجلسة مفتوحة.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={run}
              className="rounded-lg border border-coral/50 bg-white px-3.5 py-2 text-[12.5px] font-semibold text-ink hover:bg-coral/10 disabled:opacity-50"
            >
              {busy ? "جارٍ التنفيذ…" : "تأكيد تسجيل الخروج"}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={btn}>
              تراجع
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className={btn}>
            تسجيل الخروج من جميع الأجهزة الأخرى
          </button>
        )}
      </div>
      {error ? (
        <div role="alert" className="mt-2.5 rounded-lg bg-coral/10 px-3 py-2 text-[12.5px] text-ink">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="mt-2.5 rounded-lg bg-teal/10 px-3 py-2 text-[12.5px] text-teal">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
