import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DriverProfile, GeoPoint, Id, Place, distanceKm, makeEvent } from '@jol/contracts';
import {
  DatabaseConfig,
  badRequest,
  conflict,
  createHttp,
  createOsrm,
  createPool,
  enqueue,
  forbidden,
  migrate,
  notFound,
  runService,
  startOutboxRelay,
  withTx,
} from '@jol/kit';
import * as repo from './repo.js';
import type { Trip } from './repo.js';
import { MAX_SEATS, MIN_SEAT_PRICE, SAME_CITY_KM, TRIP_TRANSITIONS, canBook, suggestSeatPrice, type TripStatus } from './rules.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const DAY_MS = 86_400_000;

const Viewer = z.object({ role: z.enum(['client', 'driver']), id: Id });
type Viewer = z.infer<typeof Viewer>;

const Publish = z.object({
  driver: DriverProfile,
  from: Place,
  to: Place,
  departAt: z.string().datetime({ offset: true }),
  seats: z.coerce.number().int().min(1).max(MAX_SEATS),
  pricePerSeat: z.coerce.number().int().min(MIN_SEAT_PRICE),
  comment: z.string().max(300).default(''),
});
const TripParams = z.object({ id: z.string().uuid() });

function toView(t: Trip, viewer?: Viewer) {
  const isOwner = viewer?.role === 'driver' && viewer.id === t.driverId;
  const mine = viewer?.role === 'client' ? t.bookings.find(b => b.clientId === viewer.id) : undefined;
  return {
    id: t.id,
    from: t.from,
    to: t.to,
    departAt: t.departAt,
    seats: t.seats,
    seatsLeft: t.seats - repo.seatsTaken(t),
    pricePerSeat: t.pricePerSeat,
    km: t.km,
    hours: t.hours,
    comment: t.comment,
    status: t.status,
    driver: t.driver,
    bookings: isOwner ? t.bookings.map(b => ({ seats: b.seats, rating: b.rider.rating })) : undefined,
    myBooking: viewer?.role === 'client' ? (mine ? { seats: mine.seats } : null) : undefined,
  };
}

