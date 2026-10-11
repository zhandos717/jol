import type { TariffId } from '@jol/contracts';

export type FoodStatus = 'placed' | 'cooking' | 'ready' | 'delivering' | 'delivered' | 'rejected' | 'cancelled';

/**
 *   placed ─► cooking ─► ready ─► delivering ─► delivered
 *     ├──► rejected (restaurant)
 *     └──► cancelled (customer, or no courier after fallback)
 */
export const FOOD_TRANSITIONS: Record<FoodStatus, readonly FoodStatus[]> = {
  placed: ['cooking', 'rejected', 'cancelled'],
  cooking: ['ready', 'delivering', 'cancelled'],
  ready: ['delivering', 'cancelled'],
  delivering: ['delivered'],
  delivered: [],
  rejected: [],
  cancelled: [],
};

export const ACTIVE_FOOD: readonly FoodStatus[] = ['placed', 'cooking', 'ready', 'delivering'];

export function canMove(from: FoodStatus, to: FoodStatus): boolean {
  return FOOD_TRANSITIONS[from].includes(to);
}

export const MAX_QTY = 20;
export const MAX_DISTANCE_KM = 15;
/** A bike courier beyond 5 km keeps food waiting too long; switch to car. */
const BIKE_MAX_KM = 5;

export function courierTariffFor(distanceKm: number): TariffId {
  return distanceKm <= BIKE_MAX_KM ? 'courier_bike' : 'courier_car';
}

/** Fallback when no courier accepted: one retry by car, then give up. */
export function nextCourierAttempt(attempts: number): TariffId | null {
  return attempts >= 2 ? null : 'courier_car';
}

export interface MenuItem {
  id: string;
  name: string;
  price: number;
  isAvailable: boolean;
}

export interface CartLine {
  itemId: string;
  qty: number;
}

export interface PricedLine {
  itemId: string;
  name: string;
  price: number;
  qty: number;
}

/** Prices come from the menu, never from the client. Unknown, unavailable or duplicated items are rejected. */
export function priceCart(menu: Map<string, MenuItem>, cart: CartLine[]): { lines: PricedLine[]; total: number } {
  if (!cart.length) throw new Error('Корзина пуста');
  const seen = new Set<string>();
  const lines = cart.map(({ itemId, qty }) => {
    const item = menu.get(itemId);
    if (!item) throw new Error('Блюдо не найдено в меню ресторана');
    if (!item.isAvailable) throw new Error(`«${item.name}» сейчас нет в наличии`);
    if (seen.has(itemId)) throw new Error('Одно блюдо указано дважды');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new Error(`Количество от 1 до ${MAX_QTY}`);
    seen.add(itemId);
    return { itemId, name: item.name, price: item.price, qty };
  });
  return { lines, total: lines.reduce((n, l) => n + l.price * l.qty, 0) };
}
