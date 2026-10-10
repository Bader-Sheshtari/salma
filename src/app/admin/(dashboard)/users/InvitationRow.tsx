"use client";

import { useState, useTransition } from "react";
import { cancelInvitation, reissueInvitation } from "../../user-actions";
import { ROLE_LABEL, canAssignRole } from "@/lib/roles";
import { formatStampAr } from "@/lib/format";
import { useShowIssuedLink } from "./LinkModal";
import { RoleChip, StatusChip, actionBtn, actionsCell, desktopCell, mainCell, row } from "./ui";

export type InvitationView = {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  invitedBy: string;
};

const GENERIC_ERROR = "حدث خطأ — حاول مرة أخرى.";

/** One open invitation row (pending / expired). The old link can't be re-shown — only reissued. */
export function InvitationRow({ inv, actorRole }: { inv: InvitationView; actorRole: string }) {
  const canAct = canAssignRole(actorRole, inv.role); // server re-checks
  const setIssued = useShowIssuedLink();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [busy, start] = useTransition();

  function reissue() {
    setError("");
    start(async () => {
      try {
        const res = await reissueInvitation(inv.id);
        if ("error" in res) setError(res.error);
        else
          setIssued({ link: res.link, email: res.email, expiresAt: res.expiresAt, kind: res.kind, reissued: true });
      } catch {
        setError(GENERIC_ERROR);
      }
    });
  }

  function cancel() {
    setError("");
    start(async () => {
      try {
        const res = await cancelInvitation(inv.id);
        setConfirming(false);
        if (res && "error" in res) setError(res.error);
      } catch {
        setConfirming(false);
        setError(GENERIC_ERROR);
      }
    });
  }

  const roleLabel = ROLE_LABEL[inv.role] ?? inv.role;
  const status = inv.expired ? "expired" : "pending";
  const expiry = `${inv.expired ? "انتهت" : "تنتهي"} ${formatStampAr(inv.expiresAt, false)}`;
  const invited = formatStampAr(inv.createdAt, false);

  return (
    <tr className={row}>
      <td className={mainCell}>
        <span className="text-[12.5px] text-gray">لم يُنشأ الحساب بعد</span>
        {/* Mobile: email + chips + meta stacked. */}
        <div dir="ltr" className="mt-0.5 break-all text-right font-sans text-[12.5px] font-semibold text-ink md:hidden">
          {inv.email}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 md:hidden">
          <RoleChip label={roleLabel} />
          <StatusChip status={status} />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 font-sans text-[11px] text-gray md:hidden">
          <span>دُعي {invited}</span>
          <span>· {expiry}</span>
          {inv.invitedBy !== "—" ? <span>· بدعوة من {inv.invitedBy}</span> : null}
        </div>
      </td>
      <td className={desktopCell}>
        <span dir="ltr" className="break-all font-sans text-ink">
          {inv.email}
        </span>
      </td>
      <td className={desktopCell}>
        <RoleChip label={roleLabel} />
      </td>
      <td className={desktopCell}>
        <StatusChip status={status} />
        <div className="mt-1 whitespace-nowrap font-sans text-[10.5px] text-gray">{expiry}</div>
      </td>
      <td className={desktopCell}>—</td>
      <td className={`${desktopCell} whitespace-nowrap`}>{invited}</td>
      <td className={desktopCell}>{inv.invitedBy}</td>
      <td className={actionsCell}>
        {canAct ? (
          <div className="flex flex-col items-start gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" disabled={busy} onClick={reissue} className={actionBtn}>
                إعادة إصدار الرابط
              </button>
              {confirming ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={cancel}
                    className="whitespace-nowrap rounded-lg border border-coral/50 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-coral/10 disabled:opacity-50"
                  >
                    {busy ? "…" : "تأكيد الإلغاء"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                    className={actionBtn}
                  >
                    تراجع
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                  className={actionBtn}
                >
                  إلغاء الدعوة
                </button>
              )}
            </div>
            {error ? (
              <span role="alert" className="text-[11.5px] text-coral">
                {error}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-[11.5px] text-gray">بإدارة المالك</span>
        )}
      </td>
    </tr>
  );
}