await runService(DatabaseConfig.extend({ OSRM_URL: z.string().url() }), async ({ config, log, bus, onShutdown }) => {
  const pool = createPool(config.DATABASE_URL, config.DB_SCHEMA);
  onShutdown(() => pool.end());
  await migrate(pool, config.DB_SCHEMA, MIGRATIONS, log);
  const relay = startOutboxRelay(pool, bus, log);
  onShutdown(() => relay.stop());
  const osrm = createOsrm(config.OSRM_URL);

  const notifyAll = (t: Trip) => {
    bus.notify('driver', t.driverId, 'trip', toView(t, { role: 'driver', id: t.driverId }));
    for (const b of t.bookings) bus.notify('client', b.clientId, 'trip', toView(t, { role: 'client', id: b.clientId }));
  };

  const requireTrip = async (id: string) => {
    const t = await repo.get(pool, id);
    if (!t) throw notFound('Рейс не найден');
    return t;
  };

  const http = createHttp(log, { postgres: async () => void (await pool.query('SELECT 1')) });

  http.get('/api/trips/suggest-price', async req => {
    const q = z.object({ fromLat: z.coerce.number(), fromLon: z.coerce.number(), toLat: z.coerce.number(), toLon: z.coerce.number() }).parse(req.query);
    const route = await osrm.route({ lat: q.fromLat, lon: q.fromLon }, { lat: q.toLat, lon: q.toLon });
    return { km: route.km, hours: route.min / 60, pricePerSeat: suggestSeatPrice(route.km) };
  });

  http.post('/api/trips', async req => {
    const b = Publish.parse(req.body);
    const departAt = Date.parse(b.departAt);
    if (departAt <= Date.now()) throw badRequest('Время выезда должно быть в будущем');
    if (distanceKm(b.from, b.to) < SAME_CITY_KM) throw badRequest('Города совпадают');
    const [account, route] = await Promise.all([bus.request('accounts.driver.register', b.driver), osrm.route(b.from, b.to)]);
    const { earned: _earned, ...driver } = account;
    const trip = await withTx(pool, async tx => {
      const t = await repo.insert(tx, {
        id: randomUUID(),
        driverId: driver.id,
        from: b.from,
        to: b.to,
        departAt,
        seats: b.seats,
        pricePerSeat: Math.round(b.pricePerSeat / 10) * 10,
        km: route.km,
        hours: route.min / 60,
        comment: b.comment,
        driver,
      });
      await enqueue(tx, makeEvent('jol.intercity.trip.published', { tripId: t.id, driverId: t.driverId, departAt, seats: t.seats }));
      return t;
    });
    relay.kick();
    return toView(trip, { role: 'driver', id: driver.id });
  });

  http.get('/api/trips/search', async req => {
    const q = z
      .object({
        clientId: Id.optional(),
        fromLat: z.coerce.number(),
        fromLon: z.coerce.number(),
        toLat: z.coerce.number(),
        toLon: z.coerce.number(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        seats: z.coerce.number().int().min(1).default(1),
      })
      .parse(req.query);
    const from: GeoPoint = { lat: q.fromLat, lon: q.fromLon };
    const to: GeoPoint = { lat: q.toLat, lon: q.toLon };
    const dayStart = q.date ? Date.parse(`${q.date}T00:00:00+05:00`) : Date.now();
    const dayEnd = q.date ? dayStart + DAY_MS : Date.now() + 30 * DAY_MS;
    const viewer: Viewer | undefined = q.clientId ? { role: 'client', id: q.clientId } : undefined;
    return (await repo.openBetween(pool, dayStart, dayEnd))
      .filter(t => distanceKm(t.from, from) <= SAME_CITY_KM && distanceKm(t.to, to) <= SAME_CITY_KM)
      .filter(t => t.seats - repo.seatsTaken(t) >= q.seats)
      .map(t => toView(t, viewer));
  });

  http.get('/api/trips/mine', async req => {
    const v = Viewer.parse(req.query);
    const trips = v.role === 'driver' ? await repo.activeForDriver(pool, v.id) : await repo.activeForClient(pool, v.id);
    return trips.map(t => toView(t, v));
  });

  http.post('/api/trips/:id/book', async req => {
    const { id } = TripParams.parse(req.params);
    const b = z.object({ clientId: Id, seats: z.coerce.number().int().min(1) }).parse(req.body);
    const rider = await bus.request('accounts.rider.card', { id: b.clientId }).catch(() => ({ id: b.clientId, rating: 5, trips: 0 }));
    const trip = await withTx(pool, async tx => {
      const t = await repo.get(tx, id, true);
      if (!t) throw notFound('Рейс не найден');
      if (t.status !== 'open' || t.departAt <= Date.now()) throw conflict('Рейс уже недоступен');
      if (t.bookings.some(x => x.clientId === b.clientId)) throw conflict('Вы уже забронировали этот рейс');
      if (!canBook(t.seats, repo.seatsTaken(t), b.seats)) throw conflict('Столько свободных мест нет');
      await repo.addBooking(tx, id, { clientId: b.clientId, seats: b.seats, rider: { rating: rider.rating, trips: rider.trips } });
      await enqueue(tx, makeEvent('jol.intercity.trip.booked', { tripId: id, clientId: b.clientId, seats: b.seats }));
      return (await repo.get(tx, id))!;
    });
    relay.kick();
    notifyAll(trip);
    return toView(trip, { role: 'client', id: b.clientId });
  });

  http.post('/api/trips/:id/unbook', async req => {
    const { id } = TripParams.parse(req.params);
    const { clientId } = z.object({ clientId: Id }).parse(req.body);
    const t = await requireTrip(id);
    if (t.status !== 'open') throw conflict('Рейс уже в пути');
    if (!(await repo.cancelBooking(pool, id, clientId))) throw notFound('Брони нет');
    const updated = await requireTrip(id);
    notifyAll(updated);
    return toView(updated, { role: 'client', id: clientId });
  });

  http.post('/api/trips/:id/status', async req => {
    const { id } = TripParams.parse(req.params);
    const b = z.object({ driverId: Id, status: z.enum(['departed', 'done', 'cancelled']) }).parse(req.body);
    const t = await requireTrip(id);
    if (t.driverId !== b.driverId) throw forbidden('Чужой рейс');
    if (!TRIP_TRANSITIONS[t.status].includes(b.status as TripStatus)) throw conflict(`Нельзя из статуса ${t.status}`);
    const earned = repo.seatsTaken(t) * t.pricePerSeat;
    await withTx(pool, async tx => {
      if (!(await repo.setStatus(tx, id, t.status, b.status))) throw conflict('Статус рейса уже изменился');
      if (b.status === 'done') await enqueue(tx, makeEvent('jol.intercity.trip.completed', { tripId: id, driverId: t.driverId, earned }));
      if (b.status === 'cancelled') await enqueue(tx, makeEvent('jol.intercity.trip.cancelled', { tripId: id, driverId: t.driverId }));
    });
    relay.kick();
    const updated = await requireTrip(id);
    notifyAll(updated);
    return toView(updated, { role: 'driver', id: b.driverId });
  });

  await http.listen({ host: '0.0.0.0', port: config.PORT });
  onShutdown(() => http.close());
});
