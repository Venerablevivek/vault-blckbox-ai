import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config';
import {
  clearSessionCookie,
  currentSessionId,
  currentUser,
  requireSession,
  setSessionCookie,
} from '../../plugins/session';
import type { AuthService } from './auth.service';

// 8 characters is the floor; Argon2id does the heavy lifting from there.
const password = z.string().min(8).max(200);

const credentials = z.object({
  email: z.string().email().max(255),
  password,
});

const registerBody = credentials.extend({ inviteToken: z.string().max(200).optional() });

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { config: Config; auth: AuthService },
): void {
  const { config, auth } = deps;

  app.post('/api/auth/register', {
    // Account creation is cheap to automate, so it is rate limited per IP.
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const body = registerBody.parse(request.body);
      const { user, session } = await auth.register({ ...body, userAgent: request.headers['user-agent'] });
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return reply.status(201).send({ user });
    },
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const body = credentials.parse(request.body);
      const { user, session } = await auth.login({ ...body, userAgent: request.headers['user-agent'] });
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return reply.send({ user });
    },
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    // Deleting the row is what actually ends the session; clearing the cookie is
    // housekeeping. This is the reason for server-side sessions over stateless tokens.
    if (token) await auth.logout(token);
    clearSessionCookie(reply, config);
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireSession }, async (request) => {
    const user = currentUser(request);
    const workspaces = await auth.listWorkspaces(user.id);
    return {
      user,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role })),
    };
  });

  /**
   * Always 202 with the same body, whether or not the address has an account. The work runs
   * after the response is sent, so timing doesn't reveal it either.
   */
  app.post('/api/auth/password/forgot', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const { email } = z.object({ email: z.string().email().max(255) }).parse(request.body);
      auth.requestPasswordReset(email).catch((error: unknown) => {
        request.log.error({ err: error }, 'password reset request failed');
      });
      return reply.status(202).send({
        message: 'If an account exists for that address, we sent a link to reset the password.',
      });
    },
  });

  app.post('/api/auth/password/reset', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const body = z.object({ token: z.string().min(10).max(200), password }).parse(request.body);
      const { user, session, signedOut } = await auth.resetPassword({
        ...body,
        userAgent: request.headers['user-agent'],
      });
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return reply.send({ user, signedOutSessions: signedOut });
    },
  });

  app.post('/api/auth/password', {
    preHandler: requireSession,
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request) => {
      const body = z
        .object({ currentPassword: z.string().min(1).max(200), newPassword: password })
        .parse(request.body);
      return auth.changePassword({
        user: currentUser(request),
        sessionId: currentSessionId(request),
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });
    },
  });

  app.get('/api/auth/sessions', { preHandler: requireSession }, async (request) => {
    return { sessions: await auth.listSessions(currentUser(request).id, currentSessionId(request)) };
  });

  // Signs out every session except this one.
  app.delete('/api/auth/sessions', { preHandler: requireSession }, async (request) => {
    const signedOut = await auth.revokeOtherSessions(currentUser(request).id, currentSessionId(request));
    return { signedOutSessions: signedOut };
  });

  app.delete('/api/auth/sessions/:sessionId', { preHandler: requireSession }, async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const { current } = await auth.revokeSession(currentUser(request).id, sessionId, currentSessionId(request));
    // Ending the session you're using is signing out.
    if (current) clearSessionCookie(reply, config);
    return reply.status(204).send();
  });
}
