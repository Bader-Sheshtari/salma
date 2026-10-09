"use client";

import { useActionState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import {
  setAdminRole,
  toggleAdminDisabled,
  resetAdminPassword,
  type AdminUserResult,
} from "../../actions";
import { ROLE_LABEL, assignableRoles, canManageTarget } from "@/lib/roles";

type AdminUser = Tables<"profiles">;

const field =
  "rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal";

/** Why a row has no actions (display only — the server stays authoritative). */
function lockedLabel(actorRole: string, isSelf: boolean, u: AdminUser): string {
  if (u.role === "owner") return "محمي"; // always — even on the owner's own row
  if (isSelf) return "غيّر كلمة مرورك من الأعلى";
  if (actorRole === "super_admin" && u.role === "super_admin") return "بإدارة المالك";
  return "—";
}

export function AdminRow({
  user,
  actorRole,
  actorId,
}: {
  user: AdminUser;
  actorRole: string;
  actorId: string;
}) {
  const isSelf = user.id === actorId;
  // Client mirror of the server-side canManage gate (shared rule in @/lib/roles).
  const canManageThis = canManageTarget({ id: actorId, role: actorRole }, user);
  const roleOptions = assignableRoles(actorRole);
  const canChangeRole = canManageThis && roleOptions.length > 0;
  const [reset, resetAction, resetPending] = useActionState<AdminUserResult, FormData>(
    resetAdminPassword,
    null,
  );

  return (
    <li
      className={`rounded-2xl border bg-white p-4 ${user.disabled ? "border-line/60 opacity-70" : "border-line"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-ink">{user.full_name ?? "—"}</span>
            <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10px] font-semibold text-teal">
              {ROLE_LABEL[user.role] ?? user.role}
            </span>
            {isSelf ? <span className="font-sans text-[10px] text-gray">(أنت)</span> : null}
            {user.disabled ? (
              <span className="rounded bg-coral/10 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-coral">
                موقوف
              </span>
            ) : null}
          </div>
          <div dir="ltr" className="mt-0.5 font-sans text-[11px] text-gray">
            {user.email}
          </div>
        </div>

        {canManageThis ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {canChangeRole ? (
              <form action={setAdminRole} className="flex items-center gap-1">
                <input type="hidden" name="id" value={user.id} />
                <select name="role" defaultValue={user.role} className={`${field} py-1.5`}>
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
                <button className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold hover:bg-cream">
                  حفظ الدور
                </button>
              </form>
            ) : null}
            <form action={toggleAdminDisabled}>
              <input type="hidden" name="id" value={user.id} />
              <button className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold hover:bg-cream">
                {user.disabled ? "تفعيل" : "إيقاف"}
              </button>
            </form>
          </div>
        ) : (
          <span className="font-sans text-[11px] text-gray">
            {lockedLabel(actorRole, isSelf, user)}
          </span>
        )}
      </div>

      {canManageThis ? (
        <form
          action={resetAction}
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3"
        >
          <input type="hidden" name="id" value={user.id} />
          <label className="block text-[12px] font-semibold text-gray">
            كلمة مرور مؤقتة جديدة
            <input
              name="password"
              type="text"
              required
              minLength={8}
              dir="ltr"
              autoComplete="off"
              className={`${field} mt-1 block`}
            />
          </label>
          <button
            disabled={resetPending}
            className="rounded-lg border border-line px-3 py-2 text-[12px] font-semibold hover:bg-cream disabled:opacity-60"
          >
            {resetPending ? "…" : "تعيين كلمة المرور"}
          </button>
          {reset && "error" in reset ? (
            <span className="text-[12px] text-coral">{reset.error}</span>
          ) : null}
          {reset && "ok" in reset ? (
            <span className="text-[12px] text-teal">{reset.ok}</span>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}
