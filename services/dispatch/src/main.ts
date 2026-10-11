import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GeoPoint, Id, MAX_LOADERS, Review, TARIFF_KIND, TariffId, makeEvent, type AnyEvent } from '@jol/contracts';
import {
  DatabaseConfig,
  badRequest,
  conflict,
  createHttp,
  createPool,
  enqueue,
  forbidden,
  migrate,
  notFound,
  runService,
  startOutboxRelay,
  withTx,
} from '@jol/kit';
import { Dispatcher } from './dispatcher.js';
import * as repo from './repo.js';
import type { Order } from './repo.js';
import { DRIVER_ACTIONS, type DriverAction } from './state.js';
import { toView } from './views.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const SCHEDULE_LEAD_MS = 30 * 60 * 1000;
const SCHEDULER_TICK_MS = 15_000;
const RECENT_PLACES = 8;

const CreateOrder = z.object({
  clientId: Id,
  tariff: TariffId,
  from: GeoPoint,
  to: GeoPoint,
  fromLabel: z.string().max(200).default(''),
  toLabel: z.string().max(200).default(''),
  loaders: z.coerce.number().int().min(0).max(MAX_LOADERS).default(0),
  cargoNote: z.string().max(300).default(''),
  departAt: z.string().datetime({ offset: true }).nullish(),
  quoteId: z.string().uuid().nullish(),
});
const OrderParams = z.object({ id: z.string().uuid() });
const IdempotencyKey = z.string().uuid().nullable();
const ByDriver = z.object({ driverId: Id });
const RateBody = z.object({
  by: z.enum(['client', 'driver']),
  id: Id,
  stars: z.coerce.number().int().min(1).max(5),
  tags: z.array(z.string().max(40)).max(5).default([]),
  comment: z.string().max(300).default(''),
});

const ref = (o: Order) => ({ orderId: o.id, clientId: o.clientId, driverId: o.driverId });

