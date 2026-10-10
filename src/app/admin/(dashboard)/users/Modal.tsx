"use client";

import { useEffect, useRef } from "react";

/** Small accessible dialog shell (same visual language as the content reject dialog). */
export function Modal({
  title,
  titleId,
  onClose,
  busy = false,
  children,
}: {
  title: string;
  titleId: string;
  onClose: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current
      ?.querySelector<HTMLElement>("input, select, textarea, button:not([aria-hidden])")
      ?.focus();
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => !busy && onClose()}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 text-right shadow-xl sm:rounded-2xl"
      >
        <h3 id={titleId} className="text-[16px] font-bold">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}
