const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

const PORT = process.env.PORT || 8080;
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
const FLUSH_DELAY_MS = 300;
const OFFER_TIMEOUT_MS = 15000;
const SEARCH_TIMEOUT_MS = 90000;
const SEARCH_RADIUS_KM = 15;
const INTERCITY_RADIUS_KM = 40;
const NEARBY_RADIUS_KM = 3;
const NEARBY_LIMIT = 30;
const SCHEDULE_LEAD_MS = 30 * 60 * 1000;
const MAX_SEATS = 7;
const TARIFFS = {
  eco: { name: 'Эконом', base: 400, perKm: 120, perMin: 20 },
  comfort: { name: 'Комфорт', base: 540, perKm: 162, perMin: 27 },
  business: { name: 'Бизнес', base: 840, perKm: 252, perMin: 42 },
  cargo_s: { name: 'Каблук', base: 2500, perKm: 180, perMin: 35, cargo: true },
  cargo_m: { name: 'Газель', base: 4000, perKm: 240, perMin: 45, cargo: true },
  cargo_l: { name: 'Грузовик', base: 7000, perKm: 330, perMin: 60, cargo: true },
  intercity: { name: 'Межгород', base: 3000, perKm: 95, perMin: 0, intercity: true },
};
const LOADER_PRICE = 3000;
const MAX_LOADERS = 4;
const ACTIVE = ['scheduled', 'searching', 'accepted', 'arrived', 'in_progress'];

let db = { drivers: {}, orders: {}, clients: {}, trips: {} };

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => storage.flush(db).catch(e => console.error('Ошибка сохранения в БД:', e.message)), FLUSH_DELAY_MS);
}

