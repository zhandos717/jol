import { neighbourZones, zoneOf, type GeoPoint, type ZoneKey } from '@jol/contracts';

export const DEMAND_WINDOW_MS = 10 * 60 * 1000;
export const ORDER_WEIGHT = 1;
/** A price check is a weaker demand signal than a placed order. */
export const QUOTE_WEIGHT = 0.3;
export const SURGE_MAX = 2.5;
/** How fast price follows the demand/supply ratio: ratio 3 → ×2.0. */
const ELASTICITY = 0.5;

export function surgeFromRatio(demand: number, supply: number): number {
  const ratio = demand / Math.max(supply, 1);
  if (ratio <= 1) return 1;
  return Math.min(SURGE_MAX, Math.round((1 + (ratio - 1) * ELASTICITY) * 10) / 10);
}

interface Signal {
  zone: ZoneKey;
  weight: number;
  at: number;
}

/** Sliding-window demand per zone, kept in memory: losing it on restart only resets surge to ×1.0 for a few minutes. */
export class DemandWindow {
  private readonly signals: Signal[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  record(point: GeoPoint, weight: number, at = this.now()): void {
    this.signals.push({ zone: zoneOf(point), weight, at });
  }

  byZone(): Map<ZoneKey, number> {
    const since = this.now() - DEMAND_WINDOW_MS;
    while (this.signals.length && this.signals[0]!.at < since) this.signals.shift();
    const out = new Map<ZoneKey, number>();
    for (const s of this.signals) out.set(s.zone, (out.get(s.zone) ?? 0) + s.weight);
    return out;
  }
}

/** Surge for a point looks at its zone and the 8 neighbours, so prices don't jump at zone borders. */
export function surgeAt(point: GeoPoint, demand: Map<ZoneKey, number>, supply: Record<string, number>): number {
  let d = 0;
  let s = 0;
  for (const z of neighbourZones(zoneOf(point))) {
    d += demand.get(z) ?? 0;
    s += supply[z] ?? 0;
  }
  return surgeFromRatio(d, s);
}
