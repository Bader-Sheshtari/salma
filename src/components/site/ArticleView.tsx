import Link from "next/link";
import type { ContentDetail, Category, Content } from "@/lib/queries";
import { Cover, ListRow } from "./cards";
import { ShareBar } from "./ShareBar";
import { Comments } from "./Comments";
import { timeAgoAr, embedUrl } from "@/lib/format";
import { contentJsonLd } from "@/lib/seo";

/** Small, subtle source/credit line. Renders nothing when no name is given. */
function Credit({
  name,
  url,
  prefix,
}: {
  name: string | null;
  url: string | null;
  prefix?: string;
}) {
  if (!name) return null;
  const text = prefix ? `${prefix} ${name}` : name;
  return (
    <p className="mt-1 text-[11px] leading-relaxed text-gray/70">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="underline underline-offset-2 hover:text-gray"
        >
          {text}
        </a>
      ) : (
        text
      )}
    </p>
  );
}

export function ArticleView({
  detail,
  categories,
  related,
}: {
  detail: ContentDetail;
  categories: Category[];
  related: Content[];
}) {
  const { content, sources, media, comments } = detail;
  const category = categories.find((c) => c.slug === content.category_slug);
  const isVideo = content.type === "video";
  const paragraphs = (content.body ?? "").split(/\n{2,}/).filter((p) => p.trim());
  const jsonLd = contentJsonLd(detail, category?.name_ar);

  return (
    <article className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {category ? (
        <Link
          href={`/category/${category.slug}`}
          className="inline-block rounded-md px-2.5 py-1 text-[11px] font-semibold text-white"
          style={{ background: category.accent }}
        >
          {category.name_ar}
        </Link>
      ) : null}

      <h1 className="mt-3 text-2xl font-bold leading-snug sm:text-3xl">{content.title}</h1>

      <div className="mt-2 flex items-center gap-3 font-sans text-[12px] text-gray">
        <span>{timeAgoAr(content.published_at)}</span>
        {content.read_minutes ? <span>· {content.read_minutes} دقائق قراءة</span> : null}
      </div>

      {/* lead media */}
      {isVideo && content.video_url ? (
        <div className="mt-5 aspect-video w-full overflow-hidden rounded-2xl bg-ink">
          <iframe
            src={embedUrl(content.video_url)}
            title={content.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="h-full w-full"
          />
        </div>
      ) : content.cover_image_url ? (
        <figure className="mt-5">
          <div className="aspect-[16/9] w-full overflow-hidden rounded-2xl border border-line">
            <Cover src={content.cover_image_url} alt="صورة المقال" />
          </div>
          <Credit name={content.cover_credit_name} url={content.cover_credit_url} />
        </figure>
      ) : null}

      {content.excerpt ? (
        <p className="mt-5 border-r-4 border-teal pr-4 text-[15px] font-medium leading-loose text-gray">
          {content.excerpt}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-4 text-[16px] leading-loose text-ink">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      {/* article source / credit */}
      <Credit name={content.source_name} url={content.source_url} prefix="المصدر:" />

      {/* MEDIA GALLERY */}
      {media.length > 0 ? (
        <div className="mt-6 flex flex-col gap-6">
          {media.map((m) => (
            <figure key={m.id}>
              {m.type === "video" ? (
                <div className="aspect-video w-full overflow-hidden rounded-2xl bg-ink">
                  <iframe
                    src={embedUrl(m.url)}
                    title={m.caption ?? "فيديو"}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    className="h-full w-full"
                  />
                </div>
              ) : (
                <div className="w-full overflow-hidden rounded-2xl border border-line">
                  <Cover src={m.url} alt={m.caption ?? "صورة"} className="aspect-[16/9]" />
                </div>
              )}
              {m.caption ? (
                <figcaption className="mt-2 text-[13.5px] leading-relaxed text-gray">
                  {m.caption}
                </figcaption>
              ) : null}
              <Credit name={m.credit_name} url={m.credit_url} />
            </figure>
          ))}
        </div>
      ) : null}

      <div className="mt-6 border-t border-line pt-4">
        <ShareBar title={content.title} />
      </div>

      {/* SOURCES / REFERENCES */}
      {sources.length > 0 ? (
        <section className="mt-6 rounded-2xl bg-cream p-4 sm:p-5">
          <h2 className="mb-3 flex items-center gap-2 text-[15px] font-bold">
            <span className="h-4 w-1 rounded-sm bg-teal" />
            المصادر والمراجع
          </h2>
          <ul className="flex flex-col gap-2">
            {sources.map((s) => (
              <li key={s.id} className="text-[13.5px]">
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="font-semibold text-teal underline underline-offset-2 hover:opacity-80"
                  >
                    {s.label}
                  </a>
                ) : (
                  <span className="font-semibold text-ink">{s.label}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Comments contentId={content.id} comments={comments} />

      {/* RELATED */}
      {related.length > 0 ? (
        <section className="mt-8 border-t border-line pt-5">
          <h2 className="mb-2 text-[17px] font-bold">اقرأ أيضاً</h2>
          <div className="flex flex-col divide-y divide-line">
            {related.map((c) => (
              <ListRow key={c.id} c={c} />
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}