const streams = new Map();
function send(role, id, event, data) {
  for (const res of streams.get(`${role}:${id}`) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function osrmRoute(from, to) {
  const url = `${OSRM_URL}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const j = await (await fetch(url)).json();
  if (!j.routes?.length) throw new Error('Маршрут не найден');
  return { km: j.routes[0].distance / 1000, min: j.routes[0].duration / 60 };
}

function priceFor(r, tariff, loaders = 0, surge = 1) {
  const t = TARIFFS[tariff];
  const k = t.cargo || t.intercity ? 1 : surge;
  return Math.round((t.base + r.km * t.perKm + r.min * t.perMin) * k / 10) * 10 + loaders * LOADER_PRICE;
}

const ZONE_LAT = 0.0135, ZONE_LON = 0.0185;
const DEMAND_WINDOW_MS = 10 * 60 * 1000;
const QUOTE_WEIGHT = 0.3;
const SURGE_MAX = 2.5;
const QUOTE_TTL_MS = 3 * 60 * 1000;
const zoneOf = p => [Math.floor(p.lat / ZONE_LAT), Math.floor(p.lon / ZONE_LON)];
const isCity = tariff => !TARIFFS[tariff].cargo && !TARIFFS[tariff].intercity;

const searches = [];
const quotes = new Map();

const SURGE_CACHE_MS = 5000;
let surgeCache = { at: 0, demand: new Map(), supply: new Map() };

function bump(map, zone, by) {
  const key = zone.join(':');
  map.set(key, (map.get(key) || 0) + by);
}

function surgeBuckets() {
  if (Date.now() - surgeCache.at < SURGE_CACHE_MS) return surgeCache;
  const since = Date.now() - DEMAND_WINDOW_MS, demand = new Map(), supply = new Map();
  while (searches.length && searches[0].at < since) searches.shift();
  for (const o of Object.values(db.orders)) if (o.createdAt >= since && isCity(o.tariff)) bump(demand, zoneOf(o.from), 1);
  for (const q of searches) bump(demand, q.zone, QUOTE_WEIGHT);
  for (const d of Object.values(db.drivers)) if (d.online && !d.orderId && isCity(d.tariff)) bump(supply, zoneOf(d), 1);
  surgeCache = { at: Date.now(), demand, supply };
  return surgeCache;
}

function surgeAt(p) {
  const [zi, zj] = zoneOf(p), { demand: dm, supply: sm } = surgeBuckets();
  let demand = 0, supply = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const key = `${zi + i}:${zj + j}`;
    demand += dm.get(key) || 0;
    supply += sm.get(key) || 0;
  }
  const ratio = demand / Math.max(supply, 1);
  if (ratio <= 1) return { surge: 1, demand, supply };
  return { surge: Math.min(SURGE_MAX, Math.round((1 + (ratio - 1) * 0.5) * 10) / 10), demand, supply };
}

const NEW_USER_RATING = 5;
const rating = r => r?.ratingCount ? Math.round(r.ratingSum / r.ratingCount * 100) / 100 : NEW_USER_RATING;

function publicDriver(d) {
  return d && { id: d.id, name: d.name, car: d.car, plate: d.plate, tariff: d.tariff, lat: d.lat, lon: d.lon, heading: d.heading,
    rating: rating(d), trips: d.trips };
}

function publicOrder(o) {
  const c = db.clients[o.clientId];
  return { ...o, driver: publicDriver(db.drivers[o.driverId]), client: { rating: rating(c), trips: c?.trips || 0 } };
}

function notifyOrder(o) {
  const data = publicOrder(o);
  send('client', o.clientId, 'order', data);
  if (o.driverId) send('driver', o.driverId, 'order', data);
}

const timers = new Map();
function clearTimer(orderId) {
  clearTimeout(timers.get(orderId));
  timers.delete(orderId);
}

function dispatch(order) {
  clearTimer(order.id);
  if (order.status !== 'searching') return;

  if (Date.now() - (order.searchStartedAt || order.createdAt) > SEARCH_TIMEOUT_MS) {
    order.status = 'no_drivers';
    order.offerTo = null;
    notifyOrder(order);
    save();
    return;
  }

  const candidate = Object.values(db.drivers)
    .filter(d => d.online && !d.orderId && d.tariff === order.tariff && !order.declined.includes(d.id))
    .map(d => ({ d, dist: km(d, order.from) }))
    .filter(x => x.dist <= (TARIFFS[order.tariff].intercity ? INTERCITY_RADIUS_KM : SEARCH_RADIUS_KM))
    .sort((a, b) => a.dist - b.dist)[0];

  if (!candidate) {
    order.offerTo = null;
    timers.set(order.id, setTimeout(() => dispatch(order), 3000));
    return;
  }

  order.offerTo = candidate.d.id;
  order.offerExpiresAt = Date.now() + OFFER_TIMEOUT_MS;
  send('driver', candidate.d.id, 'offer', { ...publicOrder(order), pickupKm: candidate.dist });
  timers.set(order.id, setTimeout(() => {
    order.declined.push(candidate.d.id);
    send('driver', candidate.d.id, 'offer_expired', { id: order.id });
    dispatch(order);
  }, OFFER_TIMEOUT_MS));
}

function activeOrderOf(role, id) {
  const key = role === 'client' ? 'clientId' : 'driverId';
  return Object.values(db.orders).find(o => o[key] === id && ACTIVE.includes(o.status));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireOrder(id) {
  const o = db.orders[id];
  if (!o) throw new HttpError(404, 'Заказ не найден');
  return o;
}

function requireStatus(o, ...allowed) {
  if (!allowed.includes(o.status)) throw new HttpError(409, `Нельзя из статуса ${o.status}`);
}


function requireTrip(id) {
  const t = db.trips[id];
  if (!t) throw new HttpError(404, 'Рейс не найден');
  return t;
}

const seatsTaken = t => t.bookings.filter(b => b.status === 'active').reduce((n, b) => n + b.seats, 0);

function publicTrip(t, viewer) {
  const isDriver = viewer?.role === 'driver' && viewer.id === t.driverId;
  return {
    id: t.id, from: t.from, to: t.to, departAt: t.departAt, seats: t.seats, seatsLeft: t.seats - seatsTaken(t),
    pricePerSeat: t.pricePerSeat, km: t.km, hours: t.hours, comment: t.comment, status: t.status,
    driver: publicDriver(db.drivers[t.driverId]),
    bookings: isDriver
      ? t.bookings.filter(b => b.status === 'active').map(b => ({ seats: b.seats, rating: rating(db.clients[b.clientId]), phone: b.phone, name: b.name }))
      : undefined,
    myBooking: viewer?.role === 'client' ? t.bookings.find(b => b.clientId === viewer.id && b.status === 'active') || null : undefined,
  };
}

function notifyTrip(t) {
  send('driver', t.driverId, 'trip', publicTrip(t, { role: 'driver', id: t.driverId }));
  for (const b of t.bookings) send('client', b.clientId, 'trip', publicTrip(t, { role: 'client', id: b.clientId }));
}

function upsertDriver(body) {
  if (!body.id || !body.name || !TARIFFS[body.tariff]) throw new HttpError(400, 'Заполните профиль');
  const d = db.drivers[body.id] || { id: body.id, orderId: null, earned: 0, trips: 0, online: false };
  Object.assign(d, {
    name: String(body.name).slice(0, 50),
    car: String(body.car || '').slice(0, 50),
    plate: String(body.plate || '').slice(0, 20),
    tariff: body.tariff,
  });
  if (body.lat != null) Object.assign(d, { lat: +body.lat, lon: +body.lon });
  db.drivers[d.id] = d;
  return d;
}

const place = p => ({ lat: +p.lat, lon: +p.lon, label: String(p.label || '').slice(0, 100) });
const sameCity = (a, b) => km(a, b) <= 25;

const routes = {
  'POST /api/quote': async ({ body }) => {
    const r = await osrmRoute(body.from, body.to);
    const { surge } = surgeAt(body.from);
    searches.push({ zone: zoneOf(body.from), at: Date.now() });
    const quoteId = crypto.randomUUID();
    quotes.set(quoteId, { surge, from: body.from, expires: Date.now() + QUOTE_TTL_MS });
    for (const [id, q] of quotes) if (q.expires < Date.now()) quotes.delete(id);
    return { km: r.km, min: r.min, loaderPrice: LOADER_PRICE, surge, quoteId, quoteExpiresAt: Date.now() + QUOTE_TTL_MS,
      prices: Object.fromEntries(Object.keys(TARIFFS).map(t => [t, priceFor(r, t, 0, surge)])) };
  },

  'GET /api/surge/map': ({ query }) => {
    const c = { lat: +query.lat, lon: +query.lon }, cz = zoneOf(c), zones = [];
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) {
      const z = [cz[0] + i, cz[1] + j];
      const center = { lat: (z[0] + .5) * ZONE_LAT, lon: (z[1] + .5) * ZONE_LON };
      const { surge } = surgeAt(center);
      if (surge > 1) zones.push({ south: z[0] * ZONE_LAT, west: z[1] * ZONE_LON, north: (z[0] + 1) * ZONE_LAT, east: (z[1] + 1) * ZONE_LON, surge });
    }
    return zones;
  },

  'GET /api/drivers/nearby': ({ query }) => {
    const p = { lat: +query.lat, lon: +query.lon };
    return Object.values(db.drivers)
      .filter(d => d.online && !d.orderId && Math.abs(d.lat - p.lat) < 0.03 && Math.abs(d.lon - p.lon) < 0.04)
      .map(d => ({ d, dist: km(d, p) }))
      .filter(x => x.dist <= NEARBY_RADIUS_KM)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, NEARBY_LIMIT)
      .map(x => publicDriver(x.d));
  },

  'GET /api/places/recent': async ({ query }) => {
    const seen = new Set(), places = [];
    const trips = await storage.recentPlaces(String(query.clientId || ''), 30);
    for (const o of trips) {
      for (const p of [{ ...o.to, label: o.toLabel }, { ...o.from, label: o.fromLabel }]) {
        const key = p.label || `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        places.push({ lat: p.lat, lon: p.lon, label: p.label, usedAt: o.createdAt });
      }
    }
    return places.slice(0, 8);
  },

  'POST /api/orders': async ({ body }) => {
    if (!body.clientId || !body.from || !body.to || !TARIFFS[body.tariff]) throw new HttpError(400, 'Неверные данные заказа');
    if (activeOrderOf('client', body.clientId)) throw new HttpError(409, 'У вас уже есть активный заказ');
    const r = await osrmRoute(body.from, body.to);
    const isCargo = !!TARIFFS[body.tariff].cargo;
    const loaders = isCargo ? Math.max(0, Math.min(MAX_LOADERS, Math.floor(+body.loaders || 0))) : 0;
    const departAt = body.departAt ? +new Date(body.departAt) : null;
    if (departAt && (isNaN(departAt) || departAt < Date.now() - 60000)) throw new HttpError(400, 'Время выезда в прошлом');
    const scheduled = departAt && departAt - SCHEDULE_LEAD_MS > Date.now();
    const q = quotes.get(body.quoteId);
    const lockedSurge = q && q.expires > Date.now() && km(q.from, body.from) < 0.3 ? q.surge : null;
    const surge = isCity(body.tariff) ? lockedSurge ?? surgeAt(body.from).surge : 1;
    const order = {
      id: crypto.randomUUID(),
      clientId: body.clientId,
      from: { lat: +body.from.lat, lon: +body.from.lon },
      to: { lat: +body.to.lat, lon: +body.to.lon },
      fromLabel: String(body.fromLabel || '').slice(0, 200),
      toLabel: String(body.toLabel || '').slice(0, 200),
      tariff: body.tariff,
      km: r.km,
      min: r.min,
      surge,
      price: priceFor(r, body.tariff, loaders, surge),
      loaders,
      cargoNote: isCargo ? String(body.cargoNote || '').slice(0, 300) : '',
      departAt,
      status: scheduled ? 'scheduled' : 'searching',
      searchStartedAt: scheduled ? null : Date.now(),
      driverId: null,
      offerTo: null,
      declined: [],
      createdAt: Date.now(),
    };
    db.orders[order.id] = order;
    save();
    dispatch(order);
    return publicOrder(order);
  },

  'POST /api/orders/:id/cancel': ({ params, body }) => {
    const o = requireOrder(params.id);
    if (o.clientId !== body.clientId) throw new HttpError(403, 'Чужой заказ');
    requireStatus(o, 'scheduled', 'searching', 'accepted', 'arrived');
    clearTimer(o.id);
    if (o.offerTo) send('driver', o.offerTo, 'offer_expired', { id: o.id });
    o.status = 'cancelled';
    if (o.driverId) db.drivers[o.driverId].orderId = null;
    notifyOrder(o);
    save();
    return publicOrder(o);
  },

  'POST /api/orders/:id/accept': ({ params, body }) => {
    const o = requireOrder(params.id);
    requireStatus(o, 'searching');
    if (o.offerTo !== body.driverId) throw new HttpError(409, 'Предложение уже неактуально');
    clearTimer(o.id);
    o.status = 'accepted';
    o.driverId = body.driverId;
    o.offerTo = null;
    o.acceptedAt = Date.now();
    db.drivers[body.driverId].orderId = o.id;
    notifyOrder(o);
    save();
    return publicOrder(o);
  },

  'POST /api/orders/:id/decline': ({ params, body }) => {
    const o = requireOrder(params.id);
    if (o.status === 'searching' && o.offerTo === body.driverId) {
      o.declined.push(body.driverId);
      dispatch(o);
    }
    return { ok: true };
  },

  'POST /api/orders/:id/arrived': driverStep('accepted', 'arrived', 'arrivedAt'),
  'POST /api/orders/:id/start': driverStep('arrived', 'in_progress', 'startedAt'),
  'POST /api/orders/:id/finish': driverStep('in_progress', 'done', 'finishedAt'),

  'POST /api/orders/:id/rate': ({ params, body }) => {
    const o = requireOrder(params.id);
    requireStatus(o, 'done');
    const stars = Math.round(+body.stars);
    if (!(stars >= 1 && stars <= 5)) throw new HttpError(400, 'Оценка от 1 до 5');
    const byClient = body.by === 'client';
    if (byClient ? o.clientId !== body.id : o.driverId !== body.id) throw new HttpError(403, 'Чужой заказ');
    const field = byClient ? 'driverReview' : 'clientReview';
    if (o[field]) throw new HttpError(409, 'Оценка уже поставлена');
    o[field] = { stars, tags: (body.tags || []).slice(0, 5).map(t => String(t).slice(0, 40)), comment: String(body.comment || '').slice(0, 300), at: Date.now() };
    const target = byClient ? db.drivers[o.driverId] : (db.clients[o.clientId] ||= { ratingSum: 0, ratingCount: 0, trips: 0 });
    target.ratingSum = (target.ratingSum || 0) + stars;
    target.ratingCount = (target.ratingCount || 0) + 1;
    save();
    return { ok: true, rating: rating(target) };
  },

  'GET /api/me': ({ query }) => {
    if (query.role === 'driver') {
      const d = db.drivers[query.id];
      return { rating: rating(d), trips: d?.trips || 0, earned: d?.earned || 0 };
    }
    const c = db.clients[query.id];
    return { rating: rating(c), trips: c?.trips || 0 };
  },

  'POST /api/trips': async ({ body }) => {
    const d = upsertDriver(body.driver || {});
    const seats = Math.floor(+body.seats), price = Math.round(+body.pricePerSeat / 10) * 10, departAt = +new Date(body.departAt);
    if (!body.from?.lat || !body.to?.lat) throw new HttpError(400, 'Укажите города');
    if (!(seats >= 1 && seats <= MAX_SEATS)) throw new HttpError(400, `Мест от 1 до ${MAX_SEATS}`);
    if (!(price >= 500)) throw new HttpError(400, 'Цена за место от 500 ₸');
    if (!(departAt > Date.now())) throw new HttpError(400, 'Время выезда должно быть в будущем');
    const r = await osrmRoute(body.from, body.to);
    const t = {
      id: crypto.randomUUID(), driverId: d.id, from: place(body.from), to: place(body.to), departAt, seats,
      pricePerSeat: price, km: r.km, hours: r.min / 60, comment: String(body.comment || '').slice(0, 300),
      status: 'open', bookings: [], createdAt: Date.now(),
    };
    db.trips[t.id] = t;
    save();
    return publicTrip(t, { role: 'driver', id: d.id });
  },

  'GET /api/trips/suggest-price': async ({ query }) => {
    const r = await osrmRoute({ lat: query.fromLat, lon: query.fromLon }, { lat: query.toLat, lon: query.toLon });
    return { km: r.km, hours: r.min / 60, pricePerSeat: Math.max(1000, Math.round(r.km * 10 / 100) * 100) };
  },

  'GET /api/trips/search': ({ query }) => {
    const from = { lat: +query.fromLat, lon: +query.fromLon }, to = { lat: +query.toLat, lon: +query.toLon };
    const day = query.date ? new Date(query.date + 'T00:00:00') : null;
    const seats = Math.max(1, +query.seats || 1);
    return Object.values(db.trips)
      .filter(t => t.status === 'open' && t.departAt > Date.now() && sameCity(t.from, from) && sameCity(t.to, to))
      .filter(t => !day || (t.departAt >= +day && t.departAt < +day + 86400000))
      .filter(t => t.seats - seatsTaken(t) >= seats)
      .sort((a, b) => a.departAt - b.departAt)
      .map(t => publicTrip(t, { role: 'client', id: query.clientId }));
  },

  'GET /api/trips/mine': ({ query }) => {
    const mine = query.role === 'driver'
      ? Object.values(db.trips).filter(t => t.driverId === query.id)
      : Object.values(db.trips).filter(t => t.bookings.some(b => b.clientId === query.id && b.status === 'active'));
    return mine.filter(t => ['open', 'departed'].includes(t.status))
      .sort((a, b) => a.departAt - b.departAt)
      .map(t => publicTrip(t, { role: query.role, id: query.id }));
  },

  'POST /api/trips/:id/book': ({ params, body }) => {
    const t = requireTrip(params.id);
    if (t.status !== 'open') throw new HttpError(409, 'Рейс уже недоступен');
    if (!body.clientId) throw new HttpError(400, 'Нет клиента');
    if (t.bookings.some(b => b.clientId === body.clientId && b.status === 'active')) throw new HttpError(409, 'Вы уже забронировали этот рейс');
    const seats = Math.floor(+body.seats);
    if (!(seats >= 1)) throw new HttpError(400, 'Укажите количество мест');
    if (seats > t.seats - seatsTaken(t)) throw new HttpError(409, 'Столько свободных мест нет');
    t.bookings.push({ clientId: body.clientId, seats, name: String(body.name || '').slice(0, 50), phone: String(body.phone || '').slice(0, 20), status: 'active', at: Date.now() });
    notifyTrip(t);
    save();
    return publicTrip(t, { role: 'client', id: body.clientId });
  },

  'POST /api/trips/:id/unbook': ({ params, body }) => {
    const t = requireTrip(params.id);
    const b = t.bookings.find(x => x.clientId === body.clientId && x.status === 'active');
    if (!b) throw new HttpError(404, 'Брони нет');
    if (t.status !== 'open') throw new HttpError(409, 'Рейс уже в пути');
    b.status = 'cancelled';
    notifyTrip(t);
    save();
    return publicTrip(t, { role: 'client', id: body.clientId });
  },

  'POST /api/trips/:id/status': ({ params, body }) => {
    const t = requireTrip(params.id);
    if (t.driverId !== body.driverId) throw new HttpError(403, 'Чужой рейс');
    const allowed = { open: ['departed', 'cancelled'], departed: ['done'] }[t.status] || [];
    if (!allowed.includes(body.status)) throw new HttpError(409, `Нельзя из статуса ${t.status}`);
    t.status = body.status;
    if (t.status === 'done') {
      const d = db.drivers[t.driverId];
      const active = t.bookings.filter(b => b.status === 'active');
      d.earned += active.reduce((n, b) => n + b.seats * t.pricePerSeat, 0);
      d.trips += 1;
    }
    notifyTrip(t);
    save();
    return publicTrip(t, { role: 'driver', id: t.driverId });
  },

  'POST /api/driver/online': ({ body }) => {
    const d = upsertDriver(body);
    d.online = true;
    save();
    return { ...d, rating: rating(d) };
  },

  'POST /api/driver/offline': ({ body }) => {
    const d = db.drivers[body.id];
    if (d?.orderId) throw new HttpError(409, 'Сначала завершите заказ');
    if (d) d.online = false;
    save();
    return { ok: true };
  },

  'POST /api/driver/location': ({ body }) => {
    const d = db.drivers[body.id];
    if (!d) throw new HttpError(404, 'Водитель не найден');
    Object.assign(d, { lat: +body.lat, lon: +body.lon, heading: body.heading ?? d.heading });
    if (d.orderId) {
      const o = db.orders[d.orderId];
      send('client', o.clientId, 'driver_location', publicDriver(d));
    }
    return { ok: true };
  },
};

