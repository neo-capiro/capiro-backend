import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { responseHeaders } from "./src/shared/response-headers";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  transpilePackages: ["@capiro/ui"],
  poweredByHeader: false,
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: responseHeaders,
      },
    ];
  },
};
export default config;
