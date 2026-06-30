import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

const BRAND = {
  teal: "#3a7c6c",
  cream: "#f7efe6",
  sand: "#e6dccd",
  ink: "#2e2e2d",
  gray: "#616261",
};

/** Load the bundled Arabic TTFs once per server process. */
let fontCache: { regular: ArrayBuffer; bold: ArrayBuffer } | null = null;
async function loadFonts() {
  if (fontCache) return fontCache;
  const dir = join(process.cwd(), "assets");
  const [regular, bold] = await Promise.all([
    readFile(join(dir, "IBMPlexSansArabic-Regular.ttf")),
    readFile(join(dir, "IBMPlexSansArabic-Bold.ttf")),
  ]);
  fontCache = {
    regular: regular.buffer.slice(regular.byteOffset, regular.byteOffset + regular.byteLength),
    bold: bold.buffer.slice(bold.byteOffset, bold.byteOffset + bold.byteLength),
  };
  return fontCache;
}

/**
 * Render the branded Salma share card. Pure text + brand colors so it never
 * depends on a remote cover fetch — works for every article and video.
 */
export async function ogCard({
  title,
  categoryName,
  accent,
  isVideo,
}: {
  title: string;
  categoryName?: string;
  accent?: string;
  isVideo?: boolean;
}): Promise<ImageResponse> {
  const fonts = await loadFonts();
  const pill = accent ?? BRAND.teal;
  const titleSize = title.length > 72 ? 52 : title.length > 42 ? 64 : 76;
  // Greedily wrap the title into lines by an approximate per-line char budget.
  // Each line renders as a shrink-wrapped row so words stay tightly spaced
  // (satori's flex-wrap + justify-content cannot produce natural spacing).
  const lineCharBudget = Math.floor(980 / (titleSize * 0.6));
  const titleLines: string[][] = [[]];
  let lineLen = 0;
  for (const word of title.split(/\s+/).filter(Boolean)) {
    const next = lineLen === 0 ? word.length : lineLen + 1 + word.length;
    if (lineLen > 0 && next > lineCharBudget) {
      titleLines.push([word]);
      lineLen = word.length;
    } else {
      titleLines[titleLines.length - 1].push(word);
      lineLen = next;
    }
  }
  const wordGap = Math.round(titleSize * 0.28);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BRAND.cream,
          padding: "64px 72px",
          fontFamily: "Plex",
          borderRight: `20px solid ${BRAND.teal}`,
        }}
      >
        {/* header: brand on the right, type badge on the left */}
        <div
          style={{
            display: "flex",
            flexDirection: "row-reverse",
            justifyContent: "space-between",
            alignItems: "center",
            width: "100%",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span style={{ fontSize: 64, fontWeight: 700, color: BRAND.teal }}>سلمى</span>
            <span style={{ fontSize: 22, letterSpacing: 8, color: BRAND.gray }}>SALMA</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontWeight: 700,
              color: "#fff",
              background: BRAND.ink,
              borderRadius: 999,
              padding: "10px 28px",
            }}
          >
            {isVideo ? "فيديو" : "مقال"}
          </div>
        </div>

        {/* title + category, hugging the right edge for RTL */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", width: "100%" }}>
          {categoryName ? (
            <div
              style={{
                display: "flex",
                fontSize: 30,
                fontWeight: 700,
                color: "#fff",
                background: pill,
                borderRadius: 12,
                padding: "8px 26px",
                marginBottom: 28,
              }}
            >
              {categoryName}
            </div>
          ) : null}
          {/* row-reverse wrapper makes the title column shrink-wrap to its
              widest line (satori stretches column children to 100% otherwise,
              which spreads the words). */}
          <div style={{ display: "flex", flexDirection: "row-reverse", width: "100%" }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                rowGap: Math.round(titleSize * 0.18),
                fontSize: titleSize,
                fontWeight: 700,
                lineHeight: 1.2,
                color: BRAND.ink,
              }}
            >
              {titleLines.map((line, li) => (
                <div key={li} style={{ display: "flex", flexDirection: "row-reverse", columnGap: wordGap }}>
                  {line.map((w, wi) => (
                    <span key={wi}>{w}</span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* footer */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            width: "100%",
            borderTop: `2px solid ${BRAND.sand}`,
            paddingTop: 24,
            fontSize: 26,
            color: BRAND.gray,
          }}
        >
          <div style={{ display: "flex", flexDirection: "row-reverse", columnGap: 10 }}>
            {"أخبار صحية موثوقة من الكويت إلى الخليج".split(" ").map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Plex", data: fonts.regular, weight: 400, style: "normal" },
        { name: "Plex", data: fonts.bold, weight: 700, style: "normal" },
      ],
    },
  );
}
