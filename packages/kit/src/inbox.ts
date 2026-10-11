import type { DbClient, Pool } from './db.js';
import { withTx } from './db.js';

/**
 * Idempotent consumer: records the event id and applies the handler in one transaction.
 * A redelivered event finds its id already present and is skipped.
 *
 * Requires an `inbox` table in the service schema.
 */
export async function handleOnce(pool: Pool, eventId: string, fn: (client: DbClient) => Promise<void>): Promise<boolean> {
  return withTx(pool, async client => {
    const { rowCount } = await client.query('INSERT INTO inbox (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
    if (!rowCount) return false;
    await fn(client);
    return true;
  });
}
