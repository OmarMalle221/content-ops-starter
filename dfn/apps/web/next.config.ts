import path from 'node:path';
import type { NextConfig } from 'next';

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@dfn/ui', '@dfn/shared'],
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  poweredByHeader: false,
  async rewrites() {
    // Same-origin proxy: the browser talks to /api/v1/*, cookies stay first-party. Only the
    // versioned API is proxied: the API's operational endpoints (/metrics, which trusts a loopback
    // peer when no token is set, and /docs) are never reachable through the web origin.
    return [{ source: '/api/v1/:path*', destination: `${API_INTERNAL_URL}/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
