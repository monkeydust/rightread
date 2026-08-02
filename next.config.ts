import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["192.168.178.58"],
  // jsdom/readability are CJS + rely on Node internals — keep them out of the bundle
  serverExternalPackages: ["jsdom", "@mozilla/readability", "resend"],
};

export default nextConfig;
