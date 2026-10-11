import type { z } from 'zod';
import { Bus } from './bus.js';
import { BaseConfig, loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';

export interface ServiceContext<C> {
  config: C;
  log: Logger;
  bus: Bus;
  onShutdown(fn: () => Promise<void> | void): void;
}

/**
 * Bootstraps a service: config → logger → NATS → `start()`, and tears everything down
 * in reverse order on SIGTERM/SIGINT so in-flight work (HTTP, consumers, outbox) finishes cleanly.
 */
export async function runService<S extends z.AnyZodObject>(
  extraConfig: S,
  start: (ctx: ServiceContext<z.infer<typeof BaseConfig> & z.infer<S>>) => Promise<void>,
): Promise<void> {
  const config: z.infer<typeof BaseConfig> & z.infer<S> = { ...loadConfig(BaseConfig), ...loadConfig(extraConfig) };
  const log = createLogger(config.SERVICE_NAME, config.LOG_LEVEL);
  const cleanups: Array<() => Promise<void> | void> = [];

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (err) {
        log.error({ err }, 'cleanup failed');
      }
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  try {
    const bus = await Bus.connect(config.NATS_URL, config.SERVICE_NAME, log);
    cleanups.push(() => bus.close());
    await start({ config, log, bus, onShutdown: fn => cleanups.push(fn) });
    log.info('service started');
  } catch (err) {
    log.fatal({ err }, 'failed to start');
    process.exit(1);
  }
}
