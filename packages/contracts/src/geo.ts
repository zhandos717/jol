import { z } from 'zod';

export const GeoPoint = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

export const Place = GeoPoint.extend({
  label: z.string().max(200).default(''),
});
export type Place = z.infer<typeof Place>;

const EARTH_RADIUS_KM = 6371;
const RAD = Math.PI / 180;

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Grid cell of roughly 1.5 × 1.5 km at Almaty's latitude; used for demand/supply aggregation. */
export const ZONE_LAT = 0.0135;
export const ZONE_LON = 0.0185;

export type ZoneKey = `${number}:${number}`;

export function zoneOf(p: GeoPoint): ZoneKey {
  return `${Math.floor(p.lat / ZONE_LAT)}:${Math.floor(p.lon / ZONE_LON)}`;
}

export function neighbourZones(key: ZoneKey): ZoneKey[] {
  const [i, j] = key.split(':').map(Number) as [number, number];
  const out: ZoneKey[] = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) out.push(`${i + di}:${j + dj}`);
  return out;
}

export function zoneBounds(key: ZoneKey) {
  const [i, j] = key.split(':').map(Number) as [number, number];
  return { south: i * ZONE_LAT, west: j * ZONE_LON, north: (i + 1) * ZONE_LAT, east: (j + 1) * ZONE_LON };
}
