import { z } from 'zod';
import { DriverProfile, GeoPoint, Id, makeEvent } from '@jol/contracts';
import { conflict, createHttp, notFound, runService } from '@jol/kit';
import { Registry } from './registry.js';

const NEARBY_RADIUS_KM = 3;
const NEARBY_LIMIT = 30;
const STALE_AFTER_MS = 90_000;
const SWEEP_EVERY_MS = 15_000;

const OnlineBody = DriverProfile.merge(GeoPoint);
const LocationBody = GeoPoint.extend({ id: Id, heading: z.coerce.number().nullable().optional() });

await runService(z.object({}), async ({ config, log, bus, onShutdown }) => {
  const registry = new Registry();

  const publishBestEffort = (event: Parameters<typeof bus.publish>[0]) =>
    bus.publish(event).catch(err => log.warn({ err, type: event.type }, 'presence event not published'));

  await bus.follow(
    ['jol.dispatch.order.accepted', 'jol.dispatch.order.completed', 'jol.dispatch.order.cancelled', 'jol.accounts.rating.changed'],
    event => {
      switch (event.type) {
        case 'jol.dispatch.order.accepted':
          return registry.setServing(event.data.driverId, event.data.clientId);
        case 'jol.dispatch.order.completed':
          return registry.setServing(event.data.driverId, null);
        case 'jol.dispatch.order.cancelled':
          if (event.data.driverId) registry.setServing(event.data.driverId, null);
          return;
        case 'jol.accounts.rating.changed':
          if (event.data.role === 'driver') registry.updateRating(event.data.id, event.data.rating);
          return;
      }
    },
  );

  bus.serve('fleet.candidates', async q => registry.candidates(q.point, q.tariff, q.radiusKm, q.exclude, q.limit));
  bus.serve('fleet.supply', async () => registry.supplyByZone());

  const sweep = setInterval(() => {
    for (const id of registry.sweepStale(STALE_AFTER_MS)) {
      log.info({ driverId: id }, 'driver went silent, marked offline');
      void publishBestEffort(makeEvent('jol.fleet.driver.offline', { driverId: id }));
    }
  }, SWEEP_EVERY_MS);
  onShutdown(() => clearInterval(sweep));

  const http = createHttp(log, { nats: async () => void (await bus.nc.flush()) });

  http.post('/api/driver/online', async req => {
    const body = OnlineBody.parse(req.body);
    const { lat, lon, ...profile } = body;
    const account = await bus.request('accounts.driver.register', profile);
    const { earned: _earned, ...card } = account;
    const wasOnline = !!registry.get(card.id);
    registry.goOnline(card, { lat, lon });
    if (!wasOnline) void publishBestEffort(makeEvent('jol.fleet.driver.online', { driverId: card.id, tariff: card.tariff }));
    return account;
  });

  http.post('/api/driver/offline', async req => {
    const { id } = z.object({ id: Id }).parse(req.body);
    if (registry.servingClient(id)) throw conflict('Сначала завершите заказ');
    if (registry.goOffline(id)) void publishBestEffort(makeEvent('jol.fleet.driver.offline', { driverId: id }));
    return { ok: true };
  });

  http.post('/api/driver/location', async req => {
    const body = LocationBody.parse(req.body);
    const p = registry.updateLocation(body.id, body);
    if (!p) throw notFound('Водитель не на линии');
    const clientId = registry.servingClient(body.id);
    if (clientId) bus.notify('client', clientId, 'driver_location', registry.view(body.id));
    return { ok: true };
  });

  http.get('/api/drivers/nearby', async req => registry.nearbyFree(GeoPoint.parse(req.query), NEARBY_RADIUS_KM, NEARBY_LIMIT));

  await http.listen({ host: '0.0.0.0', port: config.PORT });
  onShutdown(() => http.close());

  try {
    for (const a of await bus.request('dispatch.assignments', {})) registry.setServing(a.driverId, a.clientId);
  } catch (err) {
    log.warn({ err }, 'could not restore assignments from dispatch; drivers will re-sync on next order event');
  }
});
