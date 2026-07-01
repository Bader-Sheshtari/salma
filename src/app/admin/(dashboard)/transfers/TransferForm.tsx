"use client";

import { useActionState, useState } from "react";
import { saveTransfer, type SaveResult } from "../../actions";
import { uploadToMedia } from "@/lib/upload";
import { SPECIALTIES } from "@/lib/specialties";
import type { DoctorTransfer } from "@/lib/queries";

const field =
  "mt-1.5 w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal";
const label = "block text-[13px] font-semibold text-ink";

/** Convert a stored ISO timestamp to the `YYYY-MM-DDTHH:mm` shape a
 * datetime-local input expects, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TransferForm({ transfer }: { transfer?: DoctorTransfer }) {
  const [state, formAction, pending] = useActionState<SaveResult, FormData>(saveTransfer, null);
  const [photoUrl, setPhotoUrl] = useState(transfer?.doctor_photo_url ?? "");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");

  async function handlePhoto(file: File) {
    setUploadError("");
    setPhotoBusy(true);
    try {
      const up = await uploadToMedia(file);
      setPhotoUrl(up.url);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "تعذّر رفع الصورة.");
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-4">
      {transfer?.id ? <input type="hidden" name="id" value={transfer.id} /> : null}

      <label className={label}>
        اسم الطبيب
        <input name="doctor_name" defaultValue={transfer?.doctor_name ?? ""} required className={field} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          تخصص الطبيب
          <input
            name="specialty"
            defaultValue={transfer?.specialty ?? ""}
            list="specialty-options"
            placeholder="اكتب أو اختر تخصصاً"
            className={field}
          />
          <datalist id="specialty-options">
            {SPECIALTIES.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className={label}>
          تاريخ الانتقال
          <input type="date" name="transfer_date" defaultValue={transfer?.transfer_date ?? ""} dir="ltr" className={field} />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          انتقل من
          <input name="from_hospital" defaultValue={transfer?.from_hospital ?? ""} placeholder="الجهة السابقة" className={field} />
        </label>
        <label className={label}>
          انتقل إلى
          <input name="to_hospital" defaultValue={transfer?.to_hospital ?? ""} placeholder="الجهة الجديدة" className={field} />
        </label>
      </div>

      {/* PHOTO */}
      <div className="rounded-2xl border border-line p-4">
        <div className="mb-2 text-[13px] font-bold">صورة الطبيب</div>
        <input type="hidden" name="doctor_photo_url" value={photoUrl} />
        {photoUrl ? (
          <div className="mb-3 h-28 w-28 overflow-hidden rounded-full border border-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoUrl} alt="معاينة الصورة" className="h-full w-full object-cover" />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-teal hover:bg-cream">
            {photoBusy ? "جارٍ الرفع…" : photoUrl ? "تغيير الصورة" : "رفع صورة"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={photoBusy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handlePhoto(f);
                e.target.value = "";
              }}
            />
          </label>
          {photoUrl ? (
            <button type="button" onClick={() => setPhotoUrl("")} className="text-[13px] font-semibold text-coral">
              إزالة
            </button>
          ) : null}
        </div>
        {uploadError ? <div className="mt-2 text-[13px] text-coral">{uploadError}</div> : null}
      </div>

      <label className={label}>
        مقتطف (يظهر في البطاقة)
        <textarea name="summary" defaultValue={transfer?.summary ?? ""} rows={2} className={field} />
      </label>

      <label className={label}>
        التفاصيل
        <textarea name="body" defaultValue={transfer?.body ?? ""} rows={6} className={field} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          اسم المصدر (اختياري)
          <input name="source_name" defaultValue={transfer?.source_name ?? ""} className={field} />
        </label>
        <label className={label}>
          رابط المصدر (اختياري)
          <input name="source_url" defaultValue={transfer?.source_url ?? ""} dir="ltr" className={field} />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          تاريخ ووقت النشر
          <input
            type="datetime-local"
            name="published_at"
            defaultValue={toLocalInput(transfer?.published_at ?? null)}
            dir="ltr"
            className={field}
          />
        </label>
        <label className={label}>
          الحالة
          <select name="status" defaultValue={transfer?.status ?? "published"} className={field}>
            <option value="published">منشور</option>
            <option value="pending">قيد المراجعة</option>
            <option value="draft">مسودة</option>
          </select>
        </label>
      </div>

      {state?.error ? <div className="text-[13px] text-coral">{state.error}</div> : null}

      <button
        type="submit"
        disabled={pending || photoBusy}
        className="self-start rounded-lg bg-teal px-6 py-2.5 text-sm font-bold text-white disabled:opacity-60"
      >
        {pending ? "جارٍ الحفظ…" : "حفظ"}
      </button>
    </form>
  );
}
