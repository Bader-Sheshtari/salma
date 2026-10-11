import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateAr } from "@/lib/format";
import { INTERNAL_LABELS_AR, SOURCE_LABELS_AR } from "@/lib/reader-analytics";

export const dynamic = "force-dynamic";

const RANGES = [
  { key: 1, label: "اليوم" },
  { key: 7, label: "آخر ٧ أيام" },
  { key: 30, label: "آخر ٣٠ يوماً" },
];

type TopRow = {
  id: string; title: string; slug: string; published_at: string | null;
  views: number; engaged?: number; completed?: number; rate?: number;
};
type Dashboard = {
  overview: {
    views: number; engaged: number; completed: number;
    engagement_rate: number | null; completion_rate: number | null;
    published_in_period: number;
  };
  top_read: TopRow[];
  top_engaged: TopRow[];
  top_completed: TopRow[];
  sources: { source: string; views: number }[];
  internal: { internal_source: string; views: number }[];
  categories: {
    category_slug: string | null; name_ar: string | null;
    articles: number; views: number; engaged: number; engagement_rate: number | null;
  }[];
  search: {
    volume: number; zero_count: number;
    top_terms: { query_norm: string; searches: number; results: number }[];
    zero_terms: { query_norm: string; searches: number }[];
  };
};

const pct = (v: number | null | undefined): string =>
  v == null ? "—" : `${Math.round(v * 100)}٪`;

function Card({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[13.5px] font-bold">{title}</div>
        {note ? <div className="font-sans text-[11px] text-gray">{note}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function ArticleList({ rows, metric }: { rows: TopRow[]; metric: (r: TopRow) => string }) {
  if (!rows.length) return <div className="text-[12.5px] text-gray">لا توجد بيانات كافية بعد.</div>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.id} className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={`/admin/content/${r.id}`}
              className="line-clamp-1 text-[13px] font-semibold text-ink hover:text-teal"
            >
              {r.title}
            </Link>
            <div className="font-sans text-[10.5px] text-gray">
              نُشر {formatDateAr(r.published_at)}
            </div>
          </div>
          <div className="shrink-0 font-sans text-[12.5px] font-bold text-teal">{metric(r)}</div>
        </li>
      ))}
    </ul>
  );
}

