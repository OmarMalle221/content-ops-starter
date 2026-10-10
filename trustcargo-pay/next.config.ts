import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    poweredByHeader: false,
    reactStrictMode: true,
    // This app lives in a sub-directory of a repository that has its own lockfile.
    turbopack: { root: process.cwd() },
    agentRules: false,
    experimental: {
        serverActions: { bodySizeLimit: '11mb' }
    }
};

export default nextConfig;