await runService(DatabaseConfig, async ({ config, log, bus, onShutdown }) => {
  const pool = createPool(config.DATABASE_URL, config.DB_SCHEMA);
  onShutdown(() => pool.end());
  await migrate(pool, config.DB_SCHEMA, MIGRATIONS, log);

  const relay = startOutboxRelay(pool, bus, log);
  onShutdown(() => relay.stop());
  const dispatcher = new Dispatcher(pool, bus, relay, log);
  onShutdown(() => dispatcher.shutdown());

  const broadcast = (o: Order) => {
    const view = toView(o, dispatcher.offerFor(o.id));
    bus.notify('client', o.clientId, 'order', view);
    if (o.driverId) bus.notify('driver', o.driverId, 'order', view);
  };

  /** Applies a status change and its event atomically; null means the caller lost a race. */
  const move = async (
    id: string,
    to: Parameters<typeof repo.transition>[2],
    event: (o: Order) => AnyEvent | null,
    patch?: Parameters<typeof repo.transition>[3],
  ) => {
    const updated = await withTx(pool, async tx => {
      const o = await repo.transition(tx, id, to, patch);
      const e = o && event(o);
      if (e) await enqueue(tx, e);
      return o;
    });
    if (updated) relay.kick();
    return updated;
  };

  const requireOrder = async (id: string) => {
    const o = await repo.get(pool, id);
    if (!o) throw notFound('Заказ не найден');
    return o;
  };

  bus.serve('dispatch.assignments', async () =>
    (await repo.listActive(pool))
      .filter(o => o.driverId && ['accepted', 'arrived', 'in_progress'].includes(o.status))
      .map(o => ({ driverId: o.driverId!, clientId: o.clientId, orderId: o.id })),
  );

  bus.serve('dispatch.snapshot', async ({ role, id }) => {
    const active = await repo.activeFor(pool, role, id);
    let offer = null;
    if (role === 'driver') {
      const pending = dispatcher.offerForDriver(id);
      const o = pending && (await repo.get(pool, pending.orderId));
      if (o && pending) offer = { ...toView(o, pending.offer), pickupKm: pending.offer.pickupKm };
    }
    return { order: active && toView(active, dispatcher.offerFor(active.id)), offer };
  });

  const http = createHttp(log, {
    postgres: async () => void (await pool.query('SELECT 1')),
    nats: async () => void (await bus.nc.flush()),
  });

  /**
   * Retried taps (double click, flaky mobile network) carry the same Idempotency-Key and get the
   * original order back with 200. Different taps while an order is active get 409.
   */
  http.post('/api/orders', async req => {
    const b = CreateOrder.parse(req.body);
    const key = IdempotencyKey.parse(req.headers['idempotency-key'] ?? null);
    const replay = async () => {
      const existing = key && (await repo.findByIdempotencyKey(pool, b.clientId, key));
      return existing ? toView(existing, dispatcher.offerFor(existing.id)) : null;
    };
    const previous = await replay();
    if (previous) return previous;
    if (await repo.activeFor(pool, 'client', b.clientId)) throw conflict('У вас уже есть активный заказ');
    const departAt = b.departAt ? Date.parse(b.departAt) : null;
    if (departAt && departAt < Date.now() - 60_000) throw badRequest('Время выезда в прошлом');

    const [quote, rider] = await Promise.all([
      bus.request('pricing.price', { from: b.from, to: b.to, tariff: b.tariff, loaders: b.loaders, quoteId: b.quoteId ?? null }),
      bus.request('accounts.rider.card', { id: b.clientId }).catch(err => {
        log.warn({ err }, 'accounts unavailable, ordering with default rider card');
        return { id: b.clientId, rating: 5, trips: 0 };
      }),
    ]);
    const isCargo = TARIFF_KIND[b.tariff] === 'cargo';
    const scheduled = departAt !== null && departAt - SCHEDULE_LEAD_MS > Date.now();

    const created = await withTx(pool, async tx => {
      const o = await repo.insert(tx, {
        id: randomUUID(),
        clientId: b.clientId,
        driverId: null,
        tariff: b.tariff,
        status: scheduled ? 'scheduled' : 'searching',
        from: b.from,
        to: b.to,
        fromLabel: b.fromLabel,
        toLabel: b.toLabel,
        km: quote.km,
        min: quote.min,
        price: quote.price,
        surge: quote.surge,
        loaders: isCargo ? b.loaders : 0,
        cargoNote: isCargo ? b.cargoNote : '',
        departAt,
        declined: [],
        driver: null,
        client: { rating: rider.rating, trips: rider.trips },
        driverReview: null,
        clientReview: null,
        createdAt: Date.now(),
        searchStartedAt: null,
      }, key);
      await enqueue(tx, makeEvent('jol.dispatch.order.created', { ...ref(o), tariff: o.tariff, from: o.from, price: o.price, surge: o.surge }));
      return o;
    }).catch(async err => {
      if ((err as { code?: string }).code !== '23505') throw err;
      const raced = await replay();
      if (raced) return null;
      throw conflict('У вас уже есть активный заказ');
    });
    if (!created) return (await replay())!;
    const order = created;
    relay.kick();
    if (order.status === 'searching') void dispatcher.run(order.id);
    return toView(order);
  });

  http.post('/api/orders/:id/cancel', async req => {
    const { id } = OrderParams.parse(req.params);
    const { clientId } = z.object({ clientId: Id }).parse(req.body);
    const o = await requireOrder(id);
    if (o.clientId !== clientId) throw forbidden('Чужой заказ');
    const updated = await move(id, 'cancelled', u => makeEvent('jol.dispatch.order.cancelled', { ...ref(u), reason: 'client' }));
    if (!updated) throw conflict('Заказ уже нельзя отменить');
    dispatcher.stop(id);
    dispatcher.release(updated.driverId);
    broadcast(updated);
    return toView(updated);
  });

  http.post('/api/orders/:id/accept', async req => {
    const { id } = OrderParams.parse(req.params);
    const { driverId } = ByDriver.parse(req.body);
    const offer = dispatcher.takeOffer(id, driverId);
    if (!offer) throw conflict('Предложение уже неактуально');
    const updated = await move(id, 'accepted', u => makeEvent('jol.dispatch.order.accepted', { ...ref(u), driverId }), {
      driverId,
      driver: offer.driver,
    });
    if (!updated) throw conflict('Заказ уже отменён');
    dispatcher.markEngaged(driverId);
    broadcast(updated);
    return toView(updated);
  });

  http.post('/api/orders/:id/decline', async req => {
    const { id } = OrderParams.parse(req.params);
    const { driverId } = ByDriver.parse(req.body);
    await dispatcher.decline(id, driverId);
    return { ok: true };
  });

  const EVENT_FOR: Record<DriverAction, (o: Order) => AnyEvent> = {
    arrived: o => makeEvent('jol.dispatch.order.arrived', { ...ref(o), driverId: o.driverId! }),
    start: o => makeEvent('jol.dispatch.order.started', { ...ref(o), driverId: o.driverId! }),
    finish: o => makeEvent('jol.dispatch.order.completed', { ...ref(o), driverId: o.driverId!, price: o.price, tariff: o.tariff }),
  };

  for (const action of Object.keys(DRIVER_ACTIONS) as DriverAction[]) {
    http.post(`/api/orders/:id/${action}`, async req => {
      const { id } = OrderParams.parse(req.params);
      const { driverId } = ByDriver.parse(req.body);
      const o = await requireOrder(id);
      if (o.driverId !== driverId) throw forbidden('Чужой заказ');
      const updated = await move(id, DRIVER_ACTIONS[action], EVENT_FOR[action]);
      if (!updated) throw conflict(`Нельзя из статуса ${o.status}`);
      if (updated.status === 'done') dispatcher.release(driverId);
      broadcast(updated);
      return toView(updated);
    });
  }

  http.post('/api/orders/:id/rate', async req => {
    const { id } = OrderParams.parse(req.params);
    const b = RateBody.parse(req.body);
    const o = await requireOrder(id);
    if (o.status !== 'done') throw conflict('Оценить можно только завершённую поездку');
    if ((b.by === 'client' ? o.clientId : o.driverId) !== b.id) throw forbidden('Чужой заказ');
    const review = Review.parse({ stars: b.stars, tags: b.tags, comment: b.comment, at: Date.now() });
    const targetRole = b.by === 'client' ? 'driver' : 'client';
    const targetId = targetRole === 'driver' ? o.driverId! : o.clientId;
    const updated = await withTx(pool, async tx => {
      const u = await repo.setReview(tx, id, b.by === 'client' ? 'driver_review' : 'client_review', review);
      if (u) await enqueue(tx, makeEvent('jol.dispatch.order.rated', { orderId: id, targetRole, targetId, stars: b.stars }));
      return u;
    });
    if (!updated) throw conflict('Оценка уже поставлена');
    relay.kick();
    return { ok: true };
  });

  http.get('/api/places/recent', async req => {
    const { clientId } = z.object({ clientId: Id }).parse(req.query);
    const seen = new Set<string>();
    const places = [];
    for (const o of await repo.recentDone(pool, clientId, 30)) {
      for (const p of [{ ...o.to, label: o.toLabel }, { ...o.from, label: o.fromLabel }]) {
        const key = p.label || `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        places.push({ lat: p.lat, lon: p.lon, label: p.label, usedAt: o.createdAt });
      }
    }
    return places.slice(0, RECENT_PLACES);
  });

  const promoteScheduled = async () => {
    for (const due of await repo.dueScheduled(pool, SCHEDULE_LEAD_MS)) {
      const updated = await move(due.id, 'searching', () => null);
      if (!updated) continue;
      broadcast(updated);
      void dispatcher.run(updated.id);
    }
  };
  const scheduler = setInterval(() => void promoteScheduled().catch(err => log.error({ err }, 'scheduler failed')), SCHEDULER_TICK_MS);
  onShutdown(() => clearInterval(scheduler));

  for (const o of await repo.listActive(pool)) {
    if (o.driverId && ['accepted', 'arrived', 'in_progress'].includes(o.status)) dispatcher.markEngaged(o.driverId);
    if (o.status === 'searching') void dispatcher.run(o.id);
  }
  await promoteScheduled();

  await http.listen({ host: '0.0.0.0', port: config.PORT });
  onShutdown(() => http.close());
});
