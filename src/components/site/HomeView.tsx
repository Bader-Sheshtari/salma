import Link from "next/link";
import type { HomepageData } from "@/lib/queries";
import { BreakingTicker } from "./BreakingTicker";
import { SectionTitle, Rail } from "./Section";
import { HeroCard, ListRow, VideoCard } from "./cards";
import { HomeSection } from "./HomeSection";

export function HomeView({ data }: { data: HomepageData }) {
  // Hero falls back to the first item of the first resolved section.
  const firstSectionContent = data.sections.find((s) => s.content.length > 0)?.content ?? [];
  const hero = data.hero ?? firstSectionContent[0] ?? null;
  const secondary = firstSectionContent.filter((c) => c.id !== hero?.id).slice(0, 3);

  return (
    <>
      <BreakingTicker items={data.breaking} />

      {/* HERO + secondary */}
      {hero ? (
        <section className="px-4 pt-5 sm:px-6">
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <HeroCard c={hero} />
            </div>
            <div className="flex flex-col divide-y divide-line">
              {secondary.map((c) => (
                <ListRow key={c.id} c={c} />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* FEED PROMPT */}
      <section className="px-4 py-5 sm:px-6">
        <Link
          href="#newsletter"
          className="block rounded-2xl bg-gradient-to-br from-teal to-green p-5 text-white sm:p-6"
        >
          <div className="text-lg font-bold">خلاصتك تبدأ من هنا</div>
          <div className="mt-1.5 text-[13px] leading-relaxed opacity-90">
            اختر اهتماماتك وستعرض لك سلمى ما يهمّك أولاً — أخبار، فيديو، تحقيقات.
          </div>
          <span className="mt-4 inline-block rounded-lg bg-white px-4 py-2.5 text-[13.5px] font-bold text-teal">
            اختر اهتماماتك ←
          </span>
        </Link>
      </section>

      {/* VIDEO (fixed lane; renders only when videos exist) */}
      {data.videos.length > 0 ? (
        <section className="px-4 py-5 sm:px-6">
          <SectionTitle title="فيديو وتبسيط طبي" />
          <Rail
            cols="sm:grid-cols-2 lg:grid-cols-3"
            items={data.videos.map((c) => <VideoCard key={c.id} c={c} />)}
          />
        </section>
      ) : null}

      {/* DYNAMIC SECTIONS (managed via /admin/homepage) */}
      {data.sections.map((s) => (
        <HomeSection key={s.section.id} data={s} />
      ))}

      {/* MISSION */}
      <section className="bg-teal px-5 py-7 text-white sm:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-3 font-sans text-[11px] font-semibold tracking-[2px] text-white/70">
            لماذا سلمى · WHY SALMA
          </div>
          <div className="text-2xl font-bold leading-snug">سلمى تساعدك على حياة أفضل وأكثر صحة.</div>
          <p className="mt-3 text-sm leading-loose opacity-90">
            منصة إخبارية صحية مستقلة، من الكويت إلى الخليج — نُغربل العالم لنقدّم لك ما يهمّ صحتك،
            بمصداقية ومصادر موثوقة.
          </p>
        </div>
      </section>

      {/* NEWSLETTER */}
      <section id="newsletter" className="bg-white px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-xl text-center">
          <div className="text-lg font-bold">اشترك بنشرة سلمى</div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-gray">
            نُرسل لك الأهم في الصحة — أنت تتحكم بما يصلك.
          </p>
          <form className="mt-4 flex gap-2">
            <input
              type="email"
              placeholder="بريدك الإلكتروني"
              dir="rtl"
              className="flex-1 rounded-lg border border-gray/40 px-3.5 py-3 text-sm outline-none focus:border-teal"
            />
            <button
              type="submit"
              className="rounded-lg bg-teal px-5 py-3 text-sm font-bold text-white"
            >
              اشترك
            </button>
          </form>
        </div>
      </section>
    </>
  );
}
