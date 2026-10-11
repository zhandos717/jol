import { describe, expect, it } from 'vitest';
import { zoneOf } from '@jol/contracts';
import { DemandWindow, DEMAND_WINDOW_MS, surgeAt, surgeFromRatio } from './surge.js';
import { priceFor } from './tariffs.js';

const ROUTE = { km: 4.5537, min: 6.52 };
const ALMATY = { lat: 43.238, lon: 76.889 };

describe('priceFor', () => {
  it('matches the published fares for a 4.6 km city ride', () => {
    expect(priceFor(ROUTE, 'eco')).toBe(1080);
    expect(priceFor(ROUTE, 'comfort')).toBe(1450);
    expect(priceFor(ROUTE, 'business')).toBe(2260);
  });

  it('applies surge to city tariffs only', () => {
    expect(priceFor(ROUTE, 'eco', 0, 2)).toBe(2150);
    expect(priceFor(ROUTE, 'cargo_m', 0, 2)).toBe(priceFor(ROUTE, 'cargo_m'));
    expect(priceFor(ROUTE, 'intercity', 0, 2)).toBe(priceFor(ROUTE, 'intercity'));
    expect(priceFor(ROUTE, 'courier_bike', 0, 2)).toBe(priceFor(ROUTE, 'courier_bike'));
  });

  it('makes walking cheapest and driving the most expensive courier', () => {
    expect(priceFor(ROUTE, 'courier_foot')).toBeLessThan(priceFor(ROUTE, 'courier_car'));
    expect(priceFor(ROUTE, 'courier_bike')).toBeLessThan(priceFor(ROUTE, 'courier_car'));
  });

  it('charges loaders on cargo only', () => {
    expect(priceFor(ROUTE, 'cargo_m', 2) - priceFor(ROUTE, 'cargo_m')).toBe(6000);
    expect(priceFor(ROUTE, 'eco', 2)).toBe(priceFor(ROUTE, 'eco'));
  });
});

describe('surge', () => {
  it('stays at ×1.0 while drivers outnumber demand', () => {
    expect(surgeFromRatio(3, 5)).toBe(1);
    expect(surgeFromRatio(0, 0)).toBe(1);
  });

  it('grows with the ratio and is capped at ×2.5', () => {
    expect(surgeFromRatio(3, 1)).toBe(2);
    expect(surgeFromRatio(2, 1)).toBe(1.5);
    expect(surgeFromRatio(100, 1)).toBe(2.5);
  });

  it('counts demand in neighbouring zones and forgets it after the window', () => {
    let now = 0;
    const demand = new DemandWindow(() => now);
    for (let i = 0; i < 4; i++) demand.record({ lat: ALMATY.lat + 0.01, lon: ALMATY.lon }, 1);
    const supply = { [zoneOf(ALMATY)]: 1 };
    expect(surgeAt(ALMATY, demand.byZone(), supply)).toBe(2.5);
    now = DEMAND_WINDOW_MS + 1;
    expect(surgeAt(ALMATY, demand.byZone(), supply)).toBe(1);
  });
});
