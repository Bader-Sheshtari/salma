import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateAr } from "@/lib/format";
import {
  CONTENT_OPTIONS,
  FREQUENCY_OPTIONS,
  PREFER_NOT_SAY,
  PROFESSION_OPTIONS,
  REASON_OPTIONS,
  TOPIC_OPTIONS,
  labelOf,
  type Option,
} from "@/lib/newsletter";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
/** Below this many answers, a distribution says more about noise than audience. */
const MIN_NATIONALITY_RESPONSES = 10;

const SOURCE_LABELS: Record<string, string> = {
  homepage: "الصفحة الرئيسية",
  article: "مقال",
  newsletter_page: "صفحة النشرة",
  category: "صفحة قسم",
};

const TABS = [
  { key: "all", label: "الكل" },
  { key: "subscribed", label: "نشط" },
  { key: "unsubscribed", label: "ملغى" },
  { key: "responded", label: "أجابوا على الاستبيان" },
];

type ProfileRow = {
  profession_type: string | null;
  interest_reasons: string[];
  topics: string[];
  content_preferences: string[];
  preferred_frequency: string | null;
  country_of_residence: string | null;
  nationality: string | null;
};

const regionNames = new Intl.DisplayNames(["ar"], { type: "region" });
const countryAr = (code: string | null): string => {
  if (!code) return "—";
  if (code === PREFER_NOT_SAY) return "أفضل عدم الإجابة";
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
};

