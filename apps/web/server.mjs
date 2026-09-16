import { createServer } from 'node:http';
import next from 'next';

/**
 * Production entry point for the web container.
 *
 * The web server is the edge: browsers connect to it directly, so the socket address is
 * the only client address it can actually vouch for. Next.js only *adds* X-Forwarded-For
 * when the header is absent (`??=`), which means a client-supplied value would otherwise be
 * forwarded to the API untouched — letting anyone choose their own IP.
 *
 * So before Next.js sees a request, any client-supplied forwarding headers are discarded
 * and X-Forwarded-For is set to the real socket address. The API trusts X-Forwarded-For
 * only from this container's fixed address (TRUSTED_PROXIES), which closes the loop.
 */
const port = Number(process.env.PORT ?? 3000);
const hostname = '0.0.0.0';

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

createServer((req, res) => {
  delete req.headers['x-real-ip'];
  delete req.headers['forwarded'];
  req.headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
  handle(req, res);
}).listen(port, hostname, () => {
  console.log(`web listening on http://${hostname}:${port}`);
});
