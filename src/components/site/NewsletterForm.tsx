"use client";

import { useActionState } from "react";
import Link from "next/link";
import { subscribeNewsletter, type NewsletterResult } from "@/app/actions/newsletter";
import { AudienceSurvey } from "./AudienceSurvey";
import type { SignupSource } from "@/lib/newsletter";

/**
 * Public newsletter signup. The flow is strictly:
 * email → subscribe → success → OPTIONAL survey. The subscription is already
 * complete before the survey appears; skipping or ignoring it changes nothing.
 */
export function NewsletterForm({ source = "homepage" }: { source?: SignupSource }) {
  const [state, formAction, pending] = useActionState<NewsletterResult | null, FormData>(
    subscribeNewsletter,
    null,
  );

  if (state?.ok) {
    if (state.already) {
      return (
        <div className="mt-4 rounded-lg bg-white px-4 py-3 text-[13px] text-amethyst">
          أنت مشترك بالفعل في نشرة سلمى.
        </div>
      );
    }
    return (
      <div>
        <div className="mt-4 rounded-lg bg-white px-4 py-3 text-[13px] font-bold text-amethyst">
          تم اشتراكك بنجاح ✓
        </div>
        {state.surveyToken ? <AudienceSurvey token={state.surveyToken} /> : null}
      </div>
    );
  }

  return (
    <>
      <form action={formAction} className="mt-4 flex gap-2">
        <input type="hidden" name="source" value={source} />
        {/* Honeypot: invisible to humans, filled by naive bots. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="absolute -left-[9999px] h-0 w-0 opacity-0"
        />
        <input
          type="email"
          name="email"
          placeholder="بريدك الإلكتروني"
          aria-label="البريد الإلكتروني"
          dir="rtl"
          required
          className="min-h-12 min-w-0 flex-1 rounded-full border border-hairline-strong bg-white px-4 py-3 text-sm text-amethyst outline-none placeholder:text-amethyst-600 focus:border-amethyst focus-visible:outline-amethyst/40!"
        />
        <button
          type="submit"
          disabled={pending}
          className="min-h-12 shrink-0 rounded-full bg-amethyst px-6 py-3 text-sm font-bold text-white hover:bg-amethyst-800 disabled:opacity-60 focus-visible:outline-amethyst!"
        >
          {pending ? "…" : "اشترك"}
        </button>
      </form>
      {state && !state.ok ? (
        <div className="mt-2 text-[12.5px] text-coral">{state.error}</div>
      ) : null}
      {/* Phase 3: ≥13px below 768px and ≥4.5:1 (was gray/70 ≈3:1). */}
      <p className="mt-2 text-[13px] text-amethyst-600 md:text-[11px]">
        بتسجيل بريدك فإنك توافق على{" "}
        <Link href="/privacy" className="underline underline-offset-2 hover:text-amethyst">
          سياسة الخصوصية
        </Link>
      </p>
    </>
  );
}
