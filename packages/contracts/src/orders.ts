import { z } from 'zod';
import { GeoPoint } from './geo.js';
import { DriverView, Id, RiderCard } from './people.js';
import { TariffId } from './tariffs.js';

export const OrderStatus = z.enum([
  'scheduled',
  'searching',
  'accepted',
  'arrived',
  'in_progress',
  'done',
  'cancelled',
  'no_drivers',
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ['scheduled', 'searching', 'accepted', 'arrived', 'in_progress'];

export const Review = z.object({
  stars: z.number().int().min(1).max(5),
  tags: z.array(z.string().max(40)).max(5).default([]),
  comment: z.string().max(300).default(''),
  at: z.number(),
});
export type Review = z.infer<typeof Review>;

/** Order as exposed to passenger and driver apps; the frontend contract. */
export const OrderView = z.object({
  id: z.string().uuid(),
  clientId: Id,
  driverId: Id.nullable(),
  tariff: TariffId,
  status: OrderStatus,
  from: GeoPoint,
  to: GeoPoint,
  fromLabel: z.string(),
  toLabel: z.string(),
  km: z.number(),
  min: z.number(),
  price: z.number().int(),
  surge: z.number(),
  loaders: z.number().int(),
  cargoNote: z.string(),
  departAt: z.number().nullable(),
  offerTo: Id.nullable(),
  offerExpiresAt: z.number().nullable(),
  createdAt: z.number(),
  driver: DriverView.nullable(),
  client: RiderCard.omit({ id: true }),
  driverReview: Review.nullable(),
  clientReview: Review.nullable(),
});
export type OrderView = z.infer<typeof OrderView>;