function driverStep(from, to, stampField) {
  return ({ params, body }) => {
    const o = requireOrder(params.id);
    if (o.driverId !== body.driverId) throw new HttpError(403, 'Чужой заказ');
    requireStatus(o, from);
    o.status = to;
    o[stampField] = Date.now();
    if (to === 'done') {
      const d = db.drivers[o.driverId];
      d.orderId = null;
      d.earned += o.price;
      d.trips += 1;
      const c = db.clients[o.clientId] ||= { ratingSum: 0, ratingCount: 0, trips: 0 };
      c.trips += 1;
    }
    notifyOrder(o);
    save();
    return publicOrder(o);
  };
}

function matchRoute(method, pathname) {
  for (const [key, handler] of Object.entries(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    const match = pathname.match(re);
    if (match) return { handler, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])])) };
  }
}

function openStream(req, res, query) {
  const { role, id } = query;
  if (!['client', 'driver'].includes(role) || !id) { res.writeHead(400).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const key = `${role}:${id}`;
  if (!streams.has(key)) streams.set(key, new Set());
  streams.get(key).add(res);

  const active = activeOrderOf(role, id);
  if (active) res.write(`event: order\ndata: ${JSON.stringify(publicOrder(active))}\n\n`);
  if (role === 'driver') {
    const offered = Object.values(db.orders).find(o => o.status === 'searching' && o.offerTo === id);
    if (offered) res.write(`event: offer\ndata: ${JSON.stringify({ ...publicOrder(offered), pickupKm: km(db.drivers[id], offered.from) })}\n\n`);
  }

  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    streams.get(key).delete(res);
    if (role === 'driver' && !streams.get(key).size) {
      setTimeout(() => {
        const d = db.drivers[id];
        if (d && !streams.get(key)?.size && !d.orderId) { d.online = false; save(); }
      }, 30000);
    }
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PUBLIC = new Set(['taxi.html', 'driver.html', 'app.css', 'rating.js', 'vehicles.js', 'cities.js']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const query = Object.fromEntries(url.searchParams);

  if (url.pathname === '/api/events') return openStream(req, res, query);

  const route = matchRoute(req.method, url.pathname);
  if (route) {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const result = await route.handler({ params: route.params, query, body });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname.startsWith('/osrm/route/v1/driving/')) return proxyOsrm(url, res);

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    return;
  }

  const file = url.pathname === '/' ? 'taxi.html' : url.pathname.slice(1);
  if (!PUBLIC.has(file)) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] });
  fs.createReadStream(path.join(__dirname, file)).pipe(res);
});

