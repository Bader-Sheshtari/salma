import Link from "next/link";
import type { Category } from "@/lib/queries";
import { SectionTitle } from "./Section";

/** Short Arabic descriptions for each navbar destination, keyed by slug. */
const BRIEFS: Record<string, string> = {
  kuwait: "أحدث الأخبار والمستجدات الصحية في الكويت.",
  gulf: "تغطية صحية من دول مجلس التعاون الخليجي.",
  world: "أبرز أخبار الصحة والطب حول العالم.",
  "health-economy": "تقارير عن اقتصاد القطاع الصحي والتأمين والدواء.",
  lifestyle: "نصائح ونمط حياة للعيش بصحة أفضل.",
  investigations: "تحقيقات صحفية معمّقة في ملفات الصحة.",
  doctors: "دليل الأطباء وتقييمات المرضى لهم.",
  transfers: "أخبار انتقالات الأطباء بين المستشفيات والعيادات.",
};

const NAV_ORDER = ["kuwait", "gulf", "world", "health-economy", "lifestyle", "investigations"];

type Brief = { href: string; name: string; brief: string; accent: string };

/**
 * A compact overview grid that gives a one-line brief for every section in the
 * navbar (the six categories plus the doctors and transfers destinations), each
 * linking to its full page.
 */
export function SectionsBrief({ categories }: { categories: Category[] }) {
  const bySlug = new Map(categories.map((c) => [c.slug, c]));
  const items: Brief[] = NAV_ORDER.map((slug) => bySlug.get(slug))
    .filter(Boolean)
    .map((c) => ({
      href: `/category/${c!.slug}`,
      name: c!.name_ar,
      brief: BRIEFS[c!.slug] ?? "",
      accent: c!.accent,
    }));

  items.push(
    { href: "/doctors", name: "الأطباء", brief: BRIEFS.doctors, accent: "var(--salma-teal)" },
    { href: "/transfers", name: "انتقال الأطباء", brief: BRIEFS.transfers, accent: "var(--salma-teal)" },
  );

  return (
    <section className="px-4 py-5 sm:px-6">
      <SectionTitle title="أقسام سلمى" sub="نظرة سريعة على ما يقدّمه كل قسم" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            className="group flex flex-col rounded-2xl border border-line bg-white p-4 transition hover:shadow-[0_4px_20px_rgba(46,46,45,.08)]"
            style={{ borderTop: `3px solid ${it.accent}` }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-ink" style={{ color: it.accent }}>
                {it.name}
              </span>
              <span className="text-sm text-gray transition group-hover:-translate-x-0.5">←</span>
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-gray">{it.brief}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
