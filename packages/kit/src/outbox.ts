import type { EventEnvelope } from '@jol/contracts';
import type { Bus } from './bus.js';
import type { DbClient, Pool } from './db.js';
import type { Logger } from './logger.js';

/**
 * Transactional outbox: events are written in the same transaction as the state change,
 * then a relay publishes them. JetStream dedupes by event id, so a crash between publish
 * and marking the row only causes a harmless duplicate publish.
 *
 * Requires an `outbox` table in the service schema (see each service's migrations).
 */
export async function enqueue(client: DbClient, ...events: EventEnvelope[]): Promise<void> {
  for (const e of events) {
    await client.query('INSERT INTO outbox (id, subject, payload) VALUES ($1, $2, $3)', [e.id, e.type, JSON.stringify(e)]);
  }
}

export interface OutboxRelay {
  kick(): void;
  stop(): Promise<void>;
}

const BATCH = 100;
const IDLE_POLL_MS = 1000;

export function startOutboxRelay(pool: Pool, bus: Bus, log: Logger): OutboxRelay {
  let stopped = false;
  let wake: (() => void) | null = null;
  /** Set by kick(); a kick that arrives mid-drain must trigger another pass, not wait for the poll. */
  let pending = false;

  const drain = async () => {
    for (;;) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ id: string; payload: EventEnvelope }>(
          `SELECT id, payload FROM outbox WHERE published_at IS NULL
           ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [BATCH],
        );
        for (const row of rows) await bus.publish(row.payload);
        if (rows.length) await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1)', [rows.map(r => r.id)]);
        await client.query('COMMIT');
        if (rows.length < BATCH) return;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  };

  const loop = (async () => {
    while (!stopped) {
      pending = false;
      try {
        await drain();
      } catch (err) {
        log.error({ err }, 'outbox relay failed');
      }
      if (pending) continue;
      await new Promise<void>(resolve => {
        wake = resolve;
        setTimeout(resolve, IDLE_POLL_MS);
      });
      wake = null;
    }
  })();

  return {
    kick: () => {
      pending = true;
      wake?.();
    },
    stop: async () => {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
