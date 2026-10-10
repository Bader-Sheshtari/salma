"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import { setAdminRole, toggleAdminDisabled } from "../../actions";
import { createResetLink } from "../../user-actions";
import { ROLE_LABEL, assignableRoles, canManageTarget } from "@/lib/roles";
import { formatStampAr } from "@/lib/format";
import { useShowIssuedLink } from "./LinkModal";
import { ProtectedChip, RoleChip, StatusChip, actionBtn, actionsCell, desktopCell, mainCell, row } from "./ui";

type AdminUser = Tables<"profiles">;

const field =
  "rounded-lg border border-gray/40 bg-white px-2 py-1.5 text-[12px] outline-none focus:border-teal";

const GENERIC_ERROR = "حدث خطأ — حاول مرة أخرى.";

/** Why a row has no actions (display only — the server stays authoritative). */
function LockedLabel({ actorRole, isSelf, u }: { actorRole: string; isSelf: boolean; u: AdminUser }) {
  if (u.role === "owner") return <ProtectedChip />; // always — even own row
  if (isSelf) {
    return (
      <Link href="/admin/account" className="text-[12px] font-semibold text-teal hover:underline">
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
      try {
        const res = await createResetLink(user.id);
        if ("error" in res) setError(res.error);
        else setIssued({ link: res.link, email: res.email, expiresAt: res.expiresAt, kind: res.kind });
      } catch {
        setError(GENERIC_ERROR);
      }
    });
  }

  const roleLabel = ROLE_LABEL[user.role] ?? user.role;
  const status = user.disabled ? "suspended" : "active";
  const lastLogin = user.last_login_at ? formatStampAr(user.last_login_at, false) : "لم يسجّل الدخول بعد";
  const joined = formatStampAr(user.created_at, false);

  return (
    <tr className={`${row} ${user.disabled ? "bg-sand/20" : ""}`}>
      <td className={mainCell}>
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-[13.5px] font-bold text-ink">{user.full_name?.trim() || "—"}</span>
          {isSelf ? <span className="font-sans text-[10.5px] text-gray">(أنت)</span> : null}
        </div>
        {/* Mobile: email + chips + meta stacked under the name. */}
        <div dir="ltr" className="mt-0.5 break-all text-right font-sans text-[12px] text-gray md:hidden">
          {user.email}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 md:hidden">
          <RoleChip label={roleLabel} />
          <StatusChip status={status} />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 font-sans text-[11px] text-gray md:hidden">
          <span>آخر دخول: {lastLogin}</span>
          <span>· انضم {joined}</span>
          {invitedBy !== "—" ? <span>· بدعوة من {invitedBy}</span> : null}
        </div>
      </td>
      <td className={desktopCell}>
        <span dir="ltr" className="break-all font-sans">
          {user.email}
        </span>
      </td>
      <td className={desktopCell}>
        <RoleChip label={roleLabel} />
      </td>
      <td className={desktopCell}>
        <StatusChip status={status} />
      </td>
      <td
        className={`${desktopCell} whitespace-nowrap`}
        title={user.last_login_at ? formatStampAr(user.last_login_at) : undefined}
      >
        {user.last_login_at ? lastLogin : <span className="text-gray/70">لم يدخل بعد</span>}
      </td>
      <td className={`${desktopCell} whitespace-nowrap`}>{joined}</td>
      <td className={desktopCell}>{invitedBy}</td>
      <td className={actionsCell}>
        {canManageThis ? (
          <div className="flex flex-col items-start gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {canChangeRole ? (
                <form action={setAdminRole} className="flex items-center gap-1">
                  <input type="hidden" name="id" value={user.id} />
                  <select
                    name="role"
                    defaultValue={user.role}
                    aria-label={`دور ${user.full_name?.trim() || user.email}`}
                    className={field}
                  >
                    {/* Legacy/unknown current role: shown but not re-assignable. */}
                    {roleOptions.includes(user.role) ? null : (
                      <option value={user.role} disabled>
                        {roleLabel}
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
                {busy ? "جارٍ الإنشاء…" : "رابط إعادة تعيين"}
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
