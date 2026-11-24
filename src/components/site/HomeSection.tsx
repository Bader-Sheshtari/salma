import Link from "next/link";
import type { ReactNode } from "react";
import type { Content, HomeSectionItems, PublicDoctorTransfer } from "@/lib/queries";
import { anatomyFor, identityFor, type Anatomy, type Identity } from "@/lib/sectionIdentity";
import { formatDateAr } from "@/lib/format";
import { Cover, coverFor, hrefFor } from "./cards";
import { LeadMeta, StoryTile, type CategoryLookups } from "./LeadMeta";
import { HomeRail } from "./HomeRail";

/** Where the section's "view all" link points. */
function viewAllHref(s: HomeSectionItems["section"]): string | null {
  if (s.kind === "category" && s.category_slug) return `/category/${s.category_slug}`;
  if (s.key === "feature:doctor_transfers") return "/transfers";
  return null;
}

/** Everything a story renderer needs from its section. */
type Ctx = {
  idn: Identity;
  lookups: CategoryLookups;
  /** The section's own category — §LBL omits same-category tags. */
  sectionCategory: string | null;
};

const HOVER = "decoration-1 underline-offset-[5px] group-hover:underline";

function Meta({ c, ctx, mode }: { c: Content; ctx: Ctx; mode?: "read" | "time" }) {
  return (
    <LeadMeta
      c={c}
      lookups={ctx.lookups}
      collectionCategory={ctx.sectionCategory}
      pill={ctx.idn.pill}
      body={ctx.idn.body}
      mode={mode}
    />
  );
}

function Img({ c, ratio, ctx, className = "" }: { c: Content; ratio: string; ctx: Ctx; className?: string }) {
  return (
    <div className={`relative isolate overflow-hidden rounded-lg ${ctx.idn.ground} ${ratio} ${className}`}>
      <Cover src={coverFor(c)} alt="صورة" className="absolute inset-0" zoom />
    </div>
  );
}

function Excerpt({ c, ctx, lines = "line-clamp-2", size = "text-sm leading-[1.7]" }: { c: Content; ctx: Ctx; lines?: string; size?: string }) {
  return c.excerpt ? <p className={`mt-2 ${lines} ${size} ${ctx.idn.body}`}>{c.excerpt}</p> : null;
}

/** Big lead headline + optional standfirst (with the identity's drop rule). */
function LeadText({ c, ctx, size = "text-[22px] md:text-[26px]" }: { c: Content; ctx: Ctx; size?: string }) {
  return (
    <>
      <h3 className={`${size} font-bold leading-[1.35] ${ctx.idn.headline} ${HOVER}`}>{c.title}</h3>
      {c.excerpt ? (
        <p
          className={`mt-3 text-[15px] leading-[1.75] md:text-base ${ctx.idn.body} ${
            ctx.idn.drop ? `border-s-[3px] ps-3.5 ${ctx.idn.drop}` : ""
          }`}
        >
          {c.excerpt}
        </p>
      ) : null}
      <Meta c={c} ctx={ctx} />
    </>
  );
}

/** Text-only row: identity icon tile + headline (+1-line excerpt) + meta. */
function TileRow({ c, ctx, excerpt = true }: { c: Content; ctx: Ctx; excerpt?: boolean }) {
  return (
    <Link href={hrefFor(c)} className="group grid grid-cols-[48px_minmax(0,1fr)] items-start gap-3">
      <StoryTile type={c.type} tile={ctx.idn.fieldTile} />
      <div className="min-w-0">
        <h3 className={`text-base font-semibold leading-normal ${ctx.idn.headline} ${HOVER}`}>{c.title}</h3>
        {excerpt ? <Excerpt c={c} ctx={ctx} lines="line-clamp-1" /> : null}
        <Meta c={c} ctx={ctx} />
      </div>
    </Link>
  );
}

/** Hairline-separated rows; two columns from md when there are ≥4 (explicit
 * server-side variant, no :has()). */
