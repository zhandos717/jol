import accounts from '@jol/accounts/service';
import dispatch from '@jol/dispatch/service';
import fleet from '@jol/fleet/service';
import food from '@jol/food/service';
import intercity from '@jol/intercity/service';
import { runServices } from '@jol/kit';
import pricing from '@jol/pricing/service';
import realtime from '@jol/realtime/service';

/**
 * Lite profile (ADR-0014): all seven services in one Node.js process. Same code, same NATS
 * events and per-service database roles; only the process boundary is gone. Each service keeps
 * its own port so the gateway routing stays identical to the full deployment.
 */
const password = process.env.SERVICE_DB_PASSWORD ?? 'jol_local_dev';
const pgHost = process.env.PG_HOST ?? 'postgres';
const db = (role: string) => ({
  DB_SCHEMA: role,
  DATABASE_URL: `postgres://${role}:${password}@${pgHost}:5432/jol`,
  DB_POOL_MAX: process.env.DB_POOL_MAX ?? '3',
});
const env = (name: string, port: number, extra: Record<string, string> = {}) => ({
  ...process.env,
  SERVICE_NAME: name,
  PORT: String(port),
  ...extra,
});

await runServices([
  [accounts, env('accounts', 8081, db('accounts'))],
  [pricing, env('pricing', 8083)],
  [dispatch, env('dispatch', 8084, db('dispatch'))],
  [fleet, env('fleet', 8082)],
  [intercity, env('intercity', 8085, db('intercity'))],
  [food, env('food', 8086, db('food'))],
  [realtime, env('realtime', 8087)],
]);
