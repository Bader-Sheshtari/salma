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
};

export default nextConfig;
