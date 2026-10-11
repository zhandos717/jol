// End-to-end check through the gateway, exactly as the apps talk to the backend.
// Usage: node scripts/e2e.mjs [baseUrl]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:8080';
const run = randomUUID().slice(0, 8);
const ALMATY = { lat: 43.238, lon: 76.889 };
const DEST = { lat: 43.25, lon: 76.92 };

async function api(path, body, headers = {}) {
  if (path === '/api/driver/online' && body?.id) onlineDrivers.add(body.id);
  const res = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const ok = async (path, body) => {
  const r = await api(path, body);
  assert.ok(r.status < 300, `${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

function stream(role, id) {
  const events = [];
  const waiters = [];
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/api/events?role=${role}&id=${id}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!ev) continue;
        const e = { event: ev, data: JSON.parse(data) };
        events.push(e);
        for (const w of [...waiters]) if (w.match(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e.data); }
      }
    }
  })().catch(() => {});
  return {
    until(event, pred = () => true, ms = 10_000) {
      const hit = events.find(e => e.event === event && pred(e.data));
      if (hit) return Promise.resolve(hit.data);
      return new Promise((resolve, reject) => {
        const w = { match: e => e.event === event && pred(e.data), resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout waiting for ${role}:${event}`)), ms);
      });
    },
    close: () => ctrl.abort(),
  };
}

async function eventually(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { return await fn(); } catch (err) { if (Date.now() > end) throw err; }
    await new Promise(r => setTimeout(r, 300));
  }
}

/** Every driver a run puts online is taken offline at the end, even on failure, so runs never leak into each other. */
const onlineDrivers = new Set();
const cleanup = async () => {
  for (const id of onlineDrivers) await api('/api/driver/offline', { id }).catch(() => {});
};

const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  console.log(`✓ ${name} (${Date.now() - t} ms)`);
};

const driverId = `e2e-drv-${run}`;
const clientId = `e2e-cli-${run}`;
const driver = { id: driverId, name: 'E2E', car: 'Kia K5', plate: '001 e2e 02', tariff: 'comfort' };

const dStream = stream('driver', driverId);
const cStream = stream('client', clientId);
let order;

