"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import { setAdminRole, toggleAdminDisabled } from "../../actions";
import { createResetLink } from "../../user-actions";
import { ROLE_LABEL, assignableRoles, canManageTarget } from "@/lib/roles";
import { formatStampAr } from "@/lib/format";
import { useShowIssuedLink } from "./LinkModal";
import { StatusChip, cell, actionBtn } from "./ui";

type AdminUser = Tables<"profiles">;

const field =
  "rounded-lg border border-gray/40 bg-white px-2 py-1.5 text-[12px] outline-none focus:border-teal";

/** Why a row has no actions (display only — the server stays authoritative). */
function LockedLabel({ actorRole, isSelf, u }: { actorRole: string; isSelf: boolean; u: AdminUser }) {
  if (u.role === "owner") return <span className="text-[11.5px] text-gray">محمي</span>; // always — even own row
  if (isSelf) {
    return (
      <Link href="/admin/account" className="text-[11.5px] font-semibold text-teal hover:underline">
        حسابي
      </Link>
    );
  }
  if (actorRole === "super_admin" && u.role === "super_admin") {
    return <span className="text-[11.5px] text-gray">بإدارة المالك</span>;
  }
  return <span className="text-[11.5px] text-gray">—</span>;
}

/** One account row (active / suspended). */
export function AdminRow({
  user,
  actorRole,
  actorId,
  invitedBy,
}: {
  user: AdminUser;
  actorRole: string;
  actorId: string;
  invitedBy: string;
}) {
  const isSelf = user.id === actorId;
  // Client mirror of the server-side canManage gate (shared rule in @/lib/roles).
  const canManageThis = canManageTarget({ id: actorId, role: actorRole }, user);
  const roleOptions = assignableRoles(actorRole);
  const canChangeRole = canManageThis && !user.disabled && roleOptions.length > 0;
  const setIssued = useShowIssuedLink();
  const [error, setError] = useState("");
  const [busy, start] = useTransition();

  function issueReset() {
    setError("");
    start(async () => {
      const res = await createResetLink(user.id);
      if ("error" in res) setError(res.error);
      else setIssued({ link: res.link, email: res.email, expiresAt: res.expiresAt, kind: res.kind });
    });
  }

  return (
    <tr className={`border-t border-line align-top ${user.disabled ? "bg-sand/20" : ""}`}>
      <td className={cell}>
        <span className="font-bold text-ink">{user.full_name ?? "—"}</span>
        {isSelf ? <span className="mr-1 font-sans text-[10px] text-gray">(أنت)</span> : null}
      </td>
      <td className={cell}>
        <span dir="ltr" className="font-sans text-[12px] text-gray">
          {user.email}
        </span>
      </td>
      <td className={cell}>
        <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10.5px] font-semibold text-teal">
          {ROLE_LABEL[user.role] ?? user.role}
        </span>
      </td>
      <td className={cell}>
        <StatusChip status={user.disabled ? "suspended" : "active"} />
      </td>
      <td className={`${cell} whitespace-nowrap text-[12px] text-gray`}>
        {formatStampAr(user.created_at, false)}
      </td>
      <td className={`${cell} text-[12px] text-gray`}>{invitedBy}</td>
      <td className={cell}>
        {canManageThis ? (
          <div className="flex flex-col items-start gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {canChangeRole ? (
                <form action={setAdminRole} className="flex items-center gap-1">
                  <input type="hidden" name="id" value={user.id} />
                  <select
                    name="role"
                    defaultValue={user.role}
                    aria-label="الدور"
                    className={field}
                  >
                    {/* Legacy/unknown current role: shown but not re-assignable. */}
                    {roleOptions.includes(user.role) ? null : (
                      <option value={user.role} disabled>
                        {ROLE_LABEL[user.role] ?? user.role}
                      </option>
                    )}
                    {roleOptions.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r] ?? r}
                      </option>
                    ))}
                  </select>
                  <button className={actionBtn}>حفظ الدور</button>
                </form>
              ) : null}
              <form action={toggleAdminDisabled}>
                <input type="hidden" name="id" value={user.id} />
                <button className={actionBtn}>{user.disabled ? "إعادة تفعيل" : "إيقاف"}</button>
              </form>
              <button type="button" disabled={busy} onClick={issueReset} className={actionBtn}>
                {busy ? "…" : "إرسال رابط إعادة تعيين"}
              </button>
            </div>
            {error ? (
              <span role="alert" className="text-[11.5px] text-coral">
                {error}
              </span>
            ) : null}
          </div>
        ) : (
          <LockedLabel actorRole={actorRole} isSelf={isSelf} u={user} />
        )}
      </td>
    </tr>
  );
}
