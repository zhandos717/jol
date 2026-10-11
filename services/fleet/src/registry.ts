import { distanceKm, TARIFF_KIND, zoneOf, type DriverCard, type DriverView, type GeoPoint, type TariffId } from '@jol/contracts';

export interface Presence {
  card: DriverCard;
  lat: number;
  lon: number;
  heading: number | null;
  lastSeenAt: number;
}

export interface Candidate {
  driver: DriverView;
  distanceKm: number;
}

const view = (p: Presence): DriverView => ({ ...p.card, lat: p.lat, lon: p.lon, heading: p.heading });

/**
 * In-memory registry of online drivers. Presence is ephemeral by nature (seconds-old data),
 * so it is not persisted; see ADR-0006.
 */
export class Registry {
  private readonly drivers = new Map<string, Presence>();
  /** driverId → passenger being served. Kept apart from presence so it survives reconnects and restarts. */
  private readonly serving = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  goOnline(card: DriverCard, pos: GeoPoint): Presence {
    const prev = this.drivers.get(card.id);
    const presence: Presence = {
      card,
      lat: pos.lat,
      lon: pos.lon,
      heading: prev?.heading ?? null,
      lastSeenAt: this.now(),
    };
    this.drivers.set(card.id, presence);
    return presence;
  }

  goOffline(id: string): boolean {
    return this.drivers.delete(id);
  }

  get(id: string): Presence | undefined {
    return this.drivers.get(id);
  }

  updateLocation(id: string, pos: GeoPoint & { heading?: number | null }): Presence | undefined {
    const p = this.drivers.get(id);
    if (!p) return undefined;
    p.lat = pos.lat;
    p.lon = pos.lon;
    if (pos.heading != null) p.heading = pos.heading;
    p.lastSeenAt = this.now();
    return p;
  }

  setServing(driverId: string, clientId: string | null): void {
    if (clientId) this.serving.set(driverId, clientId);
    else this.serving.delete(driverId);
  }

  servingClient(driverId: string): string | null {
    return this.serving.get(driverId) ?? null;
  }

  updateRating(driverId: string, rating: number): void {
    const p = this.drivers.get(driverId);
    if (p) p.card = { ...p.card, rating };
  }

  candidates(point: GeoPoint, tariff: TariffId, radiusKm: number, exclude: string[], limit: number): Candidate[] {
    const skip = new Set(exclude);
    const out: Candidate[] = [];
    for (const p of this.drivers.values()) {
      if (this.serving.has(p.card.id) || p.card.tariff !== tariff || skip.has(p.card.id)) continue;
      const d = distanceKm(p, point);
      if (d <= radiusKm) out.push({ driver: view(p), distanceKm: d });
    }
    return out.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit);
  }

  nearbyFree(point: GeoPoint, radiusKm: number, limit: number): DriverView[] {
    const latBox = radiusKm / 111;
    const lonBox = radiusKm / (111 * Math.cos((point.lat * Math.PI) / 180));
    const out: Candidate[] = [];
    for (const p of this.drivers.values()) {
      if (this.serving.has(p.card.id) || Math.abs(p.lat - point.lat) > latBox || Math.abs(p.lon - point.lon) > lonBox) continue;
      const d = distanceKm(p, point);
      if (d <= radiusKm) out.push({ driver: view(p), distanceKm: d });
    }
    return out.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit).map(c => c.driver);
  }

  /** Free city-tariff drivers per zone; input for surge pricing. */
  supplyByZone(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.drivers.values()) {
      if (this.serving.has(p.card.id) || TARIFF_KIND[p.card.tariff] !== 'city') continue;
      const z = zoneOf(p);
      out[z] = (out[z] ?? 0) + 1;
    }
    return out;
  }

  /** Drivers silent longer than `maxIdleMs` (app closed, phone offline) and not on a ride. */
  sweepStale(maxIdleMs: number): string[] {
    const cutoff = this.now() - maxIdleMs;
    const gone: string[] = [];
    for (const [id, p] of this.drivers) {
      if (!this.serving.has(id) && p.lastSeenAt < cutoff) {
        this.drivers.delete(id);
        gone.push(id);
      }
    }
    return gone;
  }

  view(id: string): DriverView | undefined {
    const p = this.drivers.get(id);
    return p && view(p);
  }
}
