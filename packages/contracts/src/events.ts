import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GeoPoint } from './geo.js';
import { Id } from './people.js';
import { TariffId } from './tariffs.js';

/**
 * Durable domain events published to JetStream stream `JOL` under `jol.<service>.<entity>.<event>`.
 * Consumers must be idempotent: delivery is at-least-once.
 */
export const STREAM = 'JOL';
export const STREAM_SUBJECTS = ['jol.>'];

/** `source: food` marks courier deliveries booked by the food service, so it can ignore everything else. */
const OrderRef = z.object({
  orderId: z.string().uuid(),
  clientId: Id,
  driverId: Id.nullable(),
  source: z.enum(['app', 'food']).default('app'),
});

export const EventSchemas = {
  'jol.dispatch.order.created': OrderRef.extend({ tariff: TariffId, from: GeoPoint, price: z.number(), surge: z.number() }),
  'jol.dispatch.order.accepted': OrderRef.extend({ driverId: Id }),
  'jol.dispatch.order.arrived': OrderRef.extend({ driverId: Id }),
  'jol.dispatch.order.started': OrderRef.extend({ driverId: Id }),
  'jol.dispatch.order.completed': OrderRef.extend({ driverId: Id, price: z.number(), tariff: TariffId }),
  'jol.dispatch.order.cancelled': OrderRef.extend({ reason: z.enum(['client', 'no_drivers']) }),
  'jol.dispatch.order.rated': z.object({
    orderId: z.string().uuid(),
    targetRole: z.enum(['driver', 'client']),
    targetId: Id,
    stars: z.number().int().min(1).max(5),
  }),
  'jol.intercity.trip.published': z.object({ tripId: z.string().uuid(), driverId: Id, departAt: z.number(), seats: z.number().int() }),
  'jol.intercity.trip.booked': z.object({ tripId: z.string().uuid(), clientId: Id, seats: z.number().int() }),
  'jol.intercity.trip.completed': z.object({ tripId: z.string().uuid(), driverId: Id, earned: z.number().int() }),
  'jol.intercity.trip.cancelled': z.object({ tripId: z.string().uuid(), driverId: Id }),
  'jol.food.order.placed': z.object({ foodOrderId: z.string().uuid(), clientId: Id, restaurantId: Id, total: z.number().int() }),
  'jol.food.order.accepted': z.object({ foodOrderId: z.string().uuid(), restaurantId: Id }),
  'jol.food.order.ready': z.object({ foodOrderId: z.string().uuid(), restaurantId: Id }),
  'jol.food.order.delivered': z.object({ foodOrderId: z.string().uuid(), restaurantId: Id, total: z.number().int() }),
  'jol.food.order.cancelled': z.object({ foodOrderId: z.string().uuid(), restaurantId: Id, reason: z.enum(['client', 'restaurant', 'no_courier']) }),
  'jol.accounts.rating.changed': z.object({ role: z.enum(['driver', 'client']), id: Id, rating: z.number() }),
  'jol.fleet.driver.online': z.object({ driverId: Id, tariff: TariffId }),
  'jol.fleet.driver.offline': z.object({ driverId: Id }),
} as const;

export type EventType = keyof typeof EventSchemas;
export type EventData<T extends EventType> = z.infer<(typeof EventSchemas)[T]>;

export interface EventEnvelope<T extends EventType = EventType> {
  id: string;
  type: T;
  occurredAt: string;
  data: EventData<T>;
}

/** Discriminated union of all envelopes: `switch (event.type)` narrows `event.data`. */
export type AnyEvent = { [T in EventType]: EventEnvelope<T> }[EventType];

export function makeEvent<T extends EventType>(type: T, data: EventData<T>): EventEnvelope<T> {
  return { id: randomUUID(), type, occurredAt: new Date().toISOString(), data: EventSchemas[type].parse(data) as EventData<T> };
}

export function parseEvent(raw: unknown): AnyEvent {
  const env = z.object({ id: z.string(), type: z.string(), occurredAt: z.string(), data: z.unknown() }).parse(raw);
  if (!(env.type in EventSchemas)) throw new Error(`Unknown event type ${env.type}`);
  const type = env.type as EventType;
  return { ...env, type, data: EventSchemas[type].parse(env.data) } as AnyEvent;
}
