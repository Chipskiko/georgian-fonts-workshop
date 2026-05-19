import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // potrace + jimp rely on `require()` and `instanceof` checks across module
  // boundaries. Bundling them via Turbopack breaks the instanceof checks
  // ("Right-hand side of 'instanceof' is not callable"). Loading them as
  // external Node packages preserves the constructor identity.
  serverExternalPackages: ["potrace", "jimp", "sharp", "@vercel/blob", "opentype.js"],
  experimental: {
    serverActions: {
      bodySizeLimit: "30mb",
    },
  },
};

export default nextConfig;
