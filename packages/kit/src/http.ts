import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from './errors.js';
import type { Logger } from './logger.js';

export type ReadinessCheck = () => Promise<void>;

/**
 * Fastify with the conventions every service shares: request id propagated from the gateway,
 * `/healthz` (liveness) and `/readyz` (dependencies), and one error mapping for domain/validation errors.
 */
export function createHttp(log: Logger, checks: Record<string, ReadinessCheck> = {}) {
  const app = Fastify({
    loggerInstance: log,
    disableRequestLogging: true,
    genReqId: req => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    bodyLimit: 64 * 1024,
  });

  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.addHook('onResponse', (req, reply, done) => {
    if (req.url.startsWith('/healthz') || req.url.startsWith('/readyz')) return done();
    req.log.info({ method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
    done();
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    const results = await Promise.allSettled(Object.values(checks).map(c => c()));
    const failed = Object.keys(checks).filter((_, i) => results[i]?.status === 'rejected');
    return reply.code(failed.length ? 503 : 200).send({ ok: !failed.length, failed });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request' });
    }
    if (err instanceof DomainError) {
      if (err.status >= 500) req.log.error({ err }, 'dependency failure');
      return reply.code(err.status).send({ error: err.message, code: err.code });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal error' });
  });

  return app;
}

export type HttpApp = ReturnType<typeof createHttp>;
