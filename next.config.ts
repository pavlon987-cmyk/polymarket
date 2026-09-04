import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@polymarket/clob-client", "ethers", "undici", "pg"],
};

export default nextConfig;
