import Link from "next/link";
import type { Content, HomepageData } from "@/lib/queries";
import { BreakingTicker } from "./BreakingTicker";
import { SectionTitle, Rail } from "./Section";
import { Cover, VideoCard, coverFor, hrefFor } from "./cards";
import { RotatingHero } from "./RotatingHero";
import { LeadMeta, PulseTile } from "./LeadMeta";
import { HomeSection } from "./HomeSection";
import { NewsletterForm } from "./NewsletterForm";

/** Rail label of the lead board (purpose label + amethyst hairline). */
const RAIL_LABEL = "mb-4 flex min-h-8 items-center border-b border-amethyst pb-2 text-sm font-bold leading-snug";
const HEADLINE_HOVER = "decoration-1 underline-offset-[5px] group-hover:underline";

/** Text-only lead-board story: 48px icon tile + headline (+ optional 1-line excerpt) + meta. */
function TileRow({ c, categoryName, excerpt = false }: { c: Content; categoryName?: string; excerpt?: boolean }) {
  return (
    <Link href={hrefFor(c)} className="group grid grid-cols-[48px_minmax(0,1fr)] items-start gap-3">
      <PulseTile />
      <div className="min-w-0">
        <h3 className={`text-base font-semibold leading-normal text-amethyst ${HEADLINE_HOVER}`}>{c.title}</h3>
        {excerpt && c.excerpt ? (
          <p className="mt-1 line-clamp-1 text-sm leading-[1.7] text-amethyst-600">{c.excerpt}</p>
        ) : null}
        <LeadMeta c={c} categoryName={categoryName} />
      </div>
    </Link>
  );
}

export function HomeView({ data }: { data: HomepageData }) {
  // Hero rotates through the top-stories pool; fall back to the featured pick or
  // the first item of the first resolved section when the pool is empty.
  const firstSectionContent = data.sections.find((s) => s.content.length > 0)?.content ?? [];
  const heroPool =
    data.heroPool.length > 0
      ? data.heroPool
      : data.hero
        ? [data.hero]
        : firstSectionContent.slice(0, 1);
  // Lead-board slots are selected server-side (`selectLeadBoard`, plan §2 DB/DC).
  const { supporting, latest, more } = data.leadBoard;
  const [feature, ...supportingRest] = supporting;
  // §LBL: the lead board is a mixed collection, so every story shows its tag.
  const cat = (c: Content) => (c.category_slug ? data.categoryNames[c.category_slug] : undefined);

  return (
    <>
      <BreakingTicker items={data.breaking} />

      {/* LEAD BOARD — Direction E / refined H1: «الأحدث» (start) · hero (centre,
          dominant) · supporting stories (end), then «المزيد من الأخبار». DOM order
          is editorial importance (hero first); the 3-rail order is visual (lg). */}
      {heroPool.length > 0 ? (
        <section aria-label="أبرز الأخبار" className="px-4 pb-8 pt-6 text-amethyst sm:px-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[minmax(0,3fr)_minmax(0,6fr)_minmax(0,3fr)]">
            <div className="md:col-span-2 md:mb-6 md:border-b md:border-hairline md:pb-6 lg:order-2 lg:col-span-1 lg:mb-0 lg:border-x lg:border-b-0 lg:px-6 lg:pb-0">
              <RotatingHero items={heroPool} categoryNames={data.categoryNames} />
            </div>

            {latest.length > 0 ? (
              <div className="mt-6 border-t border-hairline pt-6 md:mt-0 md:border-t-0 md:pe-6 md:pt-0 lg:order-1">
                <h2 id="lead-latest" className={RAIL_LABEL}>
                  الأحدث
                </h2>
                <ul aria-labelledby="lead-latest" className="divide-y divide-hairline">
                  {latest.map((c) => (
                    <li key={c.id} className="py-4 first:pt-0 last:pb-0">
                      <TileRow c={c} categoryName={cat(c)} excerpt />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {feature ? (
              <div className="mt-6 border-t border-hairline pt-6 md:mt-0 md:border-s md:border-t-0 md:ps-6 md:pt-0 lg:order-3 lg:border-s-0">
                {/* Unlabeled second-feature rail; the empty label row keeps its
                    hairline level with the other rails (hidden on mobile). */}
                <div aria-hidden className={`${RAIL_LABEL} hidden md:flex`} />
                <h2 className="sr-only">أخبار مهمة أخرى</h2>
                <ul className="divide-y divide-hairline">
                  <li className="pb-4">
                    <Link href={hrefFor(feature)} className="group block">
                      <div className="relative isolate mb-4 aspect-[4/3] overflow-hidden rounded-lg bg-seashell-2">
                        <Cover src={coverFor(feature)} alt="صورة" className="absolute inset-0" zoom />
                      </div>
                      <h3 className={`text-lg font-bold leading-[1.4] ${HEADLINE_HOVER}`}>{feature.title}</h3>
                      {feature.excerpt ? (
                        <p className="mt-2 line-clamp-2 text-sm leading-[1.7] text-amethyst-600">{feature.excerpt}</p>
                      ) : null}
                      <LeadMeta c={feature} categoryName={cat(feature)} />
                    </Link>
                  </li>
                  {supportingRest.map((c) => (
                    <li key={c.id} className="pt-4">
                      <TileRow c={c} categoryName={cat(c)} excerpt />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {more.length > 0 ? (
            <div className="mt-6 border-t border-hairline-strong pt-4">
              <h2 id="lead-more" className="mb-3 text-sm font-bold">
                المزيد من الأخبار
              </h2>
              <ul
                aria-labelledby="lead-more"
                className="grid grid-cols-1 divide-y divide-hairline md:grid-cols-3 md:divide-y-0"
              >
                {more.map((c) => (
                  <li
                    key={c.id}
                    className="py-3 first:pt-0 last:pb-0 md:border-s md:border-hairline md:px-6 md:py-0 md:first:border-s-0 md:first:ps-0 md:last:pe-0"
                  >
                    <TileRow c={c} categoryName={cat(c)} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* The teal feed-prompt band was removed (plan §2 DD): its #newsletter
          link lives in the masthead «اشتراك» button + the newsletter band, its
          message in the «لماذا سلمى» mission band, and its visual break is
          taken by the video lane below. */}

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
            سجّل بريدك — وستصلك نشرة سلمى الصحية عند انطلاقها.
          </p>
          <NewsletterForm />
        </div>
      </section>
    </>
  );
}
