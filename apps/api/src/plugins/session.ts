import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { Errors } from '../lib/errors';
import type { AuthService } from '../modules/auth/auth.service';
import type { SessionUser } from '../types';

/**
 * Reads the session cookie and attaches `request.user`.
 *
 * Registered as an onRequest hook for the whole app, but it never rejects: it only
 * resolves identity. Enforcement is `requireSession`, applied per route, so the public
 * share and invitation routes can simply not use it.
 */
export function registerSession(app: FastifyInstance, config: Config, auth: AuthService): void {
  app.decorateRequest('user', null);
  app.decorateRequest('membership', null);

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (!token) return;
    request.user = await auth.resolveSession(token);
  });
}

/** preHandler for routes that require an authenticated user. */
export async function requireSession(request: FastifyRequest): Promise<void> {
  if (!request.user) throw Errors.unauthorized();
}

export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw Errors.unauthorized();
  return request.user;
}

export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,      // not readable by JavaScript, so XSS cannot exfiltrate it
    sameSite: 'lax',     // blocks cross-site form-post CSRF
    secure: config.SESSION_COOKIE_SECURE,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
}
