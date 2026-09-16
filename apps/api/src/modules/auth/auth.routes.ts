import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config';
import {
  clearSessionCookie,
  currentUser,
  requireSession,
  setSessionCookie,
} from '../../plugins/session';
import type { AuthService } from './auth.service';

const credentials = z.object({
  email: z.string().email().max(255),
  // 8 characters is the floor; Argon2id does the heavy lifting from there.
  password: z.string().min(8).max(200),
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
      const { user, session } = await auth.register(body);
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return reply.status(201).send({ user });
    },
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const body = credentials.parse(request.body);
      const { user, session } = await auth.login(body);
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
}
