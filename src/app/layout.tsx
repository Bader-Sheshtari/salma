import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { SITE_URL, SITE_NAME } from "@/lib/site";
import "./globals.css";

const plexArabic = IBM_Plex_Sans_Arabic({
  variable: "--font-arabic",
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const DESCRIPTION =
  "منصة إخبارية صحية مستقلة من الكويت إلى الخليج — أخبار وتحقيقات وفيديو بمصادر موثوقة.";

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
      className={`${plexArabic.variable} ${plexSans.variable} ${plexMono.variable} antialiased`}
    >
      <body>{children}</body>
    </html>
  );
}
