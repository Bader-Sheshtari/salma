"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatStampAr } from "@/lib/format";
import { disableOwnMfa } from "../../security-actions";
import { MFA_INTRO, MfaEnroll } from "../../MfaEnroll";
import { useReauth } from "../ReauthProvider";

const btn =
  "rounded-lg border border-line bg-white px-3.5 py-2 text-[12.5px] font-semibold hover:bg-cream disabled:opacity-50";

/** «الأمان» tab: MFA status + enable (inline enrollment) / disable (re-auth gated). */
export function MfaCard({ enabled, mandatory }: { enabled: boolean; mandatory: boolean }) {
  const router = useRouter();
  const guarded = useReauth();
  const [enrolling, setEnrolling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, start] = useTransition();
  // Verified factors (read from GoTrue) — so an unexpected second factor is visible.
  const [factors, setFactors] = useState<{ id: string; name: string; createdAt: string }[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    createClient()
      .auth.mfa.listFactors()
      .then(({ data, error: listErr }) => {
        if (!alive || listErr || !data) return;
        setFactors(
          (data.all ?? [])
            .filter((f) => f.status === "verified")
            .map((f) => ({ id: f.id, name: f.friendly_name?.trim() || f.factor_type, createdAt: f.created_at })),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled]);

  function disable() {
    setError("");
    setNotice("");
    start(async () => {
      try {
        const res = await guarded(() => disableOwnMfa());
        if (!res) return;
        if ("error" in res) {
          setError(res.error);
          return;
        }
        setConfirming(false);
        if (res.mandatory) {
          // R2 would force this anyway on the next request — go there directly.
          router.push("/admin/mfa-setup?re=1");
          return;
        }
        setNotice(res.ok);
        router.refresh();
      } catch {
        setError("حدث خطأ — حاول مرة أخرى.");
      }
    });
  }

  return (
    <section aria-labelledby="sec-mfa" className="rounded-2xl border border-line bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sec-mfa" className="text-[15px] font-bold">
          المصادقة الثنائية
        </h2>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-sans text-[11px] font-semibold ${
            enabled ? "bg-green/15 text-teal" : "bg-sand/70 text-gray"
          }`}
        >
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-green" : "bg-gray/60"}`} />
          {enabled ? "مفعّلة" : "غير مفعّلة"}
        </span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-6 text-gray">{MFA_INTRO}</p>
      {mandatory ? (
        <p className="mt-1 text-[12px] font-semibold text-ink">إلزامية لدورك.</p>
      ) : null}
      {enabled && factors && factors.length ? (
        <div className="mt-3 rounded-xl border border-line bg-cream/40 px-3.5 py-2.5">
          <div className="text-[12px] font-semibold text-ink">
            {factors.length === 1 ? "عامل مصادقة واحد مسجّل" : `عوامل المصادقة المسجّلة: ${factors.length}`}
          </div>
          <ul className="mt-1 flex flex-col gap-0.5 text-[12px] leading-6 text-gray">
            {factors.map((f) => (
              <li key={f.id}>
                <span dir="auto" className="font-semibold text-ink">
                  {f.name}
                </span>{" "}
                — أُضيف في {formatStampAr(f.createdAt, false)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4">
        {enabled ? (
          confirming ? (
            <div className="flex flex-col gap-2.5 rounded-xl border border-coral/40 bg-coral/5 p-3.5">
              <p className="text-[12.5px] leading-6 text-ink">
                سيُطلب منك تأكيد الهوية (كلمة المرور الحالية ورمز المصادقة) ثم تُلغى المصادقة الثنائية.
              </p>
              {mandatory ? (
                <p className="text-[12.5px] font-bold leading-6 text-ink">
                  بصفتك مالكًا/مشرفًا عامًا ستتم إعادتك فورًا لإعداد مصادقة جديدة.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={disable}
                  className="rounded-lg border border-coral/50 bg-white px-3.5 py-2 text-[12.5px] font-semibold text-ink hover:bg-coral/10 disabled:opacity-50"
                >
                  {busy ? "جارٍ التنفيذ…" : "تأكيد إلغاء التفعيل"}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={btn}>
                  تراجع
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className={btn}>
              إلغاء التفعيل
            </button>
          )
        ) : enrolling ? (
          <div className="max-w-sm">
            <MfaEnroll continueLabel="تم" onDone={() => setEnrolling(false)} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEnrolling(true)}
            className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white hover:bg-teal/90"
          >
            تفعيل
          </button>
        )}
      </div>

      {error ? (
        <div role="alert" className="mt-3 rounded-lg bg-coral/10 px-3 py-2 text-[12.5px] text-ink">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="mt-3 rounded-lg bg-teal/10 px-3 py-2 text-[12.5px] text-teal">
          {notice}
        </div>
      ) : null}
    </section>
  );
}
