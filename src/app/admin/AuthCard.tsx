/** Centered brand card shared by the public admin screens (login, invite acceptance, password reset). */
export function AuthCard({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  /** Slightly wider card for multi-field forms. */
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-sand px-4 py-8">
      <div
        className={`w-full ${wide ? "max-w-md" : "max-w-sm"} rounded-2xl bg-white p-6 shadow-[0_10px_40px_rgba(46,46,45,.12)] sm:p-8`}
      >
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal text-xl font-bold text-white">
            س
          </span>
          <div className="leading-tight">
            <div className="text-lg font-bold text-teal">سلمى</div>
            <div className="font-sans text-[11px] tracking-wide text-gray">لوحة الإدارة</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Calm error/notice block for invalid-link states. */
export function AuthNotice({
  title,
  body,
  tone = "error",
}: {
  title: string;
  body: string;
  tone?: "error" | "success";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-xl border p-4 ${tone === "error" ? "border-coral/40 bg-coral/10" : "border-teal/30 bg-teal/10"}`}
    >
      <div className={`text-[14px] font-bold ${tone === "error" ? "text-ink" : "text-teal"}`}>{title}</div>
      <p className="mt-1 text-[13px] leading-6 text-gray">{body}</p>
    </div>
  );
}
