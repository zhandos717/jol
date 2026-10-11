import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type { Logger } from './logger.js';

export type Pool = pg.Pool;
export type DbClient = pg.PoolClient;

/** Each service owns exactly one schema; search_path pins every connection to it. */
export function createPool(url: string, schema: string, max = 10): Pool {
  const pool = new pg.Pool({ connectionString: url, max });
  pool.on('connect', client => {
    void client.query(`SET search_path TO ${schema}`);
  });
  return pool;
}

export async function withTx<T>(pool: Pool, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies `migrations/*.sql` in lexical order, each in its own transaction.
 * A cluster-wide advisory lock keyed by schema keeps concurrent replicas from racing.
 */
export async function migrate(pool: Pool, schema: string, dir: string, log: Logger): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [schema]);
    const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    if (!exists.rowCount) await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      COMMENT ON TABLE schema_migrations IS 'Applied SQL migrations of this service';
      COMMENT ON COLUMN schema_migrations.name IS 'Migration file name';
      COMMENT ON COLUMN schema_migrations.applied_at IS 'When the migration was applied';
    `);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log.info({ file }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [schema]).catch(() => {});
    client.release();
  }
}
