import type { FastifyInstance } from 'fastify';
import { CreateTokenBody, TokenParams } from '../../contracts/tokens';
import { currentUser, requireBrowserSession } from '../../plugins/session';
import type { ApiTokenRow } from './tokens.repo';
import type { TokensService } from './tokens.service';

const toDto = (row: ApiTokenRow) => ({
  id: row.id,
  name: row.name,
  prefix: row.token_prefix,
  scopes: row.scopes,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
});

/** A person's own API tokens. Managed from a signed-in browser only: a token can't make tokens. */
export function registerTokenRoutes(app: FastifyInstance, deps: { tokens: TokensService }): void {
  const { tokens } = deps;

  app.get('/api/auth/tokens', { preHandler: requireBrowserSession }, async (request) => ({
    tokens: (await tokens.list(currentUser(request).id)).map(toDto),
  }));

  app.post('/api/auth/tokens', {
    preHandler: requireBrowserSession,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const body = CreateTokenBody.parse(request.body);
      const { token, secret } = await tokens.create(currentUser(request), body);
      return reply.status(201).send({ token: { ...toDto(token), secret } });
    },
  });

  app.delete('/api/auth/tokens/:id', { preHandler: requireBrowserSession }, async (request, reply) => {
    const { id } = TokenParams.parse(request.params);
    await tokens.revoke(currentUser(request).id, id);
    return reply.status(204).send();
  });
}
