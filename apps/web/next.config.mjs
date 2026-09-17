/**
 * The browser only ever talks to the web origin. `/api/*` is proxied server-side to the
 * API container, which means the session cookie is same-origin and there is no CORS
 * configuration anywhere in the project.
 *
 * Note: rewrites() is evaluated when `next build` runs, so API_INTERNAL_URL is supplied
 * as a Docker build argument as well as a runtime environment variable. The runtime value
 * is what the /s/[token] server component uses.
 */
const apiTarget = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
export default {
  // Standalone output traces only the files the server needs, which keeps the image small.
  // The container runs server.mjs (a custom server) against that trimmed output.
  output: 'standalone',
  // Don't advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiTarget}/api/:path*` }];
  },
};
