import { z } from 'zod';
import { TariffId } from './tariffs.js';

export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'id: только латиница, цифры, - и _');

export const DriverProfile = z.object({
  id: Id,
  name: z.string().trim().min(1).max(50),
  car: z.string().trim().max(50).default(''),
  plate: z.string().trim().max(20).transform(s => s.toUpperCase()).default(''),
  tariff: TariffId,
});
export type DriverProfile = z.infer<typeof DriverProfile>;

export const DriverCard = DriverProfile.extend({
  rating: z.number(),
  trips: z.number().int(),
});
export type DriverCard = z.infer<typeof DriverCard>;

export const DriverAccount = DriverCard.extend({
  earned: z.number().int(),
});
export type DriverAccount = z.infer<typeof DriverAccount>;

export const RiderCard = z.object({
  id: Id,
  rating: z.number(),
  trips: z.number().int(),
});
export type RiderCard = z.infer<typeof RiderCard>;

export const DriverPosition = z.object({
  lat: z.number(),
  lon: z.number(),
  heading: z.number().nullable().default(null),
});
export type DriverPosition = z.infer<typeof DriverPosition>;

/** What a passenger sees about a driver: card plus last known position. */
export const DriverView = DriverCard.merge(DriverPosition);
export type DriverView = z.infer<typeof DriverView>;

export const NEW_USER_RATING = 5;
