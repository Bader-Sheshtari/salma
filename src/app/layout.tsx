import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import localFont from "next/font/local";
import { SITE_URL, SITE_NAME } from "@/lib/site";
import "./globals.css";
import { NavTracker } from "@/components/site/NavTracker";

// Official brand typefaces (owner-supplied agency package, 2026-11-24):
// KO Sans (Arabic) + DM Sans Variable (Latin), self-hosted WOFF2 via
// next/font/local. KO Sans carries NO Latin letters, so Latin falls through
// the body stack to DM Sans per glyph; `adjustFontFallback: false` keeps a
// synthetic metric fallback from intercepting that fallthrough. KO Sans
// includes Western + Arabic-Indic digits, so digits render in KO Sans.
const koSans = localFont({
  src: [
    { path: "../fonts/KOSans-Light.woff2", weight: "300", style: "normal" },
    { path: "../fonts/KOSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/KOSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "../fonts/KOSans-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "../fonts/KOSans-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-arabic",
  display: "swap",
  adjustFontFallback: false,
});

const dmSans = localFont({
  src: "../fonts/DMSans-VariableFont_opsz_wght.woff2",
  weight: "100 1000",
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const DESCRIPTION =
  "منصة إخبارية صحية مستقلة من الكويت إلى الخليج — أخبار وتحقيقات وفيديو بمصادر موثوقة.";

// Mobile browser chrome matches the Amethyst sticky masthead (Direction E, Phase 1).
export const viewport: Viewport = {
  themeColor: "#1d0446",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "سلمى · SALMA — أخبار صحية موثوقة",
    template: "%s · سلمى",
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "ar_AR",
    title: "سلمى · SALMA — أخبار صحية موثوقة",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "سلمى · SALMA — أخبار صحية موثوقة",
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ar"
      dir="rtl"
      // CSS smooth-scrolls in-page anchors; this tells the Next 16 router to
      // still jump instantly on route transitions.
      data-scroll-behavior="smooth"
      className={`${koSans.variable} ${dmSans.variable} ${plexMono.variable} antialiased`}
    >
      <body>
        <NavTracker />
        {children}
      </body>
    </html>
  );
}
