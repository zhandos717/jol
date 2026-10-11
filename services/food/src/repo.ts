import type { DbClient, Pool } from '@jol/kit';
import type { TariffId } from '@jol/contracts';
import type { FoodStatus, MenuItem, PricedLine } from './rules.js';

type Queryable = Pool | DbClient;

export interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  address: string;
  lat: number;
  lon: number;
  prepMinutes: number;
  isOpen: boolean;
}

export interface MenuEntry extends MenuItem {
  category: string;
  description: string;
}

export interface Courier {
  id: string;
  name: string;
  rating: number;
  tariff: TariffId;
}

export interface FoodOrder {
  id: string;
  clientId: string;
  restaurantId: string;
  status: FoodStatus;
  items: PricedLine[];
  itemsTotal: number;
  deliveryFee: number;
  total: number;
  to: { lat: number; lon: number; label: string };
  recipientName: string;
  recipientPhone: string;
  comment: string;
  courierTariff: TariffId;
  courierRequestId: string;
  courierOrderId: string | null;
  courierAttempts: number;
  courier: Courier | null;
  deliveryCode: string | null;
  cancelReason: string | null;
  createdAt: number;
}

const restaurantFromRow = (r: Record<string, unknown>): Restaurant => ({
  id: r.id as string,
  name: r.name as string,
  cuisine: r.cuisine as string,
  address: r.address as string,
  lat: r.lat as number,
  lon: r.lon as number,
  prepMinutes: r.prep_minutes as number,
  isOpen: r.is_open as boolean,
});

const orderFromRow = (r: Record<string, unknown>): FoodOrder => ({
  id: r.id as string,
  clientId: r.client_id as string,
  restaurantId: r.restaurant_id as string,
  status: r.status as FoodStatus,
  items: r.items as PricedLine[],
  itemsTotal: r.items_total as number,
  deliveryFee: r.delivery_fee as number,
  total: r.total as number,
  to: { lat: r.to_lat as number, lon: r.to_lon as number, label: r.to_label as string },
  recipientName: r.recipient_name as string,
  recipientPhone: r.recipient_phone as string,
  comment: r.comment as string,
  courierTariff: r.courier_tariff as TariffId,
  courierRequestId: r.courier_request_id as string,
  courierOrderId: (r.courier_order_id as string | null) ?? null,
  courierAttempts: r.courier_attempts as number,
  courier: (r.courier as Courier | null) ?? null,
  deliveryCode: (r.delivery_code as string | null) ?? null,
  cancelReason: (r.cancel_reason as string | null) ?? null,
  createdAt: (r.created_at as Date).getTime(),
});

export async function listRestaurants(db: Queryable): Promise<Restaurant[]> {
  return (await db.query('SELECT * FROM restaurants ORDER BY name')).rows.map(restaurantFromRow);
}

export async function getRestaurant(db: Queryable, id: string): Promise<Restaurant | null> {
  const { rows } = await db.query('SELECT * FROM restaurants WHERE id = $1', [id]);
  return rows[0] ? restaurantFromRow(rows[0]) : null;
}

export async function setOpen(db: Queryable, id: string, isOpen: boolean): Promise<void> {
  await db.query('UPDATE restaurants SET is_open = $2 WHERE id = $1', [id, isOpen]);
}

export async function menu(db: Queryable, restaurantId: string): Promise<MenuEntry[]> {
  const { rows } = await db.query(
    'SELECT id, category, name, description, price, is_available FROM menu_items WHERE restaurant_id = $1 ORDER BY sort',
    [restaurantId],
  );
  return rows.map(r => ({ id: r.id, category: r.category, name: r.name, description: r.description, price: r.price, isAvailable: r.is_available }));
}

