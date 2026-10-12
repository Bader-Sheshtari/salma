import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { listGccRuns, listGccSources } from "@/lib/admin-queries";
import {
  GCC_CLASS_AR,
  GCC_COUNTRY_AR,
  GCC_COUNTRY_FLAG,
  gccAuthorityLabel,
  type GccRun,
  type GccSource,
} from "@/lib/gcc-radar";

export const dynamic = "force-dynamic";

// GCC Radar V1 — admin-only coverage report (brief §20–21): active sources by
// country/class, last successful retrieval, failure streaks, and the recent
// story count per source (summed from the collector run logs, which survive
// radar retention). Read-only; registry edits happen outside the UI for V1.

// A source is flagged stale when its last successful fetch is older than this
// (the collector runs every 3 hours, so 24h ≈ eight missed opportunities).
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function timeAgo(iso: string | null): string {
  if (!iso) return "لم يُجلب بعد";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `قبل ${mins} دقيقة`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `قبل ${hours} ساعة`;
  return `قبل ${Math.round(hours / 24)} يوم`;
}

// A source is stale when it never fetched, last failed, or last succeeded too
// long ago (module-scope helper: reads the clock at request time, not render).
function isStale(s: GccSource): boolean {
  return (
    s.active &&
    (!s.last_fetch_at ||
      Date.now() - Date.parse(s.last_fetch_at) > STALE_AFTER_MS ||
      s.last_fetch_ok === false)
  );
}

function insertedLast7Days(runs: GccRun[]): Map<string, number> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const map = new Map<string, number>();
  for (const run of runs) {
    if (Date.parse(run.started_at) < cutoff) continue;
    for (const s of run.per_source ?? []) {
      map.set(s.domain, (map.get(s.domain) ?? 0) + (s.inserted ?? 0));
    }
  }
  return map;
}

export default async function GccSourcesPage() {
  await requireAdmin();
  const [sources, runs] = await Promise.all([listGccSources(), listGccRuns()]);
  const weekCounts = insertedLast7Days(runs);
  const lastRun = runs[0] ?? null;

  const byCountry = new Map<string, GccSource[]>();
  for (const s of sources) {
    (byCountry.get(s.country_code) ?? byCountry.set(s.country_code, []).get(s.country_code)!).push(s);
  }
  const countryOrder = ["KW", "SA", "AE", "QA", "BH", "OM"];
  const ordered = [...byCountry.entries()].sort(
    (a, b) => countryOrder.indexOf(a[0]) - countryOrder.indexOf(b[0]),
  );

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-2xl font-bold">تغطية مصادر رادار الخليج</h1>
        <span className="rounded-md bg-ink px-2 py-0.5 font-sans text-[10px] font-bold tracking-wide text-white">
          GCC RADAR
        </span>
      </div>
      <p className="mb-4 text-[13px] text-gray">
        حالة جلب كل مصدر مسجّل: آخر جلب ناجح، آخر خبر مرصود، وعدد الأخبار المضافة خلال ٧ أيام.
        {" "}
        <Link href="/admin/radar" className="font-semibold text-teal underline">عودة إلى الرادار ↗</Link>
      </p>

      {lastRun && (
        <div className="mb-4 rounded-lg border border-line bg-white px-3 py-2 text-[12.5px] text-ink">
          آخر تشغيل للجامع: {timeAgo(lastRun.started_at)} —{" "}
          {lastRun.status === "success" ? "نجح" : lastRun.status === "running" ? "جارٍ" : "فشل"} ·{" "}
          {lastRun.sources_ok}/{lastRun.sources_attempted} مصدرًا · أضاف {lastRun.inserted_count} خبرًا
          {lastRun.filtered_count > 0 && <> · استبعد {lastRun.filtered_count} خارج الصحة</>}
          {lastRun.duplicate_count > 0 && <> · {lastRun.duplicate_count} مكررًا</>}
        </div>
      )}

      {ordered.map(([code, rows]) => (
        <section key={code} className="mb-6">
          <h2 className="mb-2 text-[15px] font-bold text-ink">
            {GCC_COUNTRY_FLAG[code] ?? ""} {GCC_COUNTRY_AR[code] ?? code}
            <span className="ms-2 text-[12px] font-semibold text-gray">
              {rows.filter((s) => s.active).length} مصدرًا نشطًا
            </span>
          </h2>
          <div className="overflow-x-auto rounded-xl border border-line bg-white">
            <table className="w-full min-w-[760px] text-right text-[12.5px]">
              <thead>
                <tr className="border-b border-line bg-cream/60 text-[11.5px] text-gray">
                  <th className="px-3 py-2 font-semibold">المصدر</th>
                  <th className="px-3 py-2 font-semibold">التصنيف</th>
                  <th className="px-3 py-2 font-semibold">الموثوقية</th>
                  <th className="px-3 py-2 font-semibold">الطريقة</th>
                  <th className="px-3 py-2 font-semibold">آخر جلب</th>
                  <th className="px-3 py-2 font-semibold">آخر خبر</th>
                  <th className="px-3 py-2 font-semibold">أخبار ٧ أيام</th>
                  <th className="px-3 py-2 font-semibold">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const stale = isStale(s);
                  return (
                    <tr key={s.id} className="border-b border-line/60 last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-bold text-ink">{s.name_ar ?? s.name}</div>
                        <div className="font-sans text-[11px] text-gray" dir="ltr">{s.domain}</div>
                      </td>
                      <td className="px-3 py-2 text-ink">{GCC_CLASS_AR[s.source_class] ?? s.source_class}</td>
                      <td className="px-3 py-2 text-ink">{gccAuthorityLabel(s.authority_tier)}</td>
                      <td className="px-3 py-2 font-sans text-[11.5px] text-gray" dir="ltr">
                        {s.fetch_method === "rss" ? "RSS" : "Listing"}
                      </td>
                      <td className="px-3 py-2 text-gray">{timeAgo(s.last_fetch_at)}</td>
                      <td className="px-3 py-2 text-gray">{s.last_item_at ? timeAgo(s.last_item_at) : "—"}</td>
                      <td className="px-3 py-2 font-bold text-ink">{weekCounts.get(s.domain) ?? 0}</td>
                      <td className="px-3 py-2">
                        {!s.active ? (
                          <span className="rounded-md border border-line bg-cream px-1.5 py-0.5 text-[11px] font-semibold text-gray">
                            موقوف
                          </span>
                        ) : stale ? (
                          <span
                            title={s.last_error ?? undefined}
                            className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-bold text-amber-700"
                          >
                            ⚠️ متوقف عن التحديث
                            {s.consecutive_failures > 0 && <> ({s.consecutive_failures}×)</>}
                          </span>
                        ) : (
                          <span className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-bold text-emerald-700">
                            يعمل
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {sources.length === 0 && (
        <div className="rounded-lg border border-line bg-white p-6 text-center text-[13px] text-gray">
          لا توجد مصادر مسجّلة بعد.
        </div>
      )}
    </div>
  );
}
