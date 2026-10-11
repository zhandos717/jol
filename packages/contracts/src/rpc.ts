import { z } from 'zod';
import { GeoPoint } from './geo.js';
import { OrderView } from './orders.js';
import { DriverAccount, DriverCard, DriverProfile, DriverView, Id, RiderCard } from './people.js';
import { TariffId } from './tariffs.js';

/**
 * Synchronous service-to-service calls over NATS request/reply.
 * Each entry is `subject → { request, response }`; both sides validate with these schemas.
 */
export const Rpc = {
  'accounts.driver.register': { request: DriverProfile, response: DriverAccount },
  'accounts.driver.card': { request: z.object({ id: Id }), response: DriverCard.nullable() },
  'accounts.rider.card': { request: z.object({ id: Id }), response: RiderCard },

  'fleet.candidates': {
    request: z.object({
      point: GeoPoint,
      tariff: TariffId,
      radiusKm: z.number().positive(),
      exclude: z.array(Id).default([]),
      limit: z.number().int().positive().default(5),
    }),
    response: z.array(z.object({ driver: DriverView, distanceKm: z.number() })),
  },
  'fleet.supply': {
    request: z.object({}),
    response: z.record(z.string(), z.number()),
  },

  'pricing.price': {
    request: z.object({
      from: GeoPoint,
      to: GeoPoint,
      tariff: TariffId,
      loaders: z.number().int().min(0).default(0),
      quoteId: z.string().uuid().nullable().default(null),
    }),
    response: z.object({ price: z.number().int(), surge: z.number(), km: z.number(), min: z.number() }),
  },

  'dispatch.assignments': {
    request: z.object({}),
    response: z.array(z.object({ driverId: Id, clientId: Id, orderId: z.string().uuid() })),
  },
  'dispatch.snapshot': {
    request: z.object({ role: z.enum(['client', 'driver']), id: Id }),
    response: z.object({ order: OrderView.nullable(), offer: OrderView.extend({ pickupKm: z.number() }).nullable() }),
  },
} as const;

export type RpcSubject = keyof typeof Rpc;
export type RpcRequest<S extends RpcSubject> = z.input<(typeof Rpc)[S]['request']>;
export type RpcResponse<S extends RpcSubject> = z.infer<(typeof Rpc)[S]['response']>;
export type RpcHandled<S extends RpcSubject> = z.infer<(typeof Rpc)[S]['request']>;
