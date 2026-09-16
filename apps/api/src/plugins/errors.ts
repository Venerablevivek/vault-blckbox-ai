import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

/**
 * One error envelope for the whole API: { error: { code, message, details? } }.
 *
 * Deliberate errors (AppError) and validation failures are reported precisely. Anything
 * else becomes an opaque 500: stack traces, SQL text and driver messages never reach a
 * client, because they describe the schema and the code to an attacker.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found.` },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed.',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    // Fastify's own typed errors (body too large, malformed JSON, rate limit).
    const fastifyError = error as { statusCode?: number; message?: string };
    const statusCode = fastifyError.statusCode;
    if (statusCode === 413) {
      return reply
        .status(413)
        .send({ error: { code: 'FILE_TOO_LARGE', message: 'File exceeds the maximum size.' } });
    }
    if (statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
      });
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send({ error: { code: 'BAD_REQUEST', message: fastifyError.message ?? 'Bad request.' } });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
  });
}
