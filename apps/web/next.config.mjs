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
  // No `output: 'standalone'`: the container runs server.mjs, a small custom server that
  // sets the client address before Next.js handles the request.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiTarget}/api/:path*` }];
  },
};