try {
  await step('driver goes online through fleet → accounts', async () => {
    const acc = await ok('/api/driver/online', { ...driver, lat: ALMATY.lat + 0.005, lon: ALMATY.lon });
    assert.equal(acc.plate, '001 E2E 02');
    assert.equal(acc.rating, 5);
  });

  await step('validation rejects malformed ids at the edge', async () => {
    const r = await api('/api/driver/online', { ...driver, id: 'bad.id*' });
    assert.equal(r.status, 400);
  });

  let quote;
  await step('pricing quotes all tariffs from own OSRM', async () => {
    quote = await ok('/api/quote', { from: ALMATY, to: DEST });
    assert.ok(quote.km > 3 && quote.km < 8);
    assert.ok(quote.prices.business > quote.prices.comfort && quote.prices.comfort > quote.prices.eco);
    assert.ok(quote.quoteId);
  });

  await step('nearby shows the free driver', async () => {
    const list = await ok(`/api/drivers/nearby?lat=${ALMATY.lat}&lon=${ALMATY.lon}`);
    assert.ok(list.some(d => d.id === driverId));
  });

  await step('repeated taps of one order (same Idempotency-Key) create exactly one order', async () => {
    const key = randomUUID();
    const body = { clientId, tariff: 'comfort', from: ALMATY, to: DEST, fromLabel: 'E2E A', toLabel: 'E2E B', quoteId: quote.quoteId };
    const replies = await Promise.all([1, 2, 3].map(() => api('/api/orders', body, { 'idempotency-key': key })));
    assert.deepEqual(replies.map(r => r.status), [200, 200, 200]);
    assert.equal(new Set(replies.map(r => r.data.id)).size, 1);
    order = replies[0].data;
  });

  await step('order is priced by the locked quote and offered to the driver', async () => {
    assert.equal(order.status, 'searching');
    assert.equal(order.price, quote.prices.comfort);
    const offer = await dStream.until('offer', o => o.id === order.id);
    assert.ok(offer.pickupKm < 1);
  });

  await step('a second active order for the same passenger is rejected', async () => {
    const r = await api('/api/orders', { clientId, tariff: 'eco', from: ALMATY, to: DEST });
    assert.equal(r.status, 409);
  });

  await step('accept → passenger sees driver card', async () => {
    await ok(`/api/orders/${order.id}/accept`, { driverId });
    const seen = await cStream.until('order', o => o.id === order.id && o.status === 'accepted');
    assert.equal(seen.driver.name, 'E2E');
  });

  await step('accepting twice loses the race cleanly', async () => {
    const r = await api(`/api/orders/${order.id}/accept`, { driverId });
    assert.equal(r.status, 409);
  });

  await step('driver location streams to the passenger (after fleet sees order.accepted)', async () => {
    const pulse = setInterval(() => void api('/api/driver/location', { id: driverId, lat: ALMATY.lat + 0.001, lon: ALMATY.lon, heading: 180 }), 200);
    try {
      const loc = await cStream.until('driver_location', d => d.id === driverId);
      assert.equal(loc.heading, 180);
    } finally {
      clearInterval(pulse);
    }
  });

  await step('ride lifecycle arrived → start → finish', async () => {
    for (const a of ['arrived', 'start', 'finish']) await ok(`/api/orders/${order.id}/${a}`, { driverId });
    await cStream.until('order', o => o.id === order.id && o.status === 'done');
  });

  await step('mutual ratings, each only once', async () => {
    await ok(`/api/orders/${order.id}/rate`, { by: 'client', id: clientId, stars: 4 });
    await ok(`/api/orders/${order.id}/rate`, { by: 'driver', id: driverId, stars: 5 });
    const again = await api(`/api/orders/${order.id}/rate`, { by: 'client', id: clientId, stars: 1 });
    assert.equal(again.status, 409);
  });

  await step('accounts converge via events (earnings, trips, ratings)', async () => {
    await eventually(async () => {
      const me = await ok(`/api/me?role=driver&id=${driverId}`);
      assert.equal(me.earned, order.price);
      assert.equal(me.trips, 1);
      assert.equal(me.rating, 4);
      const rider = await ok(`/api/me?role=client&id=${clientId}`);
      assert.equal(rider.trips, 1);
      assert.equal(rider.rating, 5);
    });
  });

  await step('recent places come from dispatch history', async () => {
    const places = await ok(`/api/places/recent?clientId=${clientId}`);
    assert.deepEqual(places.map(p => p.label), ['E2E B', 'E2E A']);
  });

  await step('passenger cancel releases the driver', async () => {
    const o2 = await ok('/api/orders', { clientId, tariff: 'comfort', from: ALMATY, to: DEST });
    await dStream.until('offer', o => o.id === o2.id);
    await ok(`/api/orders/${o2.id}/accept`, { driverId });
    const c = await ok(`/api/orders/${o2.id}/cancel`, { clientId });
    assert.equal(c.status, 'cancelled');
    await eventually(async () => {
      const list = await ok(`/api/drivers/nearby?lat=${ALMATY.lat}&lon=${ALMATY.lon}`);
      assert.ok(list.some(d => d.id === driverId));
    });
  });

  await step('intercity: publish, find, book, complete → earnings', async () => {
    const departAt = new Date(Date.now() + 86_400_000).toISOString();
    const astana = { lat: 51.1283, lon: 71.4305, label: 'Астана' };
    const almaty = { lat: 43.2389, lon: 76.8897, label: 'Алматы' };
    const trip = await ok('/api/trips', { driver, from: almaty, to: astana, departAt, seats: 3, pricePerSeat: 12000 });
    const day = departAt.slice(0, 10);
    const found = await ok(`/api/trips/search?clientId=${clientId}&fromLat=${almaty.lat}&fromLon=${almaty.lon}&toLat=${astana.lat}&toLon=${astana.lon}&date=${day}&seats=2`);
    assert.ok(found.some(t => t.id === trip.id));
    await ok(`/api/trips/${trip.id}/book`, { clientId, seats: 2 });
    const over = await api(`/api/trips/${trip.id}/book`, { clientId: `${clientId}-2`, seats: 2 });
    assert.equal(over.status, 409);
    await dStream.until('trip', t => t.id === trip.id && t.seatsLeft === 1);
    await ok(`/api/trips/${trip.id}/status`, { driverId, status: 'departed' });
    await ok(`/api/trips/${trip.id}/status`, { driverId, status: 'done' });
    await eventually(async () => {
      const me = await ok(`/api/me?role=driver&id=${driverId}`);
      assert.equal(me.earned, order.price + 24000);
    });
  });

  await step('courier delivery: PIN goes only to the sender and gates completion', async () => {
    const courierId = `e2e-cour-${run}`;
    const senderId = `e2e-snd-${run}`;
    const cStr = stream('driver', courierId);
    try {
      await ok('/api/driver/online', { id: courierId, name: 'Курьер', car: 'Велосипед', plate: '—', tariff: 'courier_bike', lat: ALMATY.lat + 0.003, lon: ALMATY.lon });
      const r = await api('/api/orders', { clientId: senderId, tariff: 'courier_bike', from: ALMATY, to: DEST });
      assert.equal(r.status, 400, 'courier order without recipient must be rejected');
      const sent = await ok('/api/orders', {
        clientId: senderId, tariff: 'courier_bike', from: ALMATY, to: DEST,
        delivery: { item: 'Ключи', recipientName: 'Айгерим', recipientPhone: '+7 701 000 00 00' },
      });
      assert.match(sent.delivery.code, /^\d{4}$/);
      const offer = await cStr.until('offer', o => o.id === sent.id);
      assert.equal(offer.delivery.code, null, 'courier must not see the PIN');
      for (const a of ['accept', 'arrived', 'start']) await ok(`/api/orders/${sent.id}/${a}`, { driverId: courierId });
      const wrong = String((Number(sent.delivery.code) + 1) % 10000).padStart(4, '0');
      const bad = await api(`/api/orders/${sent.id}/finish`, { driverId: courierId, code: wrong });
      assert.equal(bad.status, 400);
      const done = await ok(`/api/orders/${sent.id}/finish`, { driverId: courierId, code: sent.delivery.code });
      assert.equal(done.status, 'done');
      await ok('/api/driver/offline', { id: courierId });
    } finally {
      cStr.close();
    }
  });

  await step('food: restaurant accepts → food books a courier in dispatch → PIN handover → delivered', async () => {
    const courierId = `e2e-food-cour-${run}`;
    const eaterId = `e2e-eater-${run}`;
    const rest = (await ok(`/api/food/restaurants?lat=${ALMATY.lat}&lon=${ALMATY.lon}`)).find(r => r.id === 'napoli-almaty');
    const menu = (await ok(`/api/food/restaurants/${rest.id}`)).menu;
    const courierStream = stream('driver', courierId);
    const eaterStream = stream('client', eaterId);
    const restStream = stream('restaurant', rest.id);
    try {
      await ok('/api/driver/online', { id: courierId, name: 'Велокурьер', car: 'Велосипед', plate: '—', tariff: 'courier_bike', lat: rest.lat + 0.002, lon: rest.lon });
      const tampered = await api('/api/food/orders', {
        clientId: eaterId, restaurantId: rest.id, items: [{ itemId: 'st-phila', qty: 1 }],
        to: { lat: 43.2465, lon: 76.95, label: 'ул. Жибек Жолы, 50' }, recipientName: 'Ерлан', recipientPhone: '+7 702 000 00 00',
      });
      assert.equal(tampered.status, 400, 'items from another restaurant must be rejected');

      const key = randomUUID();
      const body = {
        clientId: eaterId, restaurantId: rest.id,
        items: [{ itemId: menu[0].id, qty: 2 }, { itemId: menu[4].id, qty: 1 }],
        to: { lat: 43.2465, lon: 76.95, label: 'ул. Жибек Жолы, 50' }, recipientName: 'Ерлан', recipientPhone: '+7 702 000 00 00',
      };
      const [placed, again] = await Promise.all([api('/api/food/orders', body, { 'idempotency-key': key }), api('/api/food/orders', body, { 'idempotency-key': key })]);
      assert.equal(placed.data.id, again.data.id, 'same tap must not create two food orders');
      const food = placed.data;
      assert.equal(food.itemsTotal, menu[0].price * 2 + menu[4].price);
      assert.equal(food.total, food.itemsTotal + food.deliveryFee);
      await restStream.until('food', f => f.id === food.id && f.status === 'placed');

      await ok(`/api/food/orders/${food.id}/accept`, { restaurantId: rest.id });
      const offer = await courierStream.until('offer', o => o.from.lat === rest.lat);
      assert.equal(offer.delivery.code, null);
      const withCode = await eaterStream.until('food', f => f.id === food.id && f.deliveryCode);
      await ok(`/api/orders/${offer.id}/accept`, { driverId: courierId });
      await eaterStream.until('food', f => f.id === food.id && f.courier?.name === 'Велокурьер');
      await ok(`/api/food/orders/${food.id}/ready`, { restaurantId: rest.id });
      await ok(`/api/orders/${offer.id}/arrived`, { driverId: courierId });
      await ok(`/api/orders/${offer.id}/start`, { driverId: courierId });
      await eaterStream.until('food', f => f.id === food.id && f.status === 'delivering');
      await ok(`/api/orders/${offer.id}/finish`, { driverId: courierId, code: withCode.deliveryCode });
      const delivered = await eaterStream.until('food', f => f.id === food.id && f.status === 'delivered');
      assert.equal(delivered.deliveryCode, withCode.deliveryCode);
      await ok('/api/driver/offline', { id: courierId });
    } finally {
      courierStream.close();
      eaterStream.close();
      restStream.close();
    }
  });

  await step('driver goes offline', async () => {
    await ok('/api/driver/offline', { id: driverId });
  });

  console.log('\nAll end-to-end checks passed');
} catch (err) {
  console.error('\n✗', err.message);
  process.exitCode = 1;
} finally {
  dStream.close();
  cStream.close();
  await cleanup();
}
