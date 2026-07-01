"use client";

import { useMemo, useState } from "react";
import type { DoctorTransfer } from "@/lib/queries";
import { SPECIALTIES, ALL_SPECIALTIES } from "@/lib/specialties";
import { TransferCard } from "./TransferCard";

/** Client-side search + specialty filter over the published transfers list. */
export function TransfersBrowser({ transfers }: { transfers: DoctorTransfer[] }) {
  const [query, setQuery] = useState("");
  const [specialty, setSpecialty] = useState(ALL_SPECIALTIES);

  // Only offer specialties that actually appear in the data, in canonical order,
  // plus any free-text ones editors typed that aren't in the constant.
  const options = useMemo(() => {
    const present = new Set(transfers.map((t) => t.specialty).filter(Boolean) as string[]);
    const known = SPECIALTIES.filter((s) => present.has(s));
    const extra = [...present].filter((s) => !(SPECIALTIES as readonly string[]).includes(s));
    return [ALL_SPECIALTIES, ...known, ...extra];
  }, [transfers]);

  const filtered = useMemo(() => {
    const q = query.trim();
    return transfers.filter((t) => {
      if (specialty !== ALL_SPECIALTIES && t.specialty !== specialty) return false;
      if (!q) return true;
      const hay = `${t.doctor_name} ${t.specialty ?? ""} ${t.from_hospital ?? ""} ${t.to_hospital ?? ""} ${t.summary ?? ""}`;
      return hay.includes(q);
    });
  }, [transfers, query, specialty]);

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ابحث باسم الطبيب أو الجهة…"
          dir="rtl"
          className="flex-1 rounded-lg border border-gray/40 px-3.5 py-3 text-sm outline-none focus:border-teal"
        />
        <select
          value={specialty}
          onChange={(e) => setSpecialty(e.target.value)}
          className="rounded-lg border border-gray/40 px-3.5 py-3 text-sm outline-none focus:border-teal sm:w-56"
        >
          {options.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="text-[14px] text-gray">لا توجد نتائج مطابقة.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <TransferCard key={t.id} t={t} />
          ))}
        </div>
      )}
    </>
  );
}
