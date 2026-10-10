"use client";

import { useState, useTransition } from "react";
import { cancelInvitation, reissueInvitation } from "../../user-actions";
import { ROLE_LABEL, canAssignRole } from "@/lib/roles";
import { formatStampAr } from "@/lib/format";
import { useShowIssuedLink } from "./LinkModal";
import { StatusChip, cell, actionBtn } from "./ui";

export type InvitationView = {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  invitedBy: string;
};

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
      const res = await reissueInvitation(inv.id);
      if ("error" in res) setError(res.error);
      else setIssued({ link: res.link, email: res.email, expiresAt: res.expiresAt, kind: res.kind });
    });
  }

  function cancel() {
    setError("");
    start(async () => {
      const res = await cancelInvitation(inv.id);
      setConfirming(false);
      if (res && "error" in res) setError(res.error);
    });
  }

  return (
    <tr className="border-t border-line align-top">
      <td className={`${cell} text-gray`}>—</td>
      <td className={cell}>
        <span dir="ltr" className="font-sans text-[12px] text-gray">
          {inv.email}
        </span>
      </td>
      <td className={cell}>
        <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10.5px] font-semibold text-teal">
          {ROLE_LABEL[inv.role] ?? inv.role}
        </span>
      </td>
      <td className={cell}>
        <StatusChip status={inv.expired ? "expired" : "pending"} />
        <div className="mt-1 whitespace-nowrap font-sans text-[10.5px] text-gray">
          {inv.expired ? "انتهت " : "تنتهي "}
          {formatStampAr(inv.expiresAt, false)}
        </div>
      </td>
      <td className={`${cell} whitespace-nowrap text-[12px] text-gray`}>
        {formatStampAr(inv.createdAt, false)}
      </td>
      <td className={`${cell} text-[12px] text-gray`}>{inv.invitedBy}</td>
      <td className={cell}>
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
                    className="rounded-lg border border-coral/50 px-2.5 py-1.5 text-[12px] font-semibold text-coral hover:bg-cream disabled:opacity-50"
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
