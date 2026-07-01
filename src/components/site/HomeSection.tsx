import Link from "next/link";
import type { HomeSectionItems } from "@/lib/queries";
import { SectionTitle, Rail } from "./Section";
import { ListRow, ContentCard, Cover, hrefFor } from "./cards";
import { TransferCard } from "./TransferCard";
import { timeAgoAr } from "@/lib/format";

/** Where the section's "view all" link points. */
function viewAllHref(s: HomeSectionItems["section"]): string | null {
  if (s.kind === "category" && s.category_slug) return `/category/${s.category_slug}`;
  if (s.key === "feature:doctor_transfers") return "/transfers";
  return null;
}

/**
 * Renders one homepage lane from its `homepage_sections` config. The
 * `display_style` chooses the layout; `title_ar`, `accent`, `items_limit`, and
 * `show_view_all` come straight from the admin-managed row.
 */
export function HomeSection({ data }: { data: HomeSectionItems }) {
  const { section, content, transfers } = data;
  const accent = section.accent ?? "var(--salma-green)";
  const href = viewAllHref(section);
  const action = section.show_view_all && href ? "عرض الكل ←" : undefined;

  const title = (
    <SectionTitle title={section.title_ar} bar={accent} href={href ?? undefined} action={action} />
  );

  // Doctor transfers lane — always a card rail, regardless of display_style.
  if (transfers.length > 0) {
    return (
      <section className="px-4 py-5 sm:px-6">
        {title}
        <Rail
          cols="sm:grid-cols-2 lg:grid-cols-3"
          itemWidth="w-[260px]"
          items={transfers.map((t) => <TransferCard key={t.id} t={t} />)}
        />
      </section>
    );
  }

  if (content.length === 0) return null;

  if (section.display_style === "carousel") {
    return (
      <section className="px-4 py-5 sm:px-6">
        {title}
        <Rail
          cols="sm:grid-cols-2 lg:grid-cols-3"
          itemWidth="w-[230px]"
          items={content.map((c) => <ContentCard key={c.id} c={c} />)}
        />
      </section>
    );
  }

  if (section.display_style === "featured") {
    const [lead, ...rest] = content;
    return (
      <section className="px-4 py-5 sm:px-6">
        {title}
        <div className="grid gap-5 lg:grid-cols-2">
          <Link href={hrefFor(lead)} className="block overflow-hidden rounded-2xl border border-line">
            <div className="aspect-[16/9] w-full overflow-hidden">
              <Cover src={lead.cover_image_url} alt="صورة" />
            </div>
            <div className="p-4 sm:p-5">
              <h2 className="m-0 text-lg font-bold leading-snug">{lead.title}</h2>
              {lead.excerpt ? (
                <p className="mt-2 text-[13px] leading-relaxed text-gray">{lead.excerpt}</p>
              ) : null}
              <div className="mt-2.5 font-sans text-[11px] font-semibold" style={{ color: accent }}>
                {timeAgoAr(lead.published_at)}
              </div>
            </div>
          </Link>
          <div className="flex flex-col divide-y divide-line">
            {rest.map((c) => (
              <ListRow key={c.id} c={c} accent={accent} />
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (section.display_style === "list") {
    return (
      <section className="px-4 py-5 sm:px-6">
        {title}
        <div className="grid gap-x-6 sm:grid-cols-2">
          {content.map((c) => (
            <div key={c.id} className="border-b border-line">
              <ListRow c={c} accent={accent} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  // Default: "grid" — vertical cards.
  return (
    <section className="px-4 py-5 sm:px-6">
      {title}
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
        {content.map((c) => (
          <ContentCard key={c.id} c={c} />
        ))}
      </div>
    </section>
  );
}
