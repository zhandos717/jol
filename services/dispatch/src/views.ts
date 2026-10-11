import type { OrderView } from '@jol/contracts';
import type { Order } from './repo.js';

export interface Offer {
  driverId: string;
  expiresAt: number;
  pickupKm: number;
}

export function toView(o: Order, offer?: Offer | null): OrderView {
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
