import { describe, expect, it } from 'vitest';
import type { DriverCard } from '@jol/contracts';
import { Registry } from './registry.js';

const card = (id: string, tariff: DriverCard['tariff'] = 'eco'): DriverCard => ({ id, name: id, car: 'Kia', plate: '1', tariff, rating: 5, trips: 0 });
const ALMATY = { lat: 43.238, lon: 76.889 };

describe('Registry', () => {
  it('ranks candidates by distance and filters by tariff, radius and exclusions', () => {
    const r = new Registry();
    r.goOnline(card('far'), { lat: 43.26, lon: 76.92 });
    r.goOnline(card('near'), { lat: 43.239, lon: 76.89 });
    r.goOnline(card('cargo', 'cargo_m'), { lat: 43.238, lon: 76.889 });
    r.goOnline(card('excluded'), { lat: 43.2381, lon: 76.8891 });
    r.goOnline(card('outside'), { lat: 43.6, lon: 76.6 });

    const ids = r.candidates(ALMATY, 'eco', 15, ['excluded'], 5).map(c => c.driver.id);
    expect(ids).toEqual(['near', 'far']);
  });

  it('does not offer drivers who are serving a passenger', () => {
    const r = new Registry();
    r.goOnline(card('busy'), ALMATY);
    r.setServing('busy', 'client-1');
    expect(r.candidates(ALMATY, 'eco', 15, [], 5)).toEqual([]);
    expect(r.supplyByZone()).toEqual({});
  });

  it('counts only free city drivers per zone', () => {
    const r = new Registry();
    r.goOnline(card('a'), ALMATY);
    r.goOnline(card('b'), { lat: 43.2381, lon: 76.8891 });
    r.goOnline(card('truck', 'cargo_l'), ALMATY);
    expect(Object.values(r.supplyByZone())).toEqual([2]);
  });

  it('sweeps drivers that went silent but keeps those on a ride', () => {
    let now = 0;
    const r = new Registry(() => now);
    r.goOnline(card('idle'), ALMATY);
    r.goOnline(card('riding'), ALMATY);
    r.setServing('riding', 'client-1');
    now = 120_000;
    expect(r.sweepStale(90_000)).toEqual(['idle']);
    expect(r.get('riding')).toBeDefined();
  });
});
