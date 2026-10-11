import { z } from 'zod';

export const BaseConfig = z.object({
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  NATS_URL: z.string().default('nats://localhost:4222'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export const DatabaseConfig = z.object({
  DATABASE_URL: z.string().url(),
  DB_SCHEMA: z.string().regex(/^[a-z_]+$/),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
});

/** Validates environment once at startup so a misconfigured container fails fast instead of at first request. */
export function loadConfig<S extends z.ZodTypeAny>(schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
