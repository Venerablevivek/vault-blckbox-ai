/**
 * OpenTelemetry tracing, on only when OTEL_EXPORTER_OTLP_ENDPOINT is set (the standard variable;
 * OTEL_SERVICE_NAME names the process). Imported first by main.ts and worker.ts, so the HTTP,
 * Fastify and PostgreSQL libraries are instrumented before anything loads them.
 *
 * Share and invitation tokens appear in URL paths, so every span attribute and name passes
 * through the same redaction as the logs before it leaves the process.
 */
import FastifyOtelInstrumentation from '@fastify/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { BatchSpanProcessor, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { redactTokens } from '../lib/logger';

/** Rewrites token-shaped strings in a finished span, before the batch processor exports it. */
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Record<string, unknown>;
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === 'string') attributes[key] = redactTokens(value);
    }
    (span as { name: string }).name = redactTokens(span.name);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const QUIET = new Set(['/health', '/ready']);

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    spanProcessors: [new RedactingSpanProcessor(), new BatchSpanProcessor(new OTLPTraceExporter())],
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => QUIET.has(request.url ?? '') }),
      // Statements are recorded with their $1 placeholders, never the values.
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });
  sdk.start();
  const stop = () => void sdk.shutdown().catch(() => undefined);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
