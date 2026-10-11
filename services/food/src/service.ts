import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GeoPoint, Id, Place, distanceKm, makeEvent, type AnyEvent, type Audience } from '@jol/contracts';
import {
  DatabaseConfig,
  badRequest,
  conflict,
  createHttp,
  createPool,
  enqueue,
  forbidden,
  handleOnce,
  migrate,
  notFound,
  defineService,
  startOutboxRelay,
  withTx,
} from '@jol/kit';
import * as repo from './repo.js';
import type { FoodOrder, Restaurant } from './repo.js';
import { MAX_DISTANCE_KM, courierTariffFor, nextCourierAttempt, priceCart } from './rules.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const COURIER_RETRY_MS = 10_000;
/** Rough city speed for a courier, minutes per km, for the ETA shown to the customer. */
const MIN_PER_KM = 4;

const PlaceOrder = z.object({
  clientId: Id,
  restaurantId: Id,
  items: z.array(z.object({ itemId: z.string().max(64), qty: z.coerce.number().int() })).min(1).max(30),
  to: Place,
  recipientName: z.string().trim().min(1).max(60),
  recipientPhone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Неверный телефон'),
  comment: z.string().max(300).default(''),
});
const OrderParams = z.object({ id: z.string().uuid() });
const ByRestaurant = z.object({ restaurantId: Id });

type ViewAudience = Extract<Audience, 'client' | 'restaurant'>;

const COURIER_EVENTS = [
  'jol.dispatch.order.accepted',
  'jol.dispatch.order.started',
  'jol.dispatch.order.completed',
  'jol.dispatch.order.cancelled',
] as const;
type CourierEvent = Extract<AnyEvent, { type: (typeof COURIER_EVENTS)[number] }>;
const isCourierEvent = (e: AnyEvent): e is CourierEvent => (COURIER_EVENTS as readonly string[]).includes(e.type);

function toView(o: FoodOrder, r: Restaurant, audience: ViewAudience) {
  const travelKm = distanceKm(r, o.to);
  return {
    id: o.id,
    status: o.status,
    restaurant: { id: r.id, name: r.name, address: r.address, lat: r.lat, lon: r.lon },
    items: o.items,
    itemsTotal: o.itemsTotal,
    deliveryFee: o.deliveryFee,
    total: o.total,
    to: o.to,
    recipientName: o.recipientName,
    comment: o.comment,
    courier: o.courier,
    courierSearching: ['cooking', 'ready'].includes(o.status) && !o.courier,
    deliveryCode: audience === 'client' ? o.deliveryCode : null,
    cancelReason: o.cancelReason,
    createdAt: o.createdAt,
    etaMinutes: Math.round(r.prepMinutes + travelKm * MIN_PER_KM + 5),
  };
}

