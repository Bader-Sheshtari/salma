"use client";

import { createContext, useContext, useRef, useState } from "react";
import { formatStampAr } from "@/lib/format";
import { Modal } from "./Modal";

export type IssuedLink = {
  link: string;
  email: string;
  expiresAt: string;
  kind: "invite" | "reset";
  /** A replacement link for an existing invitation (title wording only). */
  reissued?: boolean;
};

export function issuedTitle(issued: IssuedLink): string {
  if (issued.kind === "reset") return "تم إنشاء رابط إعادة التعيين";
  return issued.reissued ? "تم إصدار رابط دعوة جديد" : "تم إنشاء الدعوة";
}

/**
 * Success content for a freshly issued one-time link — shared by the invite
 * dialog (swapped in place) and the reissue / reset-link modal. The plain token
 * is not stored anywhere (DB keeps only its hash): once closed it can't be
 * shown again; a new link must be issued instead.
 */
export function IssuedLinkBody({ issued, onDone }: { issued: IssuedLink; onDone: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const isInvite = issued.kind === "invite";

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied("ok");
    } catch {
      // Clipboard API unavailable (permissions / insecure context): select for manual copy.
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopied("fail");
    }
  }

  return (
    <div>
      <p className="mt-1 text-[13px] text-gray">
        {isInvite ? "دعوة إلى " : "للحساب "}
        <span dir="ltr" className="font-sans font-semibold text-ink">
          {issued.email}
        </span>
      </p>
      <p className="mt-0.5 text-[12.5px] text-gray">
        صالح حتى <span className="font-semibold text-ink">{formatStampAr(issued.expiresAt)}</span>
        {isInvite ? " (7 أيام)" : " (24 ساعة)"} · يُستخدم مرة واحدة.
      </p>

      <label htmlFor="issued-link-field" className="mt-4 block text-[12px] font-semibold text-gray">
        {isInvite ? "رابط الدعوة" : "رابط إعادة التعيين"}
      </label>
      <input
        id="issued-link-field"
        ref={inputRef}
        readOnly
        dir="ltr"
        value={issued.link}
        onFocus={(e) => e.currentTarget.select()}
        className="mt-1 block w-full rounded-lg border border-line bg-cream/50 px-3 py-2 font-sans text-[12px] text-ink outline-none focus:border-teal"
      />

      <button
        type="button"
        onClick={copy}
        data-autofocus
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-teal px-4 py-2.5 text-[13.5px] font-bold text-white hover:bg-teal/90"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
          <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 3V2.5A1 1 0 0 0 9.5 1.5h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1H4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        {copied === "ok" ? "تم النسخ ✓" : isInvite ? "نسخ رابط الدعوة" : "نسخ رابط إعادة التعيين"}
      </button>
      <p role="status" className="mt-1.5 min-h-[1em] text-center text-[12px] text-gray">
        {copied === "fail" ? "تعذّر النسخ تلقائياً — حدِّد الرابط وانسخه يدوياً." : ""}
      </p>

      <div className="mt-2 rounded-lg border border-gold bg-gold/25 px-3 py-2.5 text-[12.5px] leading-6">
        <p className="text-ink">
          {isInvite
            ? "أرسل هذا الرابط للمستخدم. سيقوم بإنشاء كلمة المرور الخاصة به بنفسه."
            : "أرسل هذا الرابط لصاحب الحساب. سيعيّن كلمة مرور جديدة بنفسه."}
        </p>
        <p className="font-bold text-ink">يظهر الرابط مرة واحدة فقط — انسخه الآن.</p>
      </div>
      <p className="mt-2 text-[11.5px] leading-5 text-gray">
        {isInvite
          ? "إن ضاع الرابط استخدم «إعادة إصدار الرابط» من القائمة — يُلغى الرابط القديم تلقائياً."
          : "إصدار رابط جديد يُلغي هذا الرابط. لا يُعيد تفعيل حساب موقوف."}
      </p>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold hover:bg-cream"
        >
          تم
        </button>
      </div>
    </div>
  );
}

/** Modal wrapper for links issued from a table row (reissue / reset link). */
export function LinkModal({ issued, onClose }: { issued: IssuedLink; onClose: () => void }) {
  return (
    <Modal title={issuedTitle(issued)} titleId="issued-link-title" onClose={onClose}>
      <IssuedLinkBody issued={issued} onDone={onClose} />
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
