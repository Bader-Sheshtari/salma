"use client";

import { createContext, useContext, useRef, useState } from "react";
import { formatStampAr } from "@/lib/format";
import { Modal } from "./Modal";

export type IssuedLink = {
  link: string;
  email: string;
  expiresAt: string;
  kind: "invite" | "reset";
};

/**
 * Shows a freshly issued one-time link. The plain token is not stored anywhere
 * (DB keeps only its hash) — once this modal closes it can't be shown again;
 * a new link must be issued instead.
 */
export function LinkModal({ issued, onClose }: { issued: IssuedLink; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const isInvite = issued.kind === "invite";

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied("ok");
    } catch {
      // Clipboard API unavailable (permissions / insecure context): select for manual copy.
      inputRef.current?.select();
      setCopied("fail");
    }
  }

  return (
    <Modal
      title={isInvite ? "رابط الدعوة جاهز" : "رابط إعادة تعيين كلمة المرور"}
      titleId="issued-link-title"
      onClose={onClose}
    >
      <p className="mt-1 text-[13px] text-gray">
        {isInvite ? "دعوة إلى " : "للحساب "}
        <span dir="ltr" className="font-sans font-semibold text-ink">
          {issued.email}
        </span>
      </p>

      <input
        ref={inputRef}
        readOnly
        dir="ltr"
        value={issued.link}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="الرابط"
        className="mt-3 block w-full rounded-lg border border-line bg-cream/50 px-3 py-2 font-sans text-[12px] text-ink outline-none focus:border-teal"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white"
        >
          {isInvite ? "نسخ رابط الدعوة" : "نسخ رابط إعادة التعيين"}
        </button>
        <span role="status" className="text-[12px]">
          {copied === "ok" ? <span className="text-teal">تم النسخ ✓</span> : null}
          {copied === "fail" ? <span className="text-gray">حدِّد الرابط وانسخه يدوياً.</span> : null}
        </span>
      </div>

      <ul className="mt-4 flex list-disc flex-col gap-1 pr-5 text-[12.5px] leading-6 text-gray">
        <li>
          صالح حتى <span className="font-semibold text-ink">{formatStampAr(issued.expiresAt)}</span>
          {isInvite ? " (7 أيام)" : " (24 ساعة)"}، ويُستخدم مرة واحدة.
        </li>
        <li className="font-semibold text-ink">
          أرسله عبر واتساب أو أي قناة؛ الرابط يظهر مرة واحدة فقط.
        </li>
        <li>
          {isInvite
            ? "إن ضاع الرابط استخدم «إعادة إصدار الرابط» من القائمة — يُلغى الرابط القديم تلقائياً."
            : "إصدار رابط جديد يُلغي هذا الرابط. لا يُعيد تفعيل حساب موقوف."}
        </li>
      </ul>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold hover:bg-cream"
        >
          تم
        </button>
      </div>
    </Modal>
  );
}

const IssuedLinkContext = createContext<(issued: IssuedLink) => void>(() => {});

/** Lets any row open the one-time link modal. */
export function useShowIssuedLink() {
  return useContext(IssuedLinkContext);
}

/**
 * Holds the one-time-link modal ABOVE the list: a reissue supersedes the old
 * invitation row (it disappears on revalidation), so the modal must not live
 * inside that row or the link would vanish before it's copied.
 */
export function IssuedLinkProvider({ children }: { children: React.ReactNode }) {
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  return (
    <IssuedLinkContext.Provider value={setIssued}>
      {children}
      {issued ? <LinkModal issued={issued} onClose={() => setIssued(null)} /> : null}
    </IssuedLinkContext.Provider>
  );
}