export default defineService(DatabaseConfig, async ({ config, log, bus, onShutdown }) => {
  const pool = createPool(config.DATABASE_URL, config.DB_SCHEMA, config.DB_POOL_MAX);
  onShutdown(() => pool.end());
  await migrate(pool, config.DB_SCHEMA, MIGRATIONS, log);
  const relay = startOutboxRelay(pool, bus, log);
  onShutdown(() => relay.stop());

  const requireRestaurant = async (id: string) => {
    const r = await repo.getRestaurant(pool, id);
    if (!r) throw notFound('Ресторан не найден');
    return r;
  };

  const publish = async (o: FoodOrder) => {
    const r = await requireRestaurant(o.restaurantId);
    bus.notify('client', o.clientId, 'food', toView(o, r, 'client'));
    bus.notify('restaurant', o.restaurantId, 'food', toView(o, r, 'restaurant'));
  };

  /**
   * Books (or re-books) a courier in dispatch. Safe to call repeatedly: the request id is the
   * idempotency key there, so a retry after a timeout returns the same delivery instead of a second one.
   */
  const bookCourier = async (orderId: string) => {
    const o = await repo.getOrder(pool, orderId);
    if (!o || o.courierOrderId || !['cooking', 'ready'].includes(o.status)) return;
    const r = await requireRestaurant(o.restaurantId);
    const portions = o.items.reduce((n, l) => n + l.qty, 0);
    const delivery = await bus.request('dispatch.delivery.request', {
      externalId: o.courierRequestId,
      clientId: o.clientId,
      tariff: o.courierTariff,
      from: { lat: r.lat, lon: r.lon, label: `${r.name}, ${r.address}` },
      to: o.to,
      delivery: { item: `Заказ из «${r.name}» · ${portions} шт.`, recipientName: o.recipientName, recipientPhone: o.recipientPhone },
    });
    await repo.setCourierBooking(pool, o.id, delivery.id, delivery.delivery?.code ?? null);
    log.info({ foodOrderId: o.id, courierOrderId: delivery.id, tariff: o.courierTariff }, 'courier booked');
    await publish((await repo.getOrder(pool, o.id))!);
  };

  const ensureCouriers = async () => {
    for (const o of await repo.awaitingCourier(pool)) {
      await bookCourier(o.id).catch(err => log.warn({ err, foodOrderId: o.id }, 'courier booking failed, will retry'));
    }
  };
  const retry = setInterval(() => void ensureCouriers(), COURIER_RETRY_MS);
  onShutdown(() => clearInterval(retry));

  await bus.subscribe(
    'food',
    [...COURIER_EVENTS],
    async event => {
      if (!isCourierEvent(event) || event.data.source !== 'food') return;
      let changed: FoodOrder | null = null;
      let rebook: string | null = null;
      await handleOnce(pool, event.id, async tx => {
        const o = await repo.findByCourierOrder(tx, event.data.orderId);
        if (!o) throw new Error(`courier order ${event.data.orderId} not linked yet`);
        switch (event.type) {
          case 'jol.dispatch.order.accepted': {
            const card = await bus.request('accounts.driver.card', { id: event.data.driverId });
            if (card) await repo.setCourier(tx, o.id, { id: card.id, name: card.name, rating: card.rating, tariff: card.tariff });
            changed = await repo.getOrder(tx, o.id);
            break;
          }
          case 'jol.dispatch.order.started':
            changed = await repo.move(tx, o.id, ['cooking', 'ready'], 'delivering');
            break;
          case 'jol.dispatch.order.completed':
            changed = await repo.move(tx, o.id, ['cooking', 'ready', 'delivering'], 'delivered');
            if (changed) await enqueue(tx, makeEvent('jol.food.order.delivered', { foodOrderId: o.id, restaurantId: o.restaurantId, total: o.total }));
            break;
          case 'jol.dispatch.order.cancelled': {
            const next = nextCourierAttempt(o.courierAttempts);
            if (next) {
              await repo.startNextCourierAttempt(tx, o.id, next, randomUUID());
              rebook = o.id;
              changed = await repo.getOrder(tx, o.id);
            } else {
              changed = await repo.move(tx, o.id, ['cooking', 'ready'], 'cancelled', 'no_courier');
              if (changed) await enqueue(tx, makeEvent('jol.food.order.cancelled', { foodOrderId: o.id, restaurantId: o.restaurantId, reason: 'no_courier' }));
            }
            break;
          }
        }
      });
      relay.kick();
      if (changed) await publish(changed);
      if (rebook) {
        log.info({ foodOrderId: rebook }, 'no courier accepted, retrying by car');
        await bookCourier(rebook).catch(err => log.warn({ err }, 'courier re-booking failed, will retry'));
      }
    },
  );

  const http = createHttp(log, {
    postgres: async () => void (await pool.query('SELECT 1')),
    nats: async () => void (await bus.nc.flush()),
  });

  http.get('/api/food/restaurants', async req => {
    const at = GeoPoint.safeParse(req.query);
    const list = await repo.listRestaurants(pool);
    return list
      .map(r => ({ ...r, distanceKm: at.success ? distanceKm(r, at.data) : null }))
      .sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  });

  http.get('/api/food/restaurants/:id', async req => {
    const r = await requireRestaurant(Id.parse((req.params as { id: string }).id));
    return { ...r, menu: await repo.menu(pool, r.id) };
  });

  http.post('/api/food/restaurants/:id/open', async req => {
    const id = Id.parse((req.params as { id: string }).id);
    const { isOpen } = z.object({ isOpen: z.boolean() }).parse(req.body);
    await requireRestaurant(id);
    await repo.setOpen(pool, id, isOpen);
    return { ok: true };
  });

  http.get('/api/food/restaurants/:id/orders', async req => {
    const r = await requireRestaurant(Id.parse((req.params as { id: string }).id));
    return (await repo.activeForRestaurant(pool, r.id)).map(o => toView(o, r, 'restaurant'));
  });

  http.get('/api/food/orders', async req => {
    const { clientId } = z.object({ clientId: Id }).parse(req.query);
    const orders = await repo.activeForClient(pool, clientId);
    return Promise.all(orders.map(async o => toView(o, await requireRestaurant(o.restaurantId), 'client')));
  });

  http.post('/api/food/orders', async req => {
    const b = PlaceOrder.parse(req.body);
    const key = z.string().uuid().nullable().parse(req.headers['idempotency-key'] ?? null);
    const replay = async () => {
      const prev = key && (await repo.findByIdempotencyKey(pool, b.clientId, key));
      return prev ? toView(prev, await requireRestaurant(prev.restaurantId), 'client') : null;
    };
    const previous = await replay();
    if (previous) return previous;

    const r = await requireRestaurant(b.restaurantId);
    if (!r.isOpen) throw conflict('Ресторан сейчас не принимает заказы');
    const km = distanceKm(r, b.to);
    if (km > MAX_DISTANCE_KM) throw badRequest(`Ресторан доставляет в радиусе ${MAX_DISTANCE_KM} км`);

    const menu = new Map((await repo.menu(pool, r.id)).map(i => [i.id, i]));
    let cart;
    try {
      cart = priceCart(menu, b.items);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    const courierTariff = courierTariffFor(km);
    const fee = await bus.request('pricing.price', { from: { lat: r.lat, lon: r.lon }, to: b.to, tariff: courierTariff, loaders: 0, quoteId: null });

    const order = await withTx(pool, async tx => {
      const o = await repo.insertOrder(
        tx,
        {
          id: randomUUID(),
          clientId: b.clientId,
          restaurantId: r.id,
          status: 'placed',
          items: cart.lines,
          itemsTotal: cart.total,
          deliveryFee: fee.price,
          total: cart.total + fee.price,
          to: b.to,
          recipientName: b.recipientName,
          recipientPhone: b.recipientPhone,
          comment: b.comment,
          courierTariff,
          courierRequestId: randomUUID(),
          courierOrderId: null,
          courierAttempts: 1,
          courier: null,
          deliveryCode: null,
          cancelReason: null,
          createdAt: Date.now(),
        },
        key,
      );
      await enqueue(tx, makeEvent('jol.food.order.placed', { foodOrderId: o.id, clientId: o.clientId, restaurantId: r.id, total: o.total }));
      return o;
    }).catch(async err => {
      if ((err as { code?: string }).code === '23505') {
        const raced = await replay();
        if (raced) return null;
      }
      throw err;
    });
    if (!order) return (await replay())!;
    relay.kick();
    await publish(order);
    return toView(order, r, 'client');
  });

  const restaurantAction = (
    path: string,
    from: repo.FoodOrder['status'][],
    to: repo.FoodOrder['status'],
    event: (o: FoodOrder) => Parameters<typeof enqueue>[1] | null,
    after?: (o: FoodOrder) => Promise<void>,
  ) =>
    http.post(`/api/food/orders/:id/${path}`, async req => {
      const { id } = OrderParams.parse(req.params);
      const { restaurantId } = ByRestaurant.parse(req.body);
      const current = await repo.getOrder(pool, id);
      if (!current) throw notFound('Заказ не найден');
      if (current.restaurantId !== restaurantId) throw forbidden('Чужой заказ');
      const updated = await withTx(pool, async tx => {
        const o = await repo.move(tx, id, from, to, to === 'rejected' ? 'restaurant' : null);
        const e = o && event(o);
        if (e) await enqueue(tx, e);
        return o;
      });
      if (!updated) throw conflict(`Нельзя из статуса ${current.status}`);
      relay.kick();
      await publish(updated);
      if (after) await after(updated).catch(err => log.warn({ err, foodOrderId: id }, 'post-action step failed, will retry'));
      return toView(updated, await requireRestaurant(updated.restaurantId), 'restaurant');
    });

  restaurantAction(
    'accept',
    ['placed'],
    'cooking',
    o => makeEvent('jol.food.order.accepted', { foodOrderId: o.id, restaurantId: o.restaurantId }),
    o => bookCourier(o.id),
  );
  restaurantAction('reject', ['placed'], 'rejected', o =>
    makeEvent('jol.food.order.cancelled', { foodOrderId: o.id, restaurantId: o.restaurantId, reason: 'restaurant' }),
  );
  restaurantAction('ready', ['cooking'], 'ready', o => makeEvent('jol.food.order.ready', { foodOrderId: o.id, restaurantId: o.restaurantId }));

  http.post('/api/food/orders/:id/cancel', async req => {
    const { id } = OrderParams.parse(req.params);
    const { clientId } = z.object({ clientId: Id }).parse(req.body);
    const o = await repo.getOrder(pool, id);
    if (!o) throw notFound('Заказ не найден');
    if (o.clientId !== clientId) throw forbidden('Чужой заказ');
    const updated = await withTx(pool, async tx => {
      const u = await repo.move(tx, id, ['placed'], 'cancelled', 'client');
      if (u) await enqueue(tx, makeEvent('jol.food.order.cancelled', { foodOrderId: id, restaurantId: o.restaurantId, reason: 'client' }));
      return u;
    });
    if (!updated) throw conflict('Ресторан уже готовит заказ, отменить нельзя');
    relay.kick();
    await publish(updated);
    return toView(updated, await requireRestaurant(o.restaurantId), 'client');
  });

  await http.listen({ host: '0.0.0.0', port: config.PORT });
  onShutdown(() => http.close());
  await ensureCouriers();
});
