import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import next from 'next';

/**
 * Production entry point for the web container. It owns three things Next.js can't do
 * correctly on its own here.
 *
 * 1. The client address. Browsers connect to this server directly, so the socket address is
 *    the only client address it can vouch for. Next.js only *adds* X-Forwarded-For when the
 *    header is absent, so a client-supplied value would otherwise reach the API untouched.
 *    Any client-supplied forwarding headers are discarded and replaced with the real address.
 *    The API trusts X-Forwarded-For only from this container (TRUSTED_PROXIES).
 *
 * 2. Security headers, on every response (pages, assets, proxied API calls).
 *
 * 3. HTTP status codes for the public share page. The page renders a friendly "not found" or
 *    "no longer available" message, but Next.js would send it with 200. Crawlers, link
 *    checkers and monitoring should see 404 / 410, so the status is looked up and applied.
 */
const port = Number(process.env.PORT ?? 3000);
const hostname = '0.0.0.0';
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
// The origin browsers fetch signed download and preview URLs from (MinIO in development).
const storageOrigin = new URL(process.env.STORAGE_PUBLIC_ORIGIN ?? 'http://localhost:9000').origin;

const SECURITY_HEADERS = {
  // 'unsafe-inline' for scripts is required by Next.js's inline bootstrap scripts without a
  // per-request nonce. Everything else is locked to this origin; previews may load from the
  // storage origin, and nothing may frame this site.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${storageOrigin}`,
    // 'self': the share page shows a shared file from /api/shares/<token>/content.
    `frame-src 'self' ${storageOrigin}`,
    // Direct uploads PUT file parts straight to object storage.
    `connect-src 'self' ${storageOrigin}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // Share and invitation tokens live in URL paths. no-referrer guarantees a token is never sent
  // to another site in a Referer header when someone follows a link away from the page.
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// HSTS is only meaningful over HTTPS; enable it where TLS terminates in front of this server.
if (process.env.ENABLE_HSTS === 'true') {
  SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
}

// Public link pages: /s/<token> for a document, /f/<token> for a folder, /r/<token> for a file request.
const SHARE_PAGE = /^\/(s|f|r)\/([A-Za-z0-9_-]{10,200})\/?$/;
/** A shared file shown inside the share page: the one response this site may frame (itself only). */
const SHARE_CONTENT = /^\/api\/shares\/[A-Za-z0-9_-]{10,200}\/content$/;

/** Asks the API whether a share token is live, forwarding the visitor's address and cookies. */
async function shareStatus(kind, token, req) {
  const resource = kind === 'f' ? 'folder-shares' : kind === 'r' ? 'requests' : 'shares';
  try {
    const response = await fetch(`${apiUrl}/api/${resource}/${encodeURIComponent(token)}`, {
      headers: {
        'x-forwarded-for': req.headers['x-forwarded-for'] ?? '',
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      },
      signal: AbortSignal.timeout(3000),
    });
    return response.status;
  } catch {
    return 200; // If the API is unreachable, let the page render and report its own state.
  }
}

// In the container this runs from Next's standalone output, which has no next.config file.
// The resolved config (rewrites included) is recorded in the build, exactly where Next's own
// standalone server reads it from.
const builtFiles = '.next/required-server-files.json';
const conf = existsSync(builtFiles) ? JSON.parse(readFileSync(builtFiles, 'utf8')).config : undefined;
if (conf) process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(conf);

const app = next({ dev: false, hostname, port, dir: process.cwd(), conf });
const handle = app.getRequestHandler();
await app.prepare();

createServer(async (req, res) => {
  delete req.headers['x-real-ip'];
  delete req.headers['forwarded'];
  req.headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (req.url && SHARE_CONTENT.test(req.url.split('?')[0])) {
    // Only ever a PDF or an image (sent with nosniff), so the page policy has nothing to guard.
    // A default-src here would also block the browser's own PDF viewer, which runs as an embed.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }

  const share =
    (req.method === 'GET' || req.method === 'HEAD') && req.url ? SHARE_PAGE.exec(req.url.split('?')[0]) : null;
  if (share) {
    res.setHeader('Cache-Control', 'no-store');
    const status = await shareStatus(share[1], share[2], req);
    if (status === 404 || status === 410) {
      // Node writes headers through writeHead(statusCode), explicitly or implicitly, so
      // overriding it here fixes the status however Next.js ends the response.
      const writeHead = res.writeHead.bind(res);
      res.writeHead = (_code, ...rest) => writeHead(status, ...rest);
    }
  }

  handle(req, res);
}).listen(port, hostname, () => {
  console.log(`web listening on http://${hostname}:${port}`);
});
