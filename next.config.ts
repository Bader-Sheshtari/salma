import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
