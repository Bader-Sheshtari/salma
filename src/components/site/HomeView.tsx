import Link from "next/link";
import type { HomepageData, Category } from "@/lib/queries";
import { BreakingTicker } from "./BreakingTicker";
import { SectionTitle, Rail } from "./Section";
import { HeroCard, ListRow, ContentCard, VideoCard, Cover, hrefFor } from "./cards";
import { TransferCard } from "./TransferCard";
import { timeAgoAr } from "@/lib/format";

export function HomeView({ data, categories }: { data: HomepageData; categories: Category[] }) {
  const cat = new Map(categories.map((c) => [c.slug, c]));
  const hero = data.hero ?? data.kuwait[0] ?? null;
  const secondary = data.kuwait.filter((c) => c.id !== hero?.id).slice(0, 3);
  const [lead, ...moreInvestigations] = data.investigations;

  return (
    <>
      <BreakingTicker items={data.breaking} />

      {/* HERO + secondary */}
      <section className="px-4 pt-5 sm:px-6">
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2">{hero ? <HeroCard c={hero} /> : null}</div>
          <div className="flex flex-col divide-y divide-line">
            {secondary.map((c) => (
              <ListRow key={c.id} c={c} />
            ))}
          </div>
        </div>
      </section>

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

      {/* KUWAIT HEALTH NEWS */}
      <section className="px-4 pb-2 sm:px-6">
        <SectionTitle
          title="أخبار الكويت الصحية"
          href="/category/kuwait"
          action="عرض الكل ←"
        />
        <div className="grid gap-x-6 sm:grid-cols-2">
          {data.kuwait.slice(0, 6).map((c) => (
            <div key={c.id} className="border-b border-line">
              <ListRow c={c} meta={`${timeAgoAr(c.published_at)} · الكويت`} />
            </div>
          ))}
        </div>
      </section>

      {/* VIDEO */}
      {data.videos.length > 0 ? (
        <section className="px-4 py-5 sm:px-6">
          <SectionTitle title="فيديو وتبسيط طبي" />
          <Rail
            cols="sm:grid-cols-2 lg:grid-cols-3"
            items={data.videos.map((c) => <VideoCard key={c.id} c={c} />)}
          />
        </section>
      ) : null}

      {/* DOCTOR TRANSFERS */}
      {data.transfers.length > 0 ? (
        <section className="px-4 py-5 sm:px-6">
          <SectionTitle
            title={data.transfersSection?.title_ar ?? "انتقال الأطباء"}
            href="/transfers"
            action={data.transfersSection?.show_view_all === false ? undefined : "عرض الكل ←"}
          />
          <Rail
            cols="sm:grid-cols-2 lg:grid-cols-3"
            itemWidth="w-[260px]"
            items={data.transfers.map((t) => <TransferCard key={t.id} t={t} />)}
          />
        </section>
      ) : null}

      {/* HEALTH ECONOMY (navy lane) */}
      {data.economy.length > 0 ? (
        <section className="bg-navy px-4 py-6 sm:px-6">
          <SectionTitle
            title="اقتصاد الصحة"
            sub="HEALTH ECONOMY · BUSINESS DESK"
            bar="var(--salma-blue)"
            color="#fff"
            href="/category/health-economy"
            action="المزيد ←"
          />
          <div className="grid gap-x-6 sm:grid-cols-2">
            {data.economy.map((c) => (
              <Link
                key={c.id}
                href={hrefFor(c)}
                className="flex gap-3 border-b border-white/10 py-3"
              >
                <span className="w-1 shrink-0 rounded-sm bg-blue" />
                <div>
                  <div className="text-[15px] font-semibold leading-relaxed text-white">{c.title}</div>
                  <div className="mt-1.5 font-sans text-[11px] text-blue">{timeAgoAr(c.published_at)}</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* INVESTIGATIONS */}
      {lead ? (
        <section className="px-4 py-5 sm:px-6">
          <div className="mb-3.5 flex items-center gap-2.5">
            <span className="h-[22px] w-1 rounded-sm bg-ink" />
            <div className="text-[17px] font-bold sm:text-lg">تحقيقات</div>
            <span className="ms-auto rounded-full bg-teal px-2 py-0.5 text-[10px] font-semibold text-white">
              قراءة معمّقة
            </span>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Link href={hrefFor(lead)} className="block overflow-hidden rounded-2xl border border-line">
              <div className="aspect-[16/9] w-full overflow-hidden">
                <Cover src={lead.cover_image_url} alt="صورة التحقيق" />
              </div>
              <div className="p-4 sm:p-5">
                <h2 className="m-0 text-lg font-bold leading-snug">{lead.title}</h2>
                {lead.excerpt ? (
                  <p className="mt-2 text-[13px] leading-relaxed text-gray">{lead.excerpt}</p>
                ) : null}
                {lead.read_minutes ? (
                  <div className="mt-2.5 font-sans text-[11px] font-semibold text-green">
                    {lead.read_minutes} دقيقة قراءة · ملف خاص
                  </div>
                ) : null}
              </div>
            </Link>
            <div className="flex flex-col divide-y divide-line">
              {moreInvestigations.map((c) => (
                <ListRow key={c.id} c={c} meta={c.read_minutes ? `${c.read_minutes} دقائق قراءة` : undefined} />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* LIFESTYLE */}
      {data.lifestyle.length > 0 ? (
        <section
          className="px-4 py-6 sm:px-6"
          style={{ background: "linear-gradient(135deg,#eef7f8,#fbeeea)" }}
        >
          <SectionTitle title="صحة وحياة" bar="var(--salma-cyan)" />
          <Rail
            cols="sm:grid-cols-3 lg:grid-cols-4"
            itemWidth="w-[170px]"
            items={data.lifestyle.map((c) => <ContentCard key={c.id} c={c} />)}
          />
        </section>
      ) : null}

      {/* GULF + WORLD */}
      {data.gulfWorld.length > 0 ? (
        <section className="px-4 py-5 sm:px-6">
          <div className="mb-2 flex items-center gap-2.5">
            <span className="h-[22px] w-1 rounded-sm bg-green" />
            <div className="text-[17px] font-bold sm:text-lg">الخليج والعالم</div>
            <span className="ms-auto text-[11px] text-gray">الأهم فقط</span>
          </div>
          <div className="grid gap-x-6 sm:grid-cols-2">
            {data.gulfWorld.map((c) => (
              <Link
                key={c.id}
                href={hrefFor(c)}
                className="flex items-baseline gap-2.5 border-b border-line py-3"
              >
                <span className="shrink-0 font-sans text-[11px] font-bold text-green">
                  {cat.get(c.category_slug ?? "")?.name_ar ?? ""}
                </span>
                <span className="text-[14.5px] font-medium leading-relaxed">{c.title}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

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
