import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the MONOREPO-ROOT .env.local.
 *
 * Next would otherwise only read apps/web/.env.local, while the scripts
 * (seed, hasura:apply) and the test suites read the repository root. Two env
 * files that must be kept in sync is a footgun; this keeps a single source of
 * truth. Runs before the config is exported, so NEXT_PUBLIC_* values are still
 * available for client-side inlining at build time.
 *
 * Existing process env always wins, so CI and shell exports are not clobbered.
 */
function loadRootEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const file of ['.env.local', '.env']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadRootEnv();

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
