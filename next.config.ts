import type { NextConfig } from "next";

// Launch Hardening V1 — production security headers.
//
// CSP notes (audited against the actual stack before writing):
// - No third-party scripts exist (no Clarity/analytics SDKs); Next's own
//   bootstrap needs inline scripts, hence script-src 'unsafe-inline' — the
//   conservative, non-breaking compromise (nonces would require middleware
//   rework; a V2 item).
// - img-src allows any https host BY DESIGN: article cover images are
//   hotlinked from source-news domains.
// - connect-src: the browser talks only to Salma itself and Supabase
//   (admin login / MFA / storage; wss reserved for future realtime).
// - frame-src: the only embeds are YouTube/Vimeo players (lib/format.ts).
// - frame-ancestors 'none' + X-Frame-Options DENY: nothing embeds Salma.
// - HSTS is already injected by Vercel at the edge, so it is not duplicated.
const SUPABASE_ORIGIN = "https://ukraltlejlfkqbcifgcq.supabase.co";
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' https: data: blob:`,
  "font-src 'self' data:",
  `connect-src 'self' ${SUPABASE_ORIGIN} wss://ukraltlejlfkqbcifgcq.supabase.co`,
  "media-src 'self' https:",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Ensure the bundled Arabic TTFs reach the OG-image route bundles on Vercel.
  outputFileTracingIncludes: {
    "/article/[slug]/opengraph-image": ["assets/*.ttf"],
    "/video/[slug]/opengraph-image": ["assets/*.ttf"],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "ukraltlejlfkqbcifgcq.supabase.co",
        port: "",
        pathname: "/storage/v1/object/public/**",
        search: "",
      },
    ],
  },
  // The transfer detail route was removed (transfers are now a lightweight
  // factual feed). Old /transfers/:slug URLs permanently redirect to the grid.
  async redirects() {
    return [
      { source: "/transfers/:slug", destination: "/transfers", permanent: true },
    ];
  },
};

export default nextConfig;
