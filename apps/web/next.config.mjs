/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // @wfb/engine ships TypeScript source rather than a build artifact, so Next
  // must compile it as part of the app.
  transpilePackages: ['@wfb/engine'],

  // Fail the production build on a type error rather than shipping it.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
