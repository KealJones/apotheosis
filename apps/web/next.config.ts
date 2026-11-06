import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Agent SDK locates and spawns CLI binaries relative to its own files;
  // keep it out of the server bundle so those paths resolve.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