function Rows({ items, ctx, render }: { items: Content[]; ctx: Ctx; render: (c: Content, i: number) => ReactNode }) {
  const two = items.length >= 4;
  return (
    <ul className={`grid gap-x-10 ${two ? "md:grid-cols-2" : ""}`}>
      {items.map((c, i) => (
        <li
          key={c.id}
          className={`border-t py-4 first:border-t-0 first:pt-0 ${ctx.idn.hairline} ${
            two ? "md:nth-2:border-t-0 md:nth-2:pt-0" : ""
          }`}
        >
          {render(c, i)}
        </li>
      ))}
    </ul>
  );
}

function NumberedRow({ c, ctx, n }: { c: Content; ctx: Ctx; n: number }) {
  return (
    <Link href={hrefFor(c)} className="group grid grid-cols-[56px_minmax(0,1fr)] items-start gap-4">
      <span
        aria-hidden
        className={`grid size-14 place-items-center rounded-full font-sans text-[22px] font-bold text-amethyst ${
          ctx.idn.disc ?? "bg-amethyst-100"
        }`}
      >
        {String(n).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <h3 className={`text-base font-semibold leading-normal ${ctx.idn.headline} ${HOVER}`}>{c.title}</h3>
        <Excerpt c={c} ctx={ctx} />
        <Meta c={c} ctx={ctx} />
      </div>
    </Link>
  );
}

// ------------------------------------------------------------------ anatomies

function Columns({ items, ctx }: { items: Content[]; ctx: Ctx }) {
  const ul = ctx.idn.underline
    ? `underline decoration-[3px] underline-offset-[7px] ${ctx.idn.underline} group-hover:decoration-amethyst`
    : HOVER;
  if (items.length <= 2) {
    // 1–2 stories: horizontal open compositions (الخليج underlined pair).
    return (
      <div className={`grid gap-6 ${items.length === 2 ? "md:grid-cols-2 md:gap-0" : ""}`}>
        {items.map((c, i) => (
          <Link
            key={c.id}
            href={hrefFor(c)}
            className={`group grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-5 ${
              items.length === 2
                ? i === 0
                  ? "md:pe-6"
                  : `border-t pt-6 md:border-s md:border-t-0 md:ps-6 md:pt-0 ${ctx.idn.hairline}`
                : ""
            }`}
          >
            <Img c={c} ratio="aspect-[3/2]" ctx={ctx} />
            <div className="min-w-0">
              <h3 className={`text-lg font-bold leading-[1.45] md:text-xl ${ctx.idn.headline} ${ul}`}>{c.title}</h3>
              <Excerpt c={c} ctx={ctx} lines="line-clamp-2 max-md:hidden" />
              <Meta c={c} ctx={ctx} />
            </div>
          </Link>
        ))}
      </div>
    );
  }
  return (
    <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2 sm:gap-y-8 lg:grid-cols-3">
      {items.map((c) => (
        <li key={c.id}>
          {/* Mobile: compact horizontal row; ≥640px: vertical column card. */}
          <Link href={hrefFor(c)} className="group grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-3 sm:block">
            <Img c={c} ratio="aspect-[3/2]" ctx={ctx} className="sm:mb-3" />
            <div className="min-w-0">
              <h3 className={`text-base font-bold leading-[1.45] sm:text-lg ${ctx.idn.headline} ${ul}`}>{c.title}</h3>
              <Excerpt c={c} ctx={ctx} lines="line-clamp-2 max-sm:hidden" />
              <Meta c={c} ctx={ctx} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function LeadStandfirst({ items, ctx }: { items: Content[]; ctx: Ctx }) {
  const [lead, ...rest] = items;
  return (
    <div>
      <Link href={hrefFor(lead)} className="group grid items-center gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-8">
        <Img c={lead} ratio="aspect-[16/10]" ctx={ctx} />
        <div className="min-w-0">
          <LeadText c={lead} ctx={ctx} />
        </div>
      </Link>
      {rest.length > 0 ? (
        <div className={`mt-6 border-t pt-6 ${ctx.idn.hairline}`}>
          <Rows items={rest} ctx={ctx} render={(c) => <TileRow c={c} ctx={ctx} />} />
        </div>
      ) : null}
    </div>
  );
}

function Open21({ items, ctx }: { items: Content[]; ctx: Ctx }) {
  const [lead, ...rest] = items;
  // A single story: a full-width 2:1 image would dominate — use the
  // horizontal lead composition instead (explicit count variant).
  if (rest.length === 0) return <LeadStandfirst items={items} ctx={ctx} />;
  return (
    <div className={`grid gap-8 ${rest.length ? "lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-10" : ""}`}>
      <Link href={hrefFor(lead)} className="group block">
        <Img c={lead} ratio="aspect-[2/1]" ctx={ctx} className="mb-4" />
        <h3 className={`text-[22px] font-bold leading-[1.35] md:text-[26px] ${ctx.idn.headline} ${HOVER}`}>{lead.title}</h3>
        <Excerpt c={lead} ctx={ctx} size="text-[15px] leading-[1.75] md:text-base" />
        <Meta c={lead} ctx={ctx} />
      </Link>
      {rest.length ? (
        <div className={`border-t-[3px] pt-4 ${ctx.idn.cap ?? "border-amethyst"}`}>
          <Rows
            items={rest}
            ctx={{ ...ctx }}
            render={(c) => (
              <Link href={hrefFor(c)} className="group grid grid-cols-[minmax(0,1fr)_96px] items-start gap-4 md:grid-cols-[minmax(0,1fr)_132px]">
                <div className="min-w-0">
                  <h3 className={`text-base font-semibold leading-normal ${ctx.idn.headline} ${HOVER}`}>{c.title}</h3>
                  <Excerpt c={c} ctx={ctx} />
                  <Meta c={c} ctx={ctx} />
                </div>
                <Img c={c} ratio="aspect-[3/2]" ctx={ctx} />
              </Link>
            )}
          />
        </div>
      ) : null}
    </div>
  );
}

function FeatureSide({ items, ctx }: { items: Content[]; ctx: Ctx }) {
  const [lead, ...rest] = items;
  return (
    <div className={`grid gap-6 ${rest.length ? "lg:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] lg:gap-0" : ""}`}>
      <Link
        href={hrefFor(lead)}
        className={`group grid items-center gap-4 md:grid-cols-2 md:gap-8 ${rest.length ? "lg:pe-6" : ""}`}
      >
        <Img c={lead} ratio="aspect-[16/9]" ctx={ctx} />
        <div className="min-w-0">
          <LeadText c={lead} ctx={ctx} />
        </div>
      </Link>
      {rest.length ? (
        <div className={`self-center border-t pt-6 lg:border-s lg:border-t-0 lg:ps-6 lg:pt-0 ${ctx.idn.hairline}`}>
          <Rows items={rest} ctx={ctx} render={(c) => <TileRow c={c} ctx={ctx} excerpt={false} />} />
        </div>
      ) : null}
    </div>
  );
}

function LeadNumbered({ items, ctx }: { items: Content[]; ctx: Ctx }) {
  const [lead, ...rest] = items;
  // A single story: a full-width 2:1 image would dominate — use the
  // horizontal lead composition instead (explicit count variant).
  if (rest.length === 0) return <LeadStandfirst items={items} ctx={ctx} />;
  return (
    <div className={`grid gap-8 ${rest.length ? "lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10" : ""}`}>
      <Link href={hrefFor(lead)} className="group block">
        <Img c={lead} ratio="aspect-[2/1]" ctx={ctx} className="mb-4" />
        <h3 className={`text-xl font-bold leading-[1.4] ${ctx.idn.headline} ${HOVER}`}>{lead.title}</h3>
        <Excerpt c={lead} ctx={ctx} />
        <Meta c={lead} ctx={ctx} />
      </Link>
      {rest.length ? (
        <div className="self-center">
          <Rows items={rest} ctx={ctx} render={(c, i) => <NumberedRow c={c} ctx={ctx} n={i + 1} />} />
        </div>
      ) : null}
    </div>
  );
}

function TextLed({ items, ctx }: { items: Content[]; ctx: Ctx }) {
  const [lead, ...rest] = items;
  return (
    <div className={`grid gap-6 ${rest.length ? "lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-0" : ""}`}>
      <Link
        href={hrefFor(lead)}
        className={`group block border-s-[3px] ps-5 ${ctx.idn.drop ?? "border-amethyst"} ${rest.length ? "lg:me-6" : ""}`}
      >
        <h3 className={`max-w-[28ch] text-[22px] font-bold leading-[1.35] md:text-[26px] ${ctx.idn.headline} ${HOVER}`}>
          {lead.title}
        </h3>
        <Excerpt c={lead} ctx={ctx} size="text-[15px] leading-[1.75] md:text-base" />
        <Meta c={lead} ctx={ctx} />
      </Link>
      {rest.length ? (
        <div className={`border-t pt-6 lg:border-s lg:border-t-0 lg:ps-6 lg:pt-0 ${ctx.idn.hairline}`}>
          <Rows items={rest} ctx={ctx} render={(c) => <TileRow c={c} ctx={ctx} excerpt={false} />} />
        </div>
      ) : null}
    </div>
  );
}

function RailCard({ c, ctx }: { c: Content; ctx: Ctx }) {
  return (
    <Link href={hrefFor(c)} className="group block">
      <Img c={c} ratio="aspect-[4/5]" ctx={ctx} className="mb-4" />
      <h3 className={`text-lg font-bold leading-[1.45] md:text-xl ${ctx.idn.headline} ${HOVER}`}>{c.title}</h3>
      <Excerpt c={c} ctx={ctx} />
      <Meta c={c} ctx={ctx} />
    </Link>
  );
}

// ----------------------------------------------------------------- transfers

/** First-name initial for the no-photo fallback monogram (honorific dropped). */
function monogram(name: string): string {
  const cleaned = name.replace(/^د\.?\s*/u, "").trim();
  return cleaned.charAt(0) || name.charAt(0) || "؟";
}

/** Golden ECG journey arrow, pointing in RTL reading direction (graphic only,
 * --color-journey-arrow #B98900 — never text, §4). */
function JourneyArrow() {
  return (
    <svg viewBox="0 0 96 20" aria-hidden className="h-5 w-16 shrink-0 text-journey-arrow md:w-24">
      <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M95 10H60l-4 0-4-7-5 14-4-11-3 4H5" />
        <path d="M12 4 4 10l8 6" />
      </g>
    </svg>
  );
}

/** One airy transfer row: portrait · identity · من ← إلى journey (the row's
 * hero) · date. Non-interactive, like the /transfers card it summarises. */
function TransferRow({ t, idn }: { t: PublicDoctorTransfer; idn: Identity }) {
  const when = formatDateAr(t.published_at ?? t.created_at);
  return (
    <article className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-4 gap-y-2 md:grid-cols-[96px_minmax(0,210px)_minmax(0,1fr)_auto] md:gap-x-8">
      <div className="size-[72px] overflow-hidden rounded-full border-[3px] border-white bg-seashell-2 md:size-24">
        {t.doctor_photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.doctor_photo_url} alt={t.doctor_name} className="h-full w-full object-cover" />
        ) : (
          <div aria-hidden className="grid h-full w-full place-items-center text-3xl font-bold text-amethyst-600">
            {monogram(t.doctor_name)}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <h3 className={`text-lg font-bold leading-[1.4] ${idn.headline}`}>{t.doctor_name}</h3>
        {t.specialty ? <p className={`mt-0.5 text-[13px] ${idn.body}`}>{t.specialty}</p> : null}
      </div>
      <p className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 md:col-span-1">
        <span className={`text-base md:text-[17px] ${idn.body}`}>من {t.from_hospital ?? "غير محدد"}</span>
        <JourneyArrow />
        <span className="text-[17px] font-bold text-amethyst md:text-[19px]">إلى {t.to_hospital ?? "غير محدد"}</span>
      </p>
      {when ? (
        <p className={`col-span-2 text-[13px] md:col-span-1 md:whitespace-nowrap md:text-xs ${idn.body}`}>
          {when}
        </p>
      ) : null}
    </article>
  );
}

// ------------------------------------------------------------------- section

/**
 * One homepage lane from its admin-managed `homepage_sections` row.
 * Identity (surface + devices + text rules) comes from `accent` via the DF map
 * (`lib/sectionIdentity.ts`); the anatomy from `display_style` × identity
 * (`anatomyFor`). `title_ar`, `items_limit`, `show_view_all`, `is_enabled`,
 * `sort_order` keep their admin meaning. Tinted fields own ≥48px paper
 * margins (my-12, collapsing between neighbours) so ANY admin order keeps
 * fields from touching (§3 rule 2).
 */
export function HomeSection({ data, lookups }: { data: HomeSectionItems; lookups: CategoryLookups }) {
  const { section, content, transfers } = data;
  const idn = identityFor(section.accent);
  const href = viewAllHref(section);
  const showAll = section.show_view_all && !!href;
  const hid = `sec-${section.id}`;
  const ctx: Ctx = { idn, lookups, sectionCategory: section.category_slug };

  const isTransfers = transfers.length > 0;
  if (!isTransfers && content.length === 0) return null;
  // Count-aware server-side variant: a rail of fewer than 3 stories reads as
  // an empty strip, so it renders as open columns instead.
  const base = anatomyFor(section.display_style, idn);
  const anatomy: Anatomy | "journey" = isTransfers
    ? "journey"
    : base === "rail" && content.length < 3
      ? "columns"
      : base;

  const titleRow = (
    <>
      <h2 id={hid} className="text-xl font-bold leading-snug text-amethyst min-[401px]:text-[length:var(--brand-fs-title)]">
        {section.title_ar}
      </h2>
      <span aria-hidden className="flex min-w-4 flex-1 items-center">
        <span className={`h-[3px] w-7 shrink-0 ${idn.rule}`} />
        <span className={`h-px flex-1 ${idn.ruleLine}`} />
      </span>
    </>
  );
  const viewAll = showAll ? (
    <Link
      href={href!}
      className={`-me-2 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-semibold text-amethyst ${idn.linkHover}`}
    >
      عرض الكل
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5 max-md:hidden">
        <path d="m14 6-6 6 6 6" />
      </svg>
    </Link>
  ) : null;

  let body: ReactNode;
  switch (anatomy) {
    case "journey":
      body = (
        <div className={`divide-y ${idn.field ? "divide-amethyst/10" : "divide-hairline"}`}>
          {transfers.map((t) => (
            <div key={t.id} className="py-4 first:pt-0 last:pb-0 md:py-5">
              <TransferRow t={t} idn={idn} />
            </div>
          ))}
        </div>
      );
      break;
    case "rail":
      body = null; // rendered by HomeRail below (needs the heading row)
      break;
    case "rows":
      body = <Rows items={content} ctx={ctx} render={(c) => <TileRow c={c} ctx={ctx} />} />;
      break;
    case "numbered":
      body = <Rows items={content} ctx={ctx} render={(c, i) => <NumberedRow c={c} ctx={ctx} n={i + 1} />} />;
      break;
    case "text-led":
      body = <TextLed items={content} ctx={ctx} />;
      break;
    case "lead-standfirst":
      body = <LeadStandfirst items={content} ctx={ctx} />;
      break;
    case "open21":
      body = <Open21 items={content} ctx={ctx} />;
      break;
    case "feature-side":
      body = <FeatureSide items={content} ctx={ctx} />;
      break;
    case "lead-numbered":
      body = <LeadNumbered items={content} ctx={ctx} />;
      break;
    default:
      body = <Columns items={content} ctx={ctx} />;
  }

  return (
    <section
      aria-labelledby={hid}
      data-identity={idn.key}
      data-anatomy={anatomy}
      data-category={section.category_slug ?? undefined}
      className={`text-amethyst ${idn.field ? `my-12 py-10 md:py-12 ${idn.surface}` : "py-10"}`}
    >
      {anatomy === "rail" ? (
        <HomeRail
          label={section.title_ar}
          heading={
            <>
              {titleRow}
              {viewAll}
            </>
          }
          items={content.map((c) => (
            <RailCard key={c.id} c={c} ctx={ctx} />
          ))}
          buttonClass={
            idn.key === "frost"
              ? "bg-frosted-blue-40 text-amethyst hover:bg-amethyst hover:text-white"
              : "border border-hairline-strong bg-white text-amethyst hover:border-amethyst hover:bg-amethyst hover:text-white"
          }
          bodyClass={idn.body}
        />
      ) : (
        // Full-bleed band (homepage shell), content centred at the H1 width.
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <div className="mb-6 flex min-h-11 items-center gap-3 md:gap-4">
            {titleRow}
            {viewAll}
          </div>
          {body}
        </div>
      )}
    </section>
  );
}
