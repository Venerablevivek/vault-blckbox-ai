import { trace } from '@opentelemetry/api';
import pino, { type LoggerOptions } from 'pino';

/**
 * Bearer tokens must never reach the logs. Session cookies and share/invite tokens are
 * stripped both by key (cookie, authorization, password) and by pattern, because a
 * share token also appears inside URLs (`/api/shares/shr_...`).
 */
const TOKEN_PATTERN = /\b(shr|fsh|inv|ses|pwr|evt|vlt|whsec)_[A-Za-z0-9_-]{16,}/g;

function redactTokens(value: string): string {
  return value.replace(TOKEN_PATTERN, '$1_[REDACTED]');
}

export function buildLoggerOptions(env: string): LoggerOptions {
  return {
    level: env === 'test' ? 'silent' : env === 'production' ? 'info' : 'debug',
    // With tracing on, every log line names its trace, so logs and traces can be joined.
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const { traceId, spanId } = span.spanContext();
      return { trace_id: traceId, span_id: spanId };
    },
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        'body.password',
        '*.password',
        '*.token',
        '*.currentPassword',
        '*.newPassword',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req(req: { method: string; url: string; id: string }) {
        return { method: req.method, url: redactTokens(req.url), id: req.id };
      },
    },
    ...(env === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  };
}

export { pino, redactTokens };
