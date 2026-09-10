import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // TypeScript 6 supports the compiler API; avoid Next's failing --showConfig capture.
  experimental: { useTypeScriptCli: false },
};

export default nextConfig;
