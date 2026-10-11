import { TARIFF_KIND, type TariffId } from '@jol/contracts';
import type { Route } from '@jol/kit';

interface Rate {
  base: number;
  perKm: number;
  perMin: number;
}

/** KZT. City tariffs are scaled by surge; cargo, intercity and courier are fixed-price products. */
export const RATES: Record<TariffId, Rate> = {
  eco: { base: 400, perKm: 120, perMin: 20 },
  comfort: { base: 540, perKm: 162, perMin: 27 },
  business: { base: 840, perKm: 252, perMin: 42 },
  cargo_s: { base: 2500, perKm: 180, perMin: 35 },
  cargo_m: { base: 4000, perKm: 240, perMin: 45 },
  cargo_l: { base: 7000, perKm: 330, perMin: 60 },
  intercity: { base: 3000, perKm: 95, perMin: 0 },
  courier_foot: { base: 600, perKm: 120, perMin: 0 },
  courier_bike: { base: 700, perKm: 100, perMin: 0 },
  courier_car: { base: 900, perKm: 110, perMin: 8 },
};

export const LOADER_PRICE = 3000;


export function priceFor(route: Route, tariff: TariffId, loaders = 0, surge = 1): number {
  const r = RATES[tariff];
  const k = TARIFF_KIND[tariff] === 'city' ? surge : 1;
  const fare = Math.round(((r.base + route.km * r.perKm + route.min * r.perMin) * k) / 10) * 10;
  return fare + (TARIFF_KIND[tariff] === 'cargo' ? loaders * LOADER_PRICE : 0);
}
