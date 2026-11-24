import Link from "next/link";
import type { Content, HomepageData } from "@/lib/queries";
import { BreakingTicker } from "./BreakingTicker";
import { Cover, coverFor, hrefFor } from "./cards";
import { RotatingHero } from "./RotatingHero";
import { LeadMeta, StoryTile, tileFor, type CategoryLookups } from "./LeadMeta";
import { HomeSection } from "./HomeSection";
import { NewsletterForm } from "./NewsletterForm";

/** Rail label of the lead board (purpose label + amethyst hairline). */
const RAIL_LABEL = "mb-4 flex min-h-8 items-center border-b border-amethyst pb-2 text-sm font-bold leading-snug";
const HEADLINE_HOVER = "decoration-1 underline-offset-[5px] group-hover:underline";

/** Text-only lead-board story: 48px icon tile (tint = the story category's
 * section identity, glyph = story type) + headline (+1-line excerpt) + meta. */
function TileRow({ c, lookups, excerpt = false }: { c: Content; lookups: CategoryLookups; excerpt?: boolean }) {
  return (
    <Link href={hrefFor(c)} className="group grid grid-cols-[48px_minmax(0,1fr)] items-start gap-3">
      <StoryTile type={c.type} tile={tileFor(c, lookups)} />
      <div className="min-w-0">
        <h3 className={`text-base font-semibold leading-normal text-amethyst ${HEADLINE_HOVER}`}>{c.title}</h3>
        {excerpt && c.excerpt ? (
          <p className="mt-1 line-clamp-1 text-sm leading-[1.7] text-amethyst-600">{c.excerpt}</p>
        ) : null}
        <LeadMeta c={c} lookups={lookups} />
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
  // §LBL: the lead board is a mixed collection (collectionCategory = null), so
  // every story shows its tag; marks/tiles take the category's section identity.
  const lookups: CategoryLookups = { names: data.categoryNames, accents: data.categoryAccents };

  return (
    <>
      <BreakingTicker items={data.breaking} />

      {/* LEAD BOARD — Direction E / refined H1: «الأحدث» (start) · hero (centre,
          dominant) · supporting stories (end), then «المزيد من الأخبار». DOM order
          is editorial importance (hero first); the 3-rail order is visual (lg). */}
      {heroPool.length > 0 ? (
        <section aria-label="أبرز الأخبار" className="pb-8 pt-6 text-amethyst">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[minmax(0,3fr)_minmax(0,6fr)_minmax(0,3fr)]">
            <div className="md:col-span-2 md:mb-6 md:border-b md:border-hairline md:pb-6 lg:order-2 lg:col-span-1 lg:mb-0 lg:border-x lg:border-b-0 lg:px-6 lg:pb-0">
              <RotatingHero items={heroPool} lookups={lookups} />
            </div>

            {latest.length > 0 ? (
              <div className="mt-6 border-t border-hairline pt-6 md:mt-0 md:border-t-0 md:pe-6 md:pt-0 lg:order-1">
                <h2 id="lead-latest" className={RAIL_LABEL}>
                  الأحدث
                </h2>
                <ul aria-labelledby="lead-latest" className="divide-y divide-hairline">
                  {latest.map((c) => (
                    <li key={c.id} className="py-4 first:pt-0 last:pb-0">
                      <TileRow c={c} lookups={lookups} excerpt />
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
                      <LeadMeta c={feature} lookups={lookups} />
                    </Link>
                  </li>
                  {supportingRest.map((c) => (
                    <li key={c.id} className="pt-4">
                      <TileRow c={c} lookups={lookups} excerpt />
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
                    <TileRow c={c} lookups={lookups} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
                </div>
      </section>
      ) : null}

      {/* The teal feed-prompt band was removed (plan §2 DD): its #newsletter
          link lives in the masthead «اشتراك» button + the newsletter band, its
          message in the «لماذا سلمى» mission band, and its visual break is
          taken by the video lane below. */}

      {/* VIDEO — full-width dark amethyst feature band in flow (plan Phase 3):
          the newest video is the flagship; any others follow as a quiet row. */}
      {data.videos.length > 0 ? <VideoBand videos={data.videos} /> : null}

      {/* DYNAMIC SECTIONS (managed via /admin/homepage; identity via DF map) */}
      {data.sections.map((s) => (
        <HomeSection key={s.section.id} data={s} lookups={lookups} />
      ))}

      {/* PRE-FOOTER — per the refined-H1 mockup: a quiet seashell-2 well holding
          the dark-amethyst «لماذا سلمى» panel (mission text verbatim) beside the
          newsletter signup (NewsletterForm unchanged: endpoint + honeypot). The
          form keeps a light ground so its existing colours stay legible. */}
      <section aria-label="عن سلمى والنشرة" className="mt-12 border-t border-hairline bg-seashell-2 py-10 text-amethyst md:py-12">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="grid gap-8 md:grid-cols-2 md:items-center md:gap-10">
          <div className="rounded-[10px] bg-amethyst p-6 text-white md:p-8">
            <div className="mb-3 flex items-center gap-2.5 text-sm font-bold text-mauve">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/mark-mauve.svg" alt="" aria-hidden width={28} height={28} className="h-7 w-7" />
              <span>
                لماذا سلمى · <span className="font-sans text-[13px] tracking-[2px] md:text-[11px]">WHY SALMA</span>
              </span>
            </div>
            <h2 className="text-[22px] font-bold leading-[1.35] md:text-[28px]">
              سلمى تساعدك على <em className="not-italic text-mauve">حياة أفضل</em> وأكثر صحة.
            </h2>
            <p className="mt-3 max-w-[46ch] text-[15px] leading-[1.75] text-amethyst-100 md:text-base">
              منصة إخبارية صحية مستقلة، من الكويت إلى الخليج — نُغربل العالم لنقدّم لك ما يهمّ صحتك،
              بمصداقية ومصادر موثوقة.
            </p>
            <Link
              href="/about"
              className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-bold text-mauve hover:underline focus-visible:outline-mauve!"
            >
              من نحن
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5">
                <path d="m14 6-6 6 6 6" />
              </svg>
            </Link>
          </div>
          <div id="newsletter">
            <h2 className="text-xl font-bold min-[401px]:text-[length:var(--brand-fs-title)]">اشترك بنشرة سلمى</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-amethyst-600">
              سجّل بريدك — وستصلك نشرة سلمى الصحية عند انطلاقها.
            </p>
            <NewsletterForm />
          </div>
        </div>
              </div>
      </section>
    </>
  );
}

/** Video lane as a full-width dark amethyst band: flagship + quiet row. */
function VideoBand({ videos }: { videos: Content[] }) {
  const [flag, ...rest] = videos;
  const focus = "focus-visible:outline-mauve!";
  return (
    <section aria-labelledby="video-h" className="my-12 bg-amethyst py-10 text-white md:py-12">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <div className="mb-6 flex min-h-11 items-center gap-4">
        <h2 id="video-h" className="text-xl font-bold leading-snug min-[401px]:text-[length:var(--brand-fs-title)]">
          فيديو وتبسيط طبي
        </h2>
        <span aria-hidden className="flex min-w-4 flex-1 items-center">
          <span className="h-[3px] w-7 shrink-0 bg-mauve" />
          <span className="h-px flex-1 bg-mauve/30" />
        </span>
      </div>
      <Link href={hrefFor(flag)} className={`group grid items-center gap-6 md:grid-cols-2 md:gap-10 ${focus}`}>
        <div className="relative isolate grid aspect-video place-items-center overflow-hidden rounded-lg bg-amethyst-800">
          <Cover src={coverFor(flag)} alt="فيديو" dark className="absolute inset-0" zoom />
          <span aria-hidden className="relative grid size-16 place-items-center rounded-full bg-mauve text-amethyst md:size-[84px]">
            <svg viewBox="0 0 24 24" fill="currentColor" className="-me-1 size-6 md:size-8">
              <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />
            </svg>
          </span>
          {flag.video_duration ? (
            <span className="absolute bottom-2 left-2 rounded bg-amethyst/80 px-1.5 py-0.5 font-sans text-[13px] font-semibold text-white md:text-[11px]">
              {flag.video_duration}
            </span>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="mb-3 text-sm font-semibold text-mauve">فيديو وتبسيط طبي</p>
          <h3 className="text-[22px] font-bold leading-[1.4] decoration-1 underline-offset-[5px] group-hover:underline md:text-[28px]">
            {flag.title}
          </h3>
          {flag.excerpt ? (
            <p className="mt-2 line-clamp-3 text-[15px] leading-[1.7] text-amethyst-100">{flag.excerpt}</p>
          ) : null}
        </div>
      </Link>
      {rest.length > 0 ? (
        <ul className="mt-8 grid gap-6 border-t border-white/15 pt-6 sm:grid-cols-2 lg:grid-cols-3">
          {rest.map((c) => (
            <li key={c.id}>
              <Link href={hrefFor(c)} className={`group grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-3 ${focus}`}>
                <div className="relative isolate aspect-video overflow-hidden rounded-md bg-amethyst-800">
                  <Cover src={coverFor(c)} alt="فيديو" dark className="absolute inset-0" zoom />
                </div>
                <h3 className="text-[15px] font-semibold leading-snug decoration-1 underline-offset-4 group-hover:underline">
                  {c.title}
                </h3>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
            </div>
      </section>
  );
}
