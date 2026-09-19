import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound requests to addresses someone else chose (webhook URLs), made safe against
 * server-side request forgery: nothing on a private, loopback, link-local or otherwise reserved
 * network is reachable, redirects are never followed, and time and response size are bounded.
 *
 * The address check happens in the socket's own DNS lookup, so the address that is checked is
 * the address that is connected to: a name that resolves differently a second time (DNS
 * rebinding) can't slip through.
 */
const RESERVED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  RESERVED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  RESERVED.addSubnet(network, prefix, 'ipv6');
}

/** Whether an IP address is on a network no webhook may reach. IPv4-mapped IPv6 is checked as IPv4. */
export function isReservedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return RESERVED.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  if (family === 4) return RESERVED.check(address, 'ipv4');
  if (family === 6) return RESERVED.check(address, 'ipv6');
  return true;
}

export class BlockedDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedDestinationError';
  }
}

export interface SafeRequestOptions {
  /** Allow http:// and private addresses: local development and tests only. */
  allowInsecure: boolean;
  timeoutMs: number;
}

/** Checks a URL before it is stored: scheme, no credentials, and (unless allowed) https only. */
export function checkWebhookUrl(raw: string, allowInsecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedDestinationError('That is not a valid URL.');
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new BlockedDestinationError('Webhook URLs must use https.');
  }
  if (url.username || url.password) throw new BlockedDestinationError('Webhook URLs cannot contain credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !allowInsecure &&
    (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isReservedAddress(host)))
  ) {
    throw new BlockedDestinationError('Webhook URLs must point to a public address.');
  }
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function safeLookup(allowInsecure: boolean) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      const usable = allowInsecure ? addresses : addresses.filter((a) => !isReservedAddress(a.address));
      if (usable.length === 0) {
        return callback(
          Object.assign(new BlockedDestinationError(`${hostname} resolves only to private or reserved addresses`), {
            code: 'EBLOCKED',
          }),
          '',
        );
      }
      if (options.all) callback(null, usable);
      else callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}

/** POSTs a JSON body. Resolves with the status code whatever it is; rejects on network errors. */
export function postJson(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  options: SafeRequestOptions,
): Promise<{ status: number }> {
  const url = checkWebhookUrl(rawUrl, options.allowInsecure);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
        lookup: safeLookup(options.allowInsecure),
        timeout: options.timeoutMs,
      },
      (response) => {
        // The body is not needed; read and discard at most 64 KB so the socket is released.
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > 65_536) response.destroy();
        });
        response.on('close', () => resolve({ status: response.statusCode ?? 0 }));
        response.on('error', () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    request.on('timeout', () => request.destroy(new Error(`no response within ${options.timeoutMs} ms`)));
    request.on('error', reject);
    request.end(body);
  });
}
