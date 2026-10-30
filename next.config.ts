import type { NextConfig } from "next";

// Tauri serves the static export from `out/`; there is no Node server at runtime.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  devIndicators: false,
};

export default nextConfig;