function Bars({
  rows,
  label,
}: {
  rows: { key: string; views: number }[];
  label: (key: string) => string;
}) {
  const total = rows.reduce((s, r) => s + r.views, 0);
  if (total === 0) return <div className="text-[12.5px] text-gray">لا توجد بيانات بعد.</div>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => {
        const p = Math.round((r.views / total) * 100);
        return (
          <div key={r.key}>
            <div className="flex items-baseline justify-between text-[12.5px]">
              <span>{label(r.key)}</span>
              <span className="font-sans text-[11px] text-gray">
                {p}٪ ({r.views})
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream">
              <div className="h-full rounded-full bg-teal" style={{ width: `${p}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

type Props = { searchParams: Promise<{ d?: string }> };

export default async function AnalyticsPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const days = [1, 7, 30].includes(Number(sp.d)) ? Number(sp.d) : 7;

  const supabase = await createClient();
  const { data, error } = await (supabase as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  }).rpc("reader_analytics_dashboard", { p_days: days });
  const d = (error ? null : data) as Dashboard | null;

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">التحليلات</h1>
      <p className="mb-4 text-[13px] text-gray">
        قياس مجهول الهوية من الطرف الأول — بلا ملفات تعريف ولا هويات قرّاء. تُعرض النسب من مشاهدات
        الفترة المحددة؛ تاريخ النشر يظهر بجانب كل مقال حتى لا يبدو القديم جديداً.
      </p>

      <div className="salma-scroll mb-5 flex gap-2 overflow-x-auto">
        {RANGES.map((r) => (
          <Link
            key={r.key}
            href={`/admin/analytics${r.key === 7 ? "" : `?d=${r.key}`}`}
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
              days === r.key ? "bg-teal text-white" : "border border-line bg-white text-gray"
            }`}
          >
            {r.label}
          </Link>
        ))}
      </div>

      {!d ? (
        <div className="rounded-2xl border border-line bg-white p-6 text-[14px] text-gray">
          تعذّر تحميل التحليلات — حاول مرة أخرى.
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* نظرة عامة */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: "مشاهدات المقالات", value: d.overview.views },
              { label: "قراءات متفاعلة", value: d.overview.engaged },
              { label: "نسبة التفاعل", value: pct(d.overview.engagement_rate) },
              { label: "قراءات مكتملة", value: d.overview.completed },
              { label: "مقالات نُشرت في الفترة", value: d.overview.published_in_period },
            ].map((s) => (
              <div key={s.label} className="rounded-2xl border border-line bg-white p-4">
                <div className="font-sans text-xl font-bold text-teal">{s.value}</div>
                <div className="mt-1 text-[12px] text-gray">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="الأكثر قراءة">
              <ArticleList rows={d.top_read} metric={(r) => `${r.views}`} />
            </Card>
            <Card title="الأعلى تفاعلاً" note="بحد أدنى ١٠ مشاهدات">
              <ArticleList rows={d.top_engaged} metric={(r) => pct(r.rate)} />
            </Card>
            <Card title="الأعلى اكتمالاً" note="بحد أدنى ١٠ مشاهدات">
              <ArticleList rows={d.top_completed} metric={(r) => pct(r.rate)} />
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="مصادر الزيارات">
              <Bars
                rows={d.sources.map((s) => ({ key: s.source, views: s.views }))}
                label={(k) => SOURCE_LABELS_AR[k] ?? k}
              />
            </Card>
            <Card
              title="الاكتشاف الداخلي"
              note="كيف يصل القرّاء إلى المقالات من داخل سلمى"
            >
              <Bars
                rows={d.internal.map((s) => ({ key: s.internal_source, views: s.views }))}
                label={(k) => INTERNAL_LABELS_AR[k] ?? k}
              />
            </Card>
          </div>

          {/* الأقسام */}
          <Card title="أداء الأقسام" note="الحجم ونسبة التفاعل معاً — لا ترتيب بالمشاهدات وحدها">
            {d.categories.length === 0 ? (
              <div className="text-[12.5px] text-gray">لا توجد بيانات بعد.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-right text-[12.5px]">
                  <thead>
                    <tr className="border-b border-line text-[11.5px] text-gray">
                      <th className="px-2 py-2 font-semibold">القسم</th>
                      <th className="px-2 py-2 font-semibold">مقالات</th>
                      <th className="px-2 py-2 font-semibold">مشاهدات</th>
                      <th className="px-2 py-2 font-semibold">قراءات متفاعلة</th>
                      <th className="px-2 py-2 font-semibold">نسبة التفاعل</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.categories.map((c) => (
                      <tr key={c.category_slug ?? "none"} className="border-b border-line/60 last:border-0">
                        <td className="px-2 py-2 font-semibold">{c.name_ar ?? "بدون قسم"}</td>
                        <td className="px-2 py-2 font-sans">{c.articles}</td>
                        <td className="px-2 py-2 font-sans">{c.views}</td>
                        <td className="px-2 py-2 font-sans">{c.engaged}</td>
                        <td className="px-2 py-2 font-sans font-bold text-teal">{pct(c.engagement_rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* البحث */}
          <Card
            title="ما الذي يبحث عنه القراء؟"
            note={`${d.search.volume} عملية بحث — منها ${d.search.zero_count} بلا نتائج`}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-1.5 text-[12px] font-bold text-gray">الأكثر بحثاً</div>
                {d.search.top_terms.length === 0 ? (
                  <div className="text-[12.5px] text-gray">لا توجد عمليات بحث بعد.</div>
                ) : (
                  <ul className="flex flex-col gap-1 text-[12.5px]">
                    {d.search.top_terms.map((t) => (
                      <li key={t.query_norm} className="flex justify-between gap-2">
                        <span>{t.query_norm}</span>
                        <span className="font-sans text-[11px] text-gray">×{t.searches}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="mb-1.5 text-[12px] font-bold text-coral">بحث بلا نتائج</div>
                {d.search.zero_terms.length === 0 ? (
                  <div className="text-[12.5px] text-gray">لا شيء — كل البحثات وجدت نتائج.</div>
                ) : (
                  <ul className="flex flex-col gap-1 text-[12.5px]">
                    {d.search.zero_terms.map((t) => (
                      <li key={t.query_norm} className="flex justify-between gap-2">
                        <span>{t.query_norm}</span>
                        <span className="font-sans text-[11px] text-gray">×{t.searches}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
