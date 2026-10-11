import type { Audience, OrderView } from '@jol/contracts';
import type { Order } from './repo.js';

export interface Offer {
  driverId: string;
  expiresAt: number;
  pickupKm: number;
}

/**
 * The proof-of-delivery code is the sender's secret: a courier who could read it
 * could close the order without meeting the recipient. Driver-facing views never carry it.
 */
export function toView(o: Order, audience: Audience, offer?: Offer | null): OrderView {
  return {
    id: o.id,
    clientId: o.clientId,
    driverId: o.driverId,
    tariff: o.tariff,
    status: o.status,
    from: o.from,
    to: o.to,
    fromLabel: o.fromLabel,
    toLabel: o.toLabel,
    km: o.km,
    min: o.min,
    price: o.price,
    surge: o.surge,
    loaders: o.loaders,
    cargoNote: o.cargoNote,
    delivery: o.delivery && { ...o.delivery, code: audience === 'client' ? o.delivery.code : null },
    departAt: o.departAt,
    offerTo: offer?.driverId ?? null,
    offerExpiresAt: offer?.expiresAt ?? null,
    createdAt: o.createdAt,
    driver: o.driver,
    client: o.client,
    driverReview: o.driverReview,
    clientReview: o.clientReview,
  };
}
