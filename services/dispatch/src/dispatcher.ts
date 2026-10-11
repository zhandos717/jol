import { SEARCH_RADIUS_KM, makeEvent, type DriverView } from '@jol/contracts';
import { withTx, enqueue, type Bus, type Logger, type OutboxRelay, type Pool } from '@jol/kit';
import * as repo from './repo.js';
import type { Order } from './repo.js';
import { toView, type Offer } from './views.js';

export const OFFER_TIMEOUT_MS = 15_000;
export const SEARCH_TIMEOUT_MS = 90_000;
const RETRY_EMPTY_MS = 3_000;

interface PendingOffer extends Offer {
  driver: DriverView;
  timer: NodeJS.Timeout;
}

/**
 * Matching engine: offers each searching order to the nearest free driver, one at a time,
 * moving on after a decline or timeout. Offers live in memory; on restart searching orders
 * are simply re-dispatched (see ADR-0007 on running dispatch as a single active instance).
 */
export class Dispatcher {
  private readonly offers = new Map<string, PendingOffer>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  /** Drivers on an active order; never offered another one. */
  private readonly engaged = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly bus: Bus,
    private readonly relay: OutboxRelay,
    private readonly log: Logger,
  ) {}

  markEngaged(driverId: string) {
    this.engaged.add(driverId);
  }

  release(driverId: string | null) {
    if (driverId) this.engaged.delete(driverId);
  }

  offerFor(orderId: string): PendingOffer | undefined {
    return this.offers.get(orderId);
  }

  offerForDriver(driverId: string): { orderId: string; offer: PendingOffer } | undefined {
    for (const [orderId, offer] of this.offers) if (offer.driverId === driverId) return { orderId, offer };
    return undefined;
  }

  /** Stops any pending offer for the order; the offered driver's card is dismissed. */
  stop(orderId: string) {
    const offer = this.offers.get(orderId);
    if (offer) {
      clearTimeout(offer.timer);
      this.offers.delete(orderId);
      this.bus.notify('driver', offer.driverId, 'offer_expired', { id: orderId });
    }
    clearTimeout(this.retries.get(orderId));
    this.retries.delete(orderId);
  }

  takeOffer(orderId: string, driverId: string): PendingOffer | null {
    const offer = this.offers.get(orderId);
    if (!offer || offer.driverId !== driverId) return null;
    clearTimeout(offer.timer);
    this.offers.delete(orderId);
    return offer;
  }

  async decline(orderId: string, driverId: string): Promise<void> {
    if (!this.takeOffer(orderId, driverId)) return;
    await repo.addDeclined(this.pool, orderId, driverId);
    void this.run(orderId);
  }

  async run(orderId: string): Promise<void> {
    this.stop(orderId);
    try {
      await this.attempt(orderId);
    } catch (err) {
      this.log.error({ err, orderId }, 'dispatch attempt failed, retrying');
      this.retries.set(orderId, setTimeout(() => void this.run(orderId), RETRY_EMPTY_MS));
    }
  }

  private async attempt(orderId: string): Promise<void> {
    const order = await repo.get(this.pool, orderId);
    if (!order || order.status !== 'searching') return;

    if (Date.now() - (order.searchStartedAt ?? order.createdAt) > SEARCH_TIMEOUT_MS) {
      await this.giveUp(order);
      return;
    }

    const exclude = [...order.declined, ...this.engaged, ...[...this.offers.values()].map(o => o.driverId)];
    const [best] = await this.bus.request('fleet.candidates', {
      point: order.from,
      tariff: order.tariff,
      radiusKm: SEARCH_RADIUS_KM[order.tariff],
      exclude,
      limit: 1,
    });

    if (!best) {
      this.retries.set(orderId, setTimeout(() => void this.run(orderId), RETRY_EMPTY_MS));
      return;
    }

    const offer: PendingOffer = {
      driverId: best.driver.id,
      driver: best.driver,
      pickupKm: best.distanceKm,
      expiresAt: Date.now() + OFFER_TIMEOUT_MS,
      timer: setTimeout(() => void this.expire(orderId, best.driver.id), OFFER_TIMEOUT_MS),
    };
    this.offers.set(orderId, offer);
    this.bus.notify('driver', offer.driverId, 'offer', { ...toView(order, 'driver', offer), pickupKm: offer.pickupKm });
    if (order.source === 'app') this.bus.notify('client', order.clientId, 'order', toView(order, 'client', offer));
  }

  private async expire(orderId: string, driverId: string) {
    if (!this.takeOffer(orderId, driverId)) return;
    this.bus.notify('driver', driverId, 'offer_expired', { id: orderId });
    await repo.addDeclined(this.pool, orderId, driverId);
    void this.run(orderId);
  }

  private async giveUp(order: Order) {
    const updated = await withTx(this.pool, async tx => {
      const o = await repo.transition(tx, order.id, 'no_drivers');
      if (o) await enqueue(tx, makeEvent('jol.dispatch.order.cancelled', { orderId: o.id, clientId: o.clientId, driverId: null, source: o.source, reason: 'no_drivers' }));
      return o;
    });
    if (!updated) return;
    this.relay.kick();
    if (updated.source === 'app') this.bus.notify('client', updated.clientId, 'order', toView(updated, 'client'));
  }

  shutdown() {
    for (const o of this.offers.values()) clearTimeout(o.timer);
    for (const t of this.retries.values()) clearTimeout(t);
  }
}
