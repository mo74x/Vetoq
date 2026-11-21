import type { NextConfig } from 'next';

const apiInternalUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:3001').replace(/\/$/, '');

const nextConfig: NextConfig = {
  transpilePackages: ['@hitl/shared'],
  async rewrites() {
    return [
      {
        source: '/api/auth/:path*',
        destination: `${apiInternalUrl}/api/auth/:path*`,
      },
      {
        source: '/api/v1/:path*',
        destination: `${apiInternalUrl}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
