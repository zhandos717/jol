import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(service: string, level = 'info'): Logger {
  return pino({ level, base: { service }, timestamp: pino.stdTimeFunctions.isoTime });
}
