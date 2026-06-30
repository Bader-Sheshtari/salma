"use client";

import { useState } from "react";

export function ShareBar({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);

  function url() {
    return typeof window !== "undefined" ? window.location.href : "";
  }

  const whatsapp = () => {
    const text = encodeURIComponent(`${title}\n${url()}`);
    window.open(`https://wa.me/?text=${text}`, "_blank", "noopener");
  };

  const email = () => {
    const subject = encodeURIComponent(title);
    const body = encodeURIComponent(`${title}\n${url()}`);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  const native = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title, url: url() });
      } catch {
        /* user cancelled */
      }
    } else {
      copy();
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  const btn =
    "flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[13px] font-semibold transition hover:bg-cream";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-semibold text-gray">مشاركة:</span>
      <button onClick={whatsapp} className={`${btn} text-green`} type="button">
        واتساب
      </button>
      <button onClick={email} className={`${btn} text-teal`} type="button">
        بريد
      </button>
      <button onClick={native} className={btn} type="button">
        مشاركة
      </button>
      <button onClick={copy} className={btn} type="button">
        {copied ? "✓ نُسخ" : "نسخ الرابط"}
      </button>
    </div>
  );
}
