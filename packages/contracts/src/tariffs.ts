import { z } from 'zod';

export const TariffId = z.enum(['eco', 'comfort', 'business', 'cargo_s', 'cargo_m', 'cargo_l', 'intercity']);
export type TariffId = z.infer<typeof TariffId>;

export type TariffKind = 'city' | 'cargo' | 'intercity';

export const TARIFF_KIND: Record<TariffId, TariffKind> = {
  eco: 'city',
  comfort: 'city',
  business: 'city',
  cargo_s: 'cargo',
  cargo_m: 'cargo',
  cargo_l: 'cargo',
  intercity: 'intercity',
};

export const TARIFF_NAME: Record<TariffId, string> = {
  eco: 'Эконом',
  comfort: 'Комфорт',
  business: 'Бизнес',
  cargo_s: 'Каблук',
  cargo_m: 'Газель',
  cargo_l: 'Грузовик',
  intercity: 'Межгород',
};

export const MAX_LOADERS = 4;
