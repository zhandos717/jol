import { z } from 'zod';

export const TariffId = z.enum([
  'eco',
  'comfort',
  'business',
  'cargo_s',
  'cargo_m',
  'cargo_l',
  'intercity',
  'courier_foot',
  'courier_bike',
  'courier_car',
]);
export type TariffId = z.infer<typeof TariffId>;

export type TariffKind = 'city' | 'cargo' | 'intercity' | 'courier';

export const TARIFF_KIND: Record<TariffId, TariffKind> = {
  eco: 'city',
  comfort: 'city',
  business: 'city',
  cargo_s: 'cargo',
  cargo_m: 'cargo',
  cargo_l: 'cargo',
  intercity: 'intercity',
  courier_foot: 'courier',
  courier_bike: 'courier',
  courier_car: 'courier',
};

export const TARIFF_NAME: Record<TariffId, string> = {
  eco: 'Эконом',
  comfort: 'Комфорт',
  business: 'Бизнес',
  cargo_s: 'Каблук',
  cargo_m: 'Газель',
  cargo_l: 'Грузовик',
  intercity: 'Межгород',
  courier_foot: 'Пеший курьер',
  courier_bike: 'Велокурьер',
  courier_car: 'Курьер на авто',
};

export const MAX_LOADERS = 4;

/** How far to look for a courier: a walker 3 km away is 40 minutes late. */
export const SEARCH_RADIUS_KM: Record<TariffId, number> = {
  eco: 15,
  comfort: 15,
  business: 15,
  cargo_s: 15,
  cargo_m: 15,
  cargo_l: 15,
  intercity: 40,
  courier_foot: 2,
  courier_bike: 5,
  courier_car: 15,
};
