import type { GeoPoint } from '@jol/contracts';
import { badRequest, unavailable } from './errors.js';

export interface Route {
  km: number;
  min: number;
}

const TIMEOUT_MS = 3000;

export function createOsrm(baseUrl: string) {
  return {
    async route(from: GeoPoint, to: GeoPoint): Promise<Route> {
      const url = `${baseUrl}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        throw unavailable(`Маршрутизация недоступна: ${(err as Error).message}`);
      }
      const body = (await res.json()) as { code: string; routes?: Array<{ distance: number; duration: number }> };
      const r = body.routes?.[0];
      if (body.code !== 'Ok' || !r) throw badRequest('Маршрут не найден');
      return { km: r.distance / 1000, min: r.duration / 60 };
    },
  };
}