async function proxyOsrm(url, res) {
  try {
    const r = await fetch(OSRM_URL + url.pathname.slice('/osrm'.length) + url.search);
    res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(await r.text());
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"code":"OsrmUnavailable"}');
  }
}

function startScheduled() {
  for (const o of Object.values(db.orders)) {
    if (o.status !== 'scheduled' || o.departAt - SCHEDULE_LEAD_MS > Date.now()) continue;
    o.status = 'searching';
    o.searchStartedAt = Date.now();
    notifyOrder(o);
    save();
    dispatch(o);
  }
}

async function start() {
  await storage.migrate();
  db = await storage.load();
  await storage.importJsonIfEmpty(db, path.join(__dirname, 'data.json'));
  for (const d of Object.values(db.drivers)) d.online = false;

  server.listen(PORT, () => {
    console.log(`Клиент:   http://localhost:${PORT}/`);
    console.log(`Водитель: http://localhost:${PORT}/driver.html`);
    console.log(`OSRM:     ${OSRM_URL}`);
  });

  setInterval(startScheduled, 15000);
  setInterval(() => storage.evictFinished(db), 10 * 60 * 1000);
  startScheduled();
  for (const o of Object.values(db.orders)) if (o.status === 'searching') dispatch(o);
}

start().catch(e => {
  console.error('Не удалось запустить сервер:', e.message);
  process.exit(1);
});

async function shutdown() {
  clearTimeout(saveTimer);
  server.close();
  try { await storage.flush(db); } catch (e) { console.error('Ошибка сохранения при остановке:', e.message); }
  await storage.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
