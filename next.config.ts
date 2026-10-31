import type { NextConfig } from 'next';
// Preserve the loopback host in authentication rewrites and OAuth callbacks.
const nextConfig: NextConfig = { devIndicators: false, agentRules: false, skipProxyUrlNormalize: true };
export default nextConfig;
