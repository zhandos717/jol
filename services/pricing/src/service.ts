import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GeoPoint, TariffId, distanceKm, zoneBounds, zoneOf, type ZoneKey } from '@jol/contracts';
import { createHttp, createOsrm, decodeJson, encodeJson, defineService } from '@jol/kit';
import { DemandWindow, ORDER_WEIGHT, QUOTE_WEIGHT, surgeAt } from './surge.js';
import { LOADER_PRICE, RATES, priceFor } from './tariffs.js';

const QUOTE_TTL_MS = 3 * 60 * 1000;
/** A quote is honoured only if the order starts where the price was shown. */
const QUOTE_MAX_DRIFT_KM = 0.3;
const SUPPLY_CACHE_MS = 5000;
const SURGE_MAP_RADIUS_ZONES = 6;

const Quote = z.object({ surge: z.number(), from: GeoPoint });

export default defineService(z.object({ OSRM_URL: z.string().url() }), async ({ config, log, bus, onShutdown }) => {
  const osrm = createOsrm(config.OSRM_URL);
  const demand = new DemandWindow();
  const quotes = await bus.kv('quotes', QUOTE_TTL_MS);

  let supply: { at: number; byZone: Record<string, number> } = { at: 0, byZone: {} };
  const currentSupply = async () => {
    if (Date.now() - supply.at > SUPPLY_CACHE_MS) {
      try {
        supply = { at: Date.now(), byZone: await bus.request('fleet.supply', {}) };
      } catch (err) {
        log.warn({ err }, 'fleet supply unavailable, using last known');
      }
    }
    return supply.byZone;
  };
  const surgeHere = async (p: GeoPoint) => surgeAt(p, demand.byZone(), await currentSupply());

  await bus.follow(['jol.dispatch.order.created'], event => {
    if (event.type === 'jol.dispatch.order.created') demand.record(event.data.from, ORDER_WEIGHT);
  });

  bus.serve('pricing.price', async q => {
    const route = await osrm.route(q.from, q.to);
    let surge: number | null = null;
    if (q.quoteId) {
      const entry = await quotes.get(q.quoteId);
      const quote = entry?.value.length ? Quote.safeParse(decodeJson(entry.value)) : null;
      if (quote?.success && distanceKm(quote.data.from, q.from) <= QUOTE_MAX_DRIFT_KM) surge = quote.data.surge;
    }
    surge ??= await surgeHere(q.from);
    return { price: priceFor(route, q.tariff, q.loaders, surge), surge, km: route.km, min: route.min };
  });

  const http = createHttp(log, { nats: async () => void (await bus.nc.flush()) });

  http.post('/api/quote', async req => {
    const { from, to } = z.object({ from: GeoPoint, to: GeoPoint }).parse(req.body);
    const route = await osrm.route(from, to);
    const surge = await surgeHere(from);
    demand.record(from, QUOTE_WEIGHT);
    const quoteId = randomUUID();
    await quotes.put(quoteId, encodeJson({ surge, from }));
    const tariffs = Object.keys(RATES) as TariffId[];
    return {
      km: route.km,
      min: route.min,
      surge,
      quoteId,
      quoteExpiresAt: Date.now() + QUOTE_TTL_MS,
      loaderPrice: LOADER_PRICE,
      prices: Object.fromEntries(tariffs.map(t => [t, priceFor(route, t, 0, surge)])),
    };
  });

  http.get('/api/surge/map', async req => {
    const center = GeoPoint.parse(req.query);
    const [ci, cj] = zoneOf(center).split(':').map(Number) as [number, number];
    const demandByZone = demand.byZone();
    const supplyByZone = await currentSupply();
    const zones = [];
    for (let i = -SURGE_MAP_RADIUS_ZONES; i <= SURGE_MAP_RADIUS_ZONES; i++) {
      for (let j = -SURGE_MAP_RADIUS_ZONES; j <= SURGE_MAP_RADIUS_ZONES; j++) {
        const key: ZoneKey = `${ci + i}:${cj + j}`;
        const b = zoneBounds(key);
        const surge = surgeAt({ lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 }, demandByZone, supplyByZone);
        if (surge > 1) zones.push({ ...b, surge });
      }
    }
    return zones;
  });

  await http.listen({ host: '0.0.0.0', port: config.PORT });
  onShutdown(() => http.close());
});
