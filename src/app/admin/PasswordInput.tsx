"use client";

import { useId, useState } from "react";

export const authField =
  "mt-1.5 w-full rounded-lg border border-gray/40 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-teal";
export const authLabel = "block text-[13px] font-semibold text-ink";

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {off ? (
        <>
          <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2" />
          <path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
          <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
          <path d="M3 3l18 18" />
        </>
      ) : (
        <>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

/**
 * Password field with its own show/hide toggle. Each instance keeps independent
 * visibility state; the value is untouched by toggling (only `type` changes).
 * The value is LTR; the eye sits inside the field at the RTL start side (the
 * visual left edge). Controlled when `value`/`onChange` are passed.
 */
export function PasswordInput({
  name,
  label,
  autoComplete,
  hint,
  error,
  value,
  onChange,
  onBlur,
  required = true,
  describedBy,
}: {
  name: string;
  label: string;
  autoComplete: "new-password" | "current-password";
  hint?: string;
  /** Inline error under the field (also sets aria-invalid). */
  error?: string | null;
  value?: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  required?: boolean;
  /** Extra element id(s) describing the field (e.g. the rules checklist). */
  describedBy?: string;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described =
    [hint ? hintId : "", error ? errorId : "", describedBy ?? ""].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <label htmlFor={id} className={authLabel}>
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          id={id}
          name={name}
          type={show ? "text" : "password"}
          required={required}
          maxLength={128}
          dir="ltr"
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          {...(value !== undefined
            ? {
                value,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value),
              }
            : {})}
          onBlur={onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          className={`${authField} mt-0 pl-11 ${error ? "border-coral focus:border-coral" : ""}`}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
          aria-pressed={show}
          aria-controls={id}
          title={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
          className="absolute inset-y-0 left-1.5 my-auto flex h-8 w-8 items-center justify-center rounded-md text-gray hover:bg-cream hover:text-ink focus-visible:outline-2 focus-visible:outline-teal"
        >
          <EyeIcon off={show} />
        </button>
      </div>
      {hint ? (
        <p id={hintId} className="mt-1 text-[11.5px] text-gray">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-[12px] text-coral">
          {error}
        </p>
      ) : null}
    </div>
  );
}