function tally(values: (string | null)[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}
function tallyMulti(lists: string[][]): { counts: Map<string, number>; respondents: number } {
  const counts = new Map<string, number>();
  let respondents = 0;
  for (const list of lists) {
    if (list.length === 0) continue;
    respondents++;
    for (const v of list) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return { counts, respondents };
}

function InsightBlock({
  title,
  counts,
  respondents,
  labeler,
  max = 8,
}: {
  title: string;
  counts: Map<string, number>;
  respondents: number;
  labeler: (key: string) => string;
  max?: number;
}) {
  if (respondents === 0) {
    return (
      <div className="rounded-2xl border border-line bg-white p-4">
        <div className="text-[13px] font-bold">{title}</div>
        <div className="mt-2 text-[12.5px] text-gray">لا توجد إجابات بعد.</div>
      </div>
    );
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
  return (
    <div className="rounded-2xl border border-line bg-white p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-bold">{title}</div>
        <div className="font-sans text-[11px] text-gray">من {respondents} مجيب</div>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {rows.map(([key, n]) => {
          const pct = Math.round((n / respondents) * 100);
          return (
            <div key={key}>
              <div className="flex items-baseline justify-between text-[12.5px]">
                <span>{labeler(key)}</span>
                <span className="font-sans text-[11px] text-gray">
                  {pct}٪ ({n})
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream">
                <div className="h-full rounded-full bg-teal" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Props = { searchParams: Promise<{ status?: string; q?: string; page?: string }> };

export default async function NewsletterAdmin({ searchParams }: Props) {
  // Defense in depth — the layout only admits staff; subscriber emails are PII,
  // so this page is admin-and-above (editors are excluded, matching their
  // exclusion from users/comments/settings).
  await requireAdmin();
  const sp = await searchParams;
  const status = TABS.some((t) => t.key === sp.status) ? sp.status! : "all";
  const q = (sp.q ?? "").trim().slice(0, 100);
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const supabase = await createClient();

  // --- stats ---------------------------------------------------------------
  const countWhere = async (apply: (b: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const { count } = await apply(base());
    return count ?? 0;
  };
  const base = () =>
    supabase.from("newsletter_subscribers").select("id", { count: "exact", head: true });
  const [total, active, unsubscribed] = await Promise.all([
    countWhere((b) => b),
    countWhere((b) => b.eq("status", "subscribed")),
    countWhere((b) => b.eq("status", "unsubscribed")),
  ]);
  const { count: surveyCount } = await supabase
    .from("newsletter_audience_profiles")
    .select("subscriber_id", { count: "exact", head: true });
  const responses = surveyCount ?? 0;
  const completionRate = total > 0 ? Math.round((responses / total) * 100) : 0;

  // --- audience insights (aggregate only; denominators are respondents) -----
  const { data: profilesData } = await supabase
    .from("newsletter_audience_profiles")
    .select(
      "profession_type, interest_reasons, topics, content_preferences, preferred_frequency, country_of_residence, nationality",
    );
  const profiles: ProfileRow[] = profilesData ?? [];

  const profession = tally(profiles.map((p) => p.profession_type));
  const professionN = profiles.filter((p) => p.profession_type).length;
  const reasons = tallyMulti(profiles.map((p) => p.interest_reasons));
  const topics = tallyMulti(profiles.map((p) => p.topics));
  const prefs = tallyMulti(profiles.map((p) => p.content_preferences));
  const frequency = tally(profiles.map((p) => p.preferred_frequency));
  const frequencyN = profiles.filter((p) => p.preferred_frequency).length;
  const residence = tally(profiles.map((p) => p.country_of_residence));
  const residenceN = profiles.filter((p) => p.country_of_residence).length;
  const nationality = tally(profiles.map((p) => p.nationality));
  const nationalityN = profiles.filter((p) => p.nationality).length;

  const optLabel = (opts: Option[]) => (key: string) => labelOf(opts, key);

  // --- subscriber list -------------------------------------------------------
  const embed =
    status === "responded"
      ? "newsletter_audience_profiles!inner(profession_type, country_of_residence, survey_completed_at)"
      : "newsletter_audience_profiles(profession_type, country_of_residence, survey_completed_at)";
  let listQuery = supabase
    .from("newsletter_subscribers")
    .select(`id, email, name, status, subscribed_at, source, ${embed}`, { count: "exact" })
    .order("subscribed_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (status === "subscribed" || status === "unsubscribed") {
    listQuery = listQuery.eq("status", status);
  }
  if (q) listQuery = listQuery.ilike("email", `%${q}%`);
  const { data: listData, count: listCount } = await listQuery;
  // The embedded-relation select string is built dynamically (inner join for
  // the "responded" tab), which defeats supabase-js type inference — shape it
  // explicitly instead.
  type SubscriberRow = {
    id: string;
    email: string;
    name: string | null;
    status: string;
    subscribed_at: string;
    source: string | null;
    newsletter_audience_profiles: {
      profession_type: string | null;
      country_of_residence: string | null;
      survey_completed_at: string | null;
    } | null;
  };
  const rows = (listData ?? []) as unknown as SubscriberRow[];
  const totalPages = Math.max(1, Math.ceil((listCount ?? 0) / PAGE_SIZE));

  const pageLink = (p: number) => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (q) params.set("q", q);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return `/admin/newsletter${s ? `?${s}` : ""}`;
  };

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">النشرة البريدية</h1>
      <p className="mb-5 text-[13px] text-gray">
        المشتركون في النشرة ونتائج الاستبيان الاختياري. لم يتم إطلاق إرسال النشرة بعد.
      </p>

      {/* stats */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: "إجمالي المشتركين", value: total },
          { label: "مشتركون نشطون", value: active },
          { label: "إلغاءات الاشتراك", value: unsubscribed },
          { label: "أجابوا على الاستبيان", value: responses },
          { label: "نسبة الإجابة", value: `${completionRate}٪` },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-line bg-white p-4">
            <div className="font-sans text-xl font-bold text-teal">{s.value}</div>
            <div className="mt-1 text-[12px] text-gray">{s.label}</div>
          </div>
        ))}
      </div>

      {/* audience insights */}
      <h2 className="mb-3 text-lg font-bold">رؤى الجمهور</h2>
      <p className="mb-3 text-[12px] text-gray">
        الاستبيان اختياري، لذا تُحسب النسب من عدد المجيبين على كل سؤال — لا من إجمالي المشتركين.
      </p>
      <div className="mb-8 grid grid-cols-1 gap-3 md:grid-cols-2">
        <InsightBlock
          title="هل أنت طبيب أو تعمل في القطاع الصحي؟"
          counts={profession}
          respondents={professionN}
          labeler={optLabel(PROFESSION_OPTIONS)}
        />
        <InsightBlock
          title="أسباب الاهتمام بالمحتوى الصحي"
          counts={reasons.counts}
          respondents={reasons.respondents}
          labeler={optLabel(REASON_OPTIONS)}
        />
        <InsightBlock
          title="أكثر المواضيع اهتماماً"
          counts={topics.counts}
          respondents={topics.respondents}
          labeler={optLabel(TOPIC_OPTIONS)}
        />
        <InsightBlock
          title="نوع المحتوى المفضل"
          counts={prefs.counts}
          respondents={prefs.respondents}
          labeler={optLabel(CONTENT_OPTIONS)}
        />
        <InsightBlock
          title="التكرار المفضل للنشرة"
          counts={frequency}
          respondents={frequencyN}
          labeler={optLabel(FREQUENCY_OPTIONS)}
        />
        <InsightBlock
          title="أبرز دول الإقامة"
          counts={residence}
          respondents={residenceN}
          labeler={countryAr}
        />
        {nationalityN >= MIN_NATIONALITY_RESPONSES ? (
          <InsightBlock
            title="توزيع الجنسيات"
            counts={nationality}
            respondents={nationalityN}
            labeler={countryAr}
          />
        ) : (
          <div className="rounded-2xl border border-line bg-white p-4">
            <div className="text-[13px] font-bold">توزيع الجنسيات</div>
            <div className="mt-2 text-[12.5px] text-gray">
              يُعرض هذا التوزيع عند توفر {MIN_NATIONALITY_RESPONSES} إجابات على الأقل (حالياً:{" "}
              {nationalityN}).
            </div>
          </div>
        )}
      </div>

      {/* subscriber list */}
      <h2 className="mb-3 text-lg font-bold">المشتركون</h2>
      <div className="salma-scroll mb-3 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/newsletter${t.key === "all" ? "" : `?status=${t.key}`}${
              q ? `${t.key === "all" ? "?" : "&"}q=${encodeURIComponent(q)}` : ""
            }`}
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
              status === t.key ? "bg-teal text-white" : "border border-line bg-white text-gray"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <form method="get" action="/admin/newsletter" className="mb-4 flex gap-2">
        {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
        <input
          type="search"
          name="q"
          defaultValue={q}
          dir="ltr"
          placeholder="بحث بالبريد الإلكتروني…"
          className="w-full max-w-sm rounded-lg border border-line bg-white px-3.5 py-2 text-[13px] outline-none focus:border-teal"
        />
        <button className="rounded-lg border border-line bg-white px-4 py-2 text-[13px] font-semibold text-gray">
          بحث
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white p-6 text-[14px] text-gray">
          لا توجد نتائج.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-white">
          <table className="w-full min-w-[760px] text-right text-[13px]">
            <thead>
              <tr className="border-b border-line text-[12px] text-gray">
                <th className="px-4 py-3 font-semibold">البريد الإلكتروني</th>
                <th className="px-4 py-3 font-semibold">الاسم</th>
                <th className="px-4 py-3 font-semibold">الحالة</th>
                <th className="px-4 py-3 font-semibold">تاريخ الاشتراك</th>
                <th className="px-4 py-3 font-semibold">المصدر</th>
                <th className="px-4 py-3 font-semibold">المهنة</th>
                <th className="px-4 py-3 font-semibold">بلد الإقامة</th>
                <th className="px-4 py-3 font-semibold">الاستبيان</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = r.newsletter_audience_profiles;
                return (
                  <tr key={r.id} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-3 font-sans" dir="ltr">
                      {r.email}
                    </td>
                    <td className="px-4 py-3">{r.name || "—"}</td>
                    <td className="px-4 py-3">
                      {r.status === "subscribed" ? (
                        <span className="rounded-full bg-cream px-2.5 py-1 text-[11px] font-bold text-teal">
                          نشط
                        </span>
                      ) : (
                        <span className="rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-gray">
                          ملغى
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-sans text-[12px]">
                      {formatDateAr(r.subscribed_at)}
                    </td>
                    <td className="px-4 py-3">{SOURCE_LABELS[r.source ?? ""] ?? r.source ?? "—"}</td>
                    <td className="px-4 py-3">
                      {labelOf(PROFESSION_OPTIONS, p?.profession_type ?? null)}
                    </td>
                    <td className="px-4 py-3">{countryAr(p?.country_of_residence ?? null)}</td>
                    <td className="px-4 py-3">
                      {p?.survey_completed_at ? (
                        <span className="text-teal">أجاب</span>
                      ) : (
                        <span className="text-gray">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-center gap-3 text-[13px]">
          {page > 1 ? (
            <Link href={pageLink(page - 1)} className="rounded-lg border border-line bg-white px-3.5 py-1.5 font-semibold text-gray">
              السابق
            </Link>
          ) : null}
          <span className="font-sans text-[12px] text-gray">
            صفحة {page} من {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={pageLink(page + 1)} className="rounded-lg border border-line bg-white px-3.5 py-1.5 font-semibold text-gray">
              التالي
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
