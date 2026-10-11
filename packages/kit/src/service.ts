import type { z } from 'zod';
import { Bus } from './bus.js';
import { BaseConfig, loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';

type Env = NodeJS.ProcessEnv;

export interface ServiceContext<C> {
  config: C;
  log: Logger;
  bus: Bus;
  onShutdown(fn: () => Promise<void> | void): void;
}

export interface ServiceDefinition<S extends z.AnyZodObject = z.AnyZodObject> {
  config: S;
  start: (ctx: ServiceContext<z.infer<typeof BaseConfig> & z.infer<S>>) => Promise<void>;
}

/** Heterogeneous list element: each definition validates its own config, so the list can erase it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyService = ServiceDefinition<any>;

export interface RunningService {
  name: string;
  stop(): Promise<void>;
}

/**
 * A service is a value, not a process: the same definition runs as its own container
 * (`runService`) or next to the others in one process (`runServices`, the lite profile).
 */
export function defineService<S extends z.AnyZodObject>(config: S, start: ServiceDefinition<S>['start']): ServiceDefinition<S> {
  return { config, start };
}

/** config → logger → NATS → `start()`. Cleanups run in reverse order on `stop()`. */
export async function startService<S extends z.AnyZodObject>(def: ServiceDefinition<S>, env: Env = process.env): Promise<RunningService> {
  const config: z.infer<typeof BaseConfig> & z.infer<S> = { ...loadConfig(BaseConfig, env), ...loadConfig(def.config, env) };
  const log = createLogger(config.SERVICE_NAME, config.LOG_LEVEL);
  const cleanups: Array<() => Promise<void> | void> = [];
  const stop = async () => {
    log.info('shutting down');
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (err) {
        log.error({ err }, 'cleanup failed');
      }
    }
  };
  try {
    const bus = await Bus.connect(config.NATS_URL, config.SERVICE_NAME, log);
    cleanups.push(() => bus.close());
    await def.start({ config, log, bus, onShutdown: fn => cleanups.push(fn) });
    log.info('service started');
  } catch (err) {
    log.fatal({ err }, 'failed to start');
    await stop();
    throw err;
  }
  return { name: config.SERVICE_NAME, stop };
}

/**
 * Starts several services in one process and stops them in reverse order on SIGTERM/SIGINT,
 * so in-flight work (HTTP, consumers, outbox) finishes cleanly before exit.
 */
export async function runServices(entries: Array<[AnyService, Env]>): Promise<void> {
  const running: RunningService[] = [];
  const shutdown = async (code: number) => {
    for (const s of running.reverse()) await s.stop();
    process.exit(code);
  };
  process.once('SIGTERM', () => void shutdown(0));
  process.once('SIGINT', () => void shutdown(0));
  try {
    for (const [def, env] of entries) running.push(await startService(def, env));
  } catch {
    await shutdown(1);
  }
}

export async function runService(def: AnyService): Promise<void> {
  await runServices([[def, process.env]]);
}
