"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { rejectContent } from "../../actions";
import { REJECT_DIALOG_ORDER, REJECT_REASONS } from "@/lib/editorial-feedback";

const REJECT_CHOICES = [
  ...REJECT_DIALOG_ORDER.map((code) => REJECT_REASONS.find((r) => r.code === code)!).filter(Boolean),
  ...REJECT_REASONS.filter((r) => !REJECT_DIALOG_ORDER.includes(r.code) && r.code !== "other"),
  ...REJECT_REASONS.filter((r) => r.code === "other"),
];

/**
 * «رفض» → small dialog: optional structured reason (the existing taxonomy) +
 * optional free-text note. Rejecting without a reason stays possible. The
 * reason feeds the observational editorial-feedback loop — it never changes
 * ranking or selection.
 */
export default function RejectButton({
  id,
  title,
  onDone,
}: {
  id: string;
  title: string;
  /** Optional extra callback; the route is always refreshed after rejecting. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, startReject] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstRadioRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) firstRadioRef.current?.focus();
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  function submit() {
    startReject(async () => {
      const fd = new FormData();
      fd.set("id", id);
      if (reason) fd.set("reason", reason);
      if (note.trim()) fd.set("note", note.trim());
      await rejectContent(fd);
      setOpen(false);
      router.refresh();
      onDone?.();
    });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={busy}
        onClick={() => {
          setReason("");
          setNote("");
          setOpen(true);
        }}
        className="rounded-lg border border-coral/50 px-3 py-1.5 text-[12.5px] font-semibold text-coral hover:bg-cream disabled:opacity-50"
      >
        رفض
      </button>
      {open ? (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4">
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => !busy && setOpen(false)}
            className="absolute inset-0 cursor-default"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`reject-title-${id}`}
            className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
          >
            <h3 id={`reject-title-${id}`} className="text-[16px] font-bold">
              رفض المادة
            </h3>
            <p className="mt-1 line-clamp-2 text-[13px] text-gray">{title}</p>
            <fieldset className="mt-3">
              <legend className="text-[12.5px] font-semibold text-gray">سبب الرفض (اختياري):</legend>
              <div className="mt-1.5 flex flex-col">
                {[{ code: "", label: "بدون سبب" }, ...REJECT_CHOICES].map((r, idx) => (
                  <label
                    key={r.code}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-cream"
                  >
                    <input
                      ref={idx === 0 ? firstRadioRef : undefined}
                      type="radio"
                      name={`reject-reason-${id}`}
                      value={r.code}
                      checked={reason === r.code}
                      onChange={() => setReason(r.code)}
                      className="size-4 accent-[var(--salma-coral)]"
                    />
                    {r.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="mt-3 block text-[12.5px] font-semibold text-gray">
              ملاحظة (اختياري):
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                rows={2}
                className="mt-1 block w-full rounded-lg border border-line px-3 py-2 text-[13px] font-normal text-ink outline-none focus:border-teal"
              />
            </label>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold hover:bg-cream disabled:opacity-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={submit}
                className="rounded-lg bg-coral px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {busy ? "جارٍ الرفض…" : reason ? "رفض" : "رفض بدون سبب"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

