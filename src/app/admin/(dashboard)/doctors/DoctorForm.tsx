"use client";

import { useActionState, useState } from "react";
import { saveDoctor, type SaveResult } from "../../actions";
import { uploadToMedia } from "@/lib/upload";
import type { Doctor, Department } from "@/lib/queries";

const field =
  "mt-1.5 w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal";
const label = "block text-[13px] font-semibold text-ink";

export function DoctorForm({
  doctor,
  departments,
}: {
  doctor?: Doctor;
  departments: Department[];
}) {
  const [state, formAction, pending] = useActionState<SaveResult, FormData>(saveDoctor, null);
  const [photoUrl, setPhotoUrl] = useState(doctor?.photo_url ?? "");
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
      {doctor?.id ? <input type="hidden" name="id" value={doctor.id} /> : null}

      <label className={label}>
        اسم الطبيب
        <input name="name_ar" defaultValue={doctor?.name_ar ?? ""} required className={field} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          القسم
          <select name="department_id" defaultValue={doctor?.department_id ?? ""} className={field}>
            <option value="">— بدون —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name_ar}</option>
            ))}
          </select>
        </label>
        <label className={label}>
          الرابط (slug) — اختياري
          <input name="slug" defaultValue={doctor?.slug ?? ""} dir="ltr" placeholder="auto" className={field} />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          المسمّى (مثال: استشاري قلب)
          <input name="title_ar" defaultValue={doctor?.title_ar ?? ""} className={field} />
        </label>
        <label className={label}>
          المستشفى/العيادة الحالية
          <input name="hospital" defaultValue={doctor?.hospital ?? ""} className={field} />
        </label>
      </div>

      <label className={label}>
        نبذة (اختياري)
        <textarea name="bio" defaultValue={doctor?.bio ?? ""} rows={4} className={field} />
      </label>

      {/* PHOTO */}
      <div className="rounded-2xl border border-line p-4">
        <div className="mb-2 text-[13px] font-bold">صورة الطبيب</div>
        <input type="hidden" name="photo_url" value={photoUrl} />
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