export async function insertOrder(db: Queryable, o: FoodOrder, idempotencyKey: string | null): Promise<FoodOrder> {
  const { rows } = await db.query(
    `INSERT INTO food_orders (id, client_id, restaurant_id, status, items, items_total, delivery_fee, total,
       to_lat, to_lon, to_label, recipient_name, recipient_phone, comment, courier_tariff, courier_request_id, idempotency_key)
     VALUES ($1, $2, $3, 'placed', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [o.id, o.clientId, o.restaurantId, JSON.stringify(o.items), o.itemsTotal, o.deliveryFee, o.total,
      o.to.lat, o.to.lon, o.to.label, o.recipientName, o.recipientPhone, o.comment, o.courierTariff, o.courierRequestId, idempotencyKey],
  );
  return orderFromRow(rows[0]!);
}

export async function getOrder(db: Queryable, id: string, lock = false): Promise<FoodOrder | null> {
  const { rows } = await db.query(`SELECT * FROM food_orders WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ? orderFromRow(rows[0]) : null;
}

export async function findByIdempotencyKey(db: Queryable, clientId: string, key: string): Promise<FoodOrder | null> {
  const { rows } = await db.query('SELECT * FROM food_orders WHERE client_id = $1 AND idempotency_key = $2', [clientId, key]);
  return rows[0] ? orderFromRow(rows[0]) : null;
}

export async function findByCourierOrder(db: Queryable, courierOrderId: string): Promise<FoodOrder | null> {
  const { rows } = await db.query('SELECT * FROM food_orders WHERE courier_order_id = $1 FOR UPDATE', [courierOrderId]);
  return rows[0] ? orderFromRow(rows[0]) : null;
}

export async function activeForRestaurant(db: Queryable, restaurantId: string): Promise<FoodOrder[]> {
  const { rows } = await db.query(
    `SELECT * FROM food_orders WHERE restaurant_id = $1 AND status IN ('placed', 'cooking', 'ready', 'delivering') ORDER BY created_at`,
    [restaurantId],
  );
  return rows.map(orderFromRow);
}

export async function activeForClient(db: Queryable, clientId: string): Promise<FoodOrder[]> {
  const { rows } = await db.query(
    `SELECT * FROM food_orders WHERE client_id = $1
       AND (status IN ('placed', 'cooking', 'ready', 'delivering') OR finished_at > now() - interval '1 hour')
     ORDER BY created_at DESC LIMIT 5`,
    [clientId],
  );
  return rows.map(orderFromRow);
}

/** Orders accepted by the kitchen but without a booked courier: the booking call failed or a retry is due. */
export async function awaitingCourier(db: Queryable): Promise<FoodOrder[]> {
  const { rows } = await db.query(`SELECT * FROM food_orders WHERE status IN ('cooking', 'ready') AND courier_order_id IS NULL`);
  return rows.map(orderFromRow);
}

const STAMP: Partial<Record<FoodStatus, string>> = {
  cooking: 'accepted_at',
  ready: 'ready_at',
  delivering: 'picked_up_at',
  delivered: 'finished_at',
  rejected: 'finished_at',
  cancelled: 'finished_at',
};

/** Compare-and-set status change; returns null if the order already moved on. */
export async function move(db: Queryable, id: string, from: FoodStatus[], to: FoodStatus, cancelReason: string | null = null): Promise<FoodOrder | null> {
  const stamp = STAMP[to];
  const { rows } = await db.query(
    `UPDATE food_orders SET status = $2, ${stamp ? `${stamp} = now(),` : ''} cancel_reason = COALESCE($4, cancel_reason), updated_at = now()
     WHERE id = $1 AND status = ANY($3) RETURNING *`,
    [id, to, from, cancelReason],
  );
  return rows[0] ? orderFromRow(rows[0]) : null;
}

export async function setCourierBooking(db: Queryable, id: string, courierOrderId: string, code: string | null): Promise<void> {
  await db.query('UPDATE food_orders SET courier_order_id = $2, delivery_code = $3, updated_at = now() WHERE id = $1', [id, courierOrderId, code]);
}

export async function setCourier(db: Queryable, id: string, courier: Courier): Promise<void> {
  await db.query('UPDATE food_orders SET courier = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(courier)]);
}

export async function startNextCourierAttempt(db: Queryable, id: string, tariff: TariffId, requestId: string): Promise<void> {
  await db.query(
    `UPDATE food_orders SET courier_order_id = NULL, courier = NULL, delivery_code = NULL, courier_tariff = $2,
       courier_request_id = $3, courier_attempts = courier_attempts + 1, updated_at = now() WHERE id = $1`,
    [id, tariff, requestId],
  );
}
