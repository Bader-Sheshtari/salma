"use client";

import { useActionState } from "react";
import { saveTransfer, type SaveResult } from "../../actions";
import type { DoctorTransfer, Department } from "@/lib/queries";

const field =
  "mt-1.5 w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal";
const label = "block text-[13px] font-semibold text-ink";

export function TransferForm({
  transfer,
  departments,
}: {
  transfer?: DoctorTransfer;
  departments: Department[];
}) {
  const [state, formAction, pending] = useActionState<SaveResult, FormData>(saveTransfer, null);

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-4">
      {transfer?.id ? <input type="hidden" name="id" value={transfer.id} /> : null}

      <label className={label}>
        اسم الطبيب
        <input name="doctor_name" defaultValue={transfer?.doctor_name ?? ""} required className={field} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          القسم
          <select name="department_id" defaultValue={transfer?.department_id ?? ""} className={field}>
            <option value="">— بدون —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name_ar}</option>
            ))}
          </select>
        </label>
        <label className={label}>
          تاريخ الانتقال
          <input type="date" name="transfer_date" defaultValue={transfer?.transfer_date ?? ""} dir="ltr" className={field} />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          من (المستشفى السابق)
          <input name="from_hospital" defaultValue={transfer?.from_hospital ?? ""} className={field} />
        </label>
        <label className={label}>
          إلى (المستشفى الجديد)
          <input name="to_hospital" defaultValue={transfer?.to_hospital ?? ""} className={field} />
        </label>
      </div>

      <label className={label}>
        ملاحظة (اختياري)
        <textarea name="note" defaultValue={transfer?.note ?? ""} rows={3} className={field} />
      </label>

      <label className={label}>
        الحالة
        <select name="status" defaultValue={transfer?.status ?? "published"} className={field}>
          <option value="published">منشور</option>
          <option value="draft">مسودة</option>
        </select>
      </label>

      {state?.error ? <div className="text-[13px] text-coral">{state.error}</div> : null}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-teal px-6 py-2.5 text-sm font-bold text-white disabled:opacity-60"
      >
        {pending ? "جارٍ الحفظ…" : "حفظ"}
      </button>
    </form>
  );
}
