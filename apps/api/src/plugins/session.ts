import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { Errors } from '../lib/errors';
import type { AuthService } from '../modules/auth/auth.service';
import type { TokensService } from '../modules/tokens/tokens.service';
import type { SessionUser } from '../types';

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Reads the credential and attaches `request.user`: an API token (Authorization: Bearer ...) if
 * one is sent, otherwise the session cookie.
 *
 * Registered as an onRequest hook for the whole app, but it never rejects: it only
 * resolves identity. Enforcement is `requireSession`, applied per route, so the public
 * share and invitation routes can simply not use it.
 */
export function registerSession(app: FastifyInstance, config: Config, auth: AuthService, tokens: TokensService): void {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('membership', null);
  app.decorateRequest('apiToken', null);
  app.decorateRequest('badToken', false);

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    if (header) {
      // An explicit credential wins over a cookie, and a bad one is never quietly ignored.
      const secret = BEARER.exec(header)?.[1];
      const resolved = secret ? await tokens.resolve(secret) : null;
      if (!resolved) {
        request.badToken = true;
        return;
      }
      request.user = resolved.user;
      request.apiToken = { id: resolved.tokenId, scopes: resolved.scopes };
      return;
    }
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (!token) return;
    const resolved = await auth.resolveSession(token);
    if (!resolved) return;
    request.user = resolved.user;
    request.sessionId = resolved.sessionId;
  });
}

/**
 * preHandler for routes that require an authenticated user, by session or API token. A token
 * with only the read scope may only read.
 */
export async function requireSession(request: FastifyRequest): Promise<void> {
  if (request.badToken) {
    throw Errors.credentialRequired('INVALID_TOKEN', 'The API token is not valid: unknown, revoked or expired.');
  }
  if (!request.user) throw Errors.unauthorized();
  if (request.apiToken && !SAFE_METHODS.has(request.method) && !request.apiToken.scopes.includes('write')) {
    throw Errors.forbidden('This API token can only read. Create one with write access to make changes.');
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * preHandler for the account's own security (password, sessions, API tokens) and other actions
 * that need a person in a browser: an API token is refused even with write access.
 */
export async function requireBrowserSession(request: FastifyRequest): Promise<void> {
  await requireSession(request);
  if (request.apiToken) throw Errors.forbidden('Sign in to do this; API tokens cannot.');
}

export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw Errors.unauthorized();
  return request.user;
}

export function currentSessionId(request: FastifyRequest): string {
  if (!request.sessionId) throw Errors.unauthorized();
  return request.sessionId;
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expiresAt: Date): void {
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true, // not readable by JavaScript, so XSS cannot exfiltrate it
    sameSite: 'lax', // blocks cross-site form-post CSRF
    secure: config.SESSION_COOKIE_SECURE,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
}
