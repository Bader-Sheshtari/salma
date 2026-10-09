"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export type Action = {
  key: string;
  label: string;
  href?: string;
  newTab?: boolean;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
};

/** «⋯» menu. On small screens it also carries the row's visible actions. */
export default function RowMenu({
  visible,
  menu,
  disabled,
}: {
  visible: Action[];
  menu: Action[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (visible.length === 0 && menu.length === 0) return null;
  const item = "block w-full px-3 py-2 text-start text-[12.5px] hover:bg-cream";
  const render = (a: Action, extra = "") =>
    a.href ? (
      <Link
        key={a.key}
        href={a.href}
        target={a.newTab ? "_blank" : undefined}
        onClick={() => setOpen(false)}
        className={`${item} ${extra}`}
      >
        {a.label}
      </Link>
    ) : (
      <button
        key={a.key}
        type="button"
        onClick={() => {
          setOpen(false);
          a.onClick?.();
        }}
        className={`${item} ${a.danger ? "font-semibold text-coral" : ""} ${extra}`}
      >
        {a.label}
      </button>
    );
  return (
    <div className={`relative ${menu.length === 0 ? "md:hidden" : ""}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label="إجراءات أخرى"
        aria-expanded={open}
        className="rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-bold leading-none hover:bg-cream disabled:opacity-50"
      >
        ⋯
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute end-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-white shadow-lg">
            {visible.map((a) => render(a, "md:hidden"))}
            {visible.length > 0 && menu.length > 0 ? (
              <div className="border-t border-line md:hidden" />
            ) : null}
            {menu.map((a) => render(a))}
          </div>
        </>
      ) : null}
    </div>
  );
}
