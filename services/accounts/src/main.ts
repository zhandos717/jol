import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Id, makeEvent } from '@jol/contracts';
import { DatabaseConfig, createHttp, createPool, enqueue, handleOnce, migrate, runService, startOutboxRelay } from '@jol/kit';
import * as repo from './repo.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

await runService(DatabaseConfig, async ({ config, log, bus, onShutdown }) => {
  const pool = createPool(config.DATABASE_URL, config.DB_SCHEMA);
  onShutdown(() => pool.end());
  await migrate(pool, config.DB_SCHEMA, MIGRATIONS, log);

  const relay = startOutboxRelay(pool, bus, log);
  onShutdown(() => relay.stop());

  bus.serve('accounts.driver.register', profile => repo.upsertDriver(pool, profile));
  bus.serve('accounts.driver.card', async ({ id }) => {
    const account = await repo.findDriver(pool, id);
    return account && repo.toCard(account);
  });
  bus.serve('accounts.rider.card', ({ id }) => repo.findRider(pool, id));

  await bus.subscribe(
    'accounts',
    ['jol.dispatch.order.completed', 'jol.dispatch.order.rated', 'jol.intercity.trip.completed'],
    async event => {
      await handleOnce(pool, event.id, async tx => {
        switch (event.type) {
          case 'jol.dispatch.order.completed': {
            await repo.addDriverEarnings(tx, event.data.driverId, event.data.price);
            await repo.addRiderTrip(tx, event.data.clientId);
            break;
          }
          case 'jol.intercity.trip.completed': {
            await repo.addDriverEarnings(tx, event.data.driverId, event.data.earned);
            break;
          }
          case 'jol.dispatch.order.rated': {
            const d = event.data;
            const rating = await repo.addRating(tx, d.targetRole, d.targetId, d.stars);
            if (!Number.isNaN(rating)) {
              await enqueue(tx, makeEvent('jol.accounts.rating.changed', { role: d.targetRole, id: d.targetId, rating }));
            }
            break;
          }
        }
      });
      relay.kick();
    },
  );

  const http = createHttp(log, { postgres: async () => void (await pool.query('SELECT 1')) });
  http.get('/api/me', async req => {
    const q = z.object({ role: z.enum(['driver', 'client']), id: Id }).parse(req.query);
    if (q.role === 'client') return repo.findRider(pool, q.id);
    const account = await repo.findDriver(pool, q.id);
    return account ?? { rating: 5, trips: 0, earned: 0 };
  });

  await http.listen({ host: '0.0.0.0', port: config.PORT });
  onShutdown(() => http.close());
});
