"use client";

import { useActionState } from "react";
import Link from "next/link";
import { subscribeNewsletter, type NewsletterResult } from "@/app/actions/newsletter";

export function NewsletterForm() {
  const [state, formAction, pending] = useActionState<NewsletterResult | null, FormData>(
    subscribeNewsletter,
    null,
  );

  if (state?.ok) {
    return (
      <div className="mt-4 rounded-lg bg-cream px-4 py-3 text-[13px] text-teal">
        تم تسجيل بريدك بنجاح.
      </div>
    );
  }

  return (
    <>
      <form action={formAction} className="mt-4 flex gap-2">
        <input
          type="email"
          name="email"
          placeholder="بريدك الإلكتروني"
          dir="rtl"
          required
          className="flex-1 rounded-lg border border-gray/40 bg-white px-3.5 py-3 text-sm outline-none focus:border-teal"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-teal px-5 py-3 text-sm font-bold text-white disabled:opacity-60"
        >
          {pending ? "…" : "اشترك"}
        </button>
      </form>
      {state && !state.ok ? (
        <div className="mt-2 text-[12.5px] text-coral">{state.error}</div>
      ) : null}
      <p className="mt-2 text-[11px] text-gray/70">
        بتسجيل بريدك فإنك توافق على{" "}
        <Link href="/privacy" className="underline underline-offset-2 hover:text-gray">
          سياسة الخصوصية
        </Link>
      </p>
    </>
  );
}
