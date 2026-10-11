import type { DriverView, GeoPoint, OrderStatus, Review, RiderCard, TariffId } from '@jol/contracts';
import type { DbClient, Pool } from '@jol/kit';
import { sourcesOf } from './state.js';

type Queryable = Pool | DbClient;

export interface Order {
  id: string;
  clientId: string;
  driverId: string | null;
  tariff: TariffId;
  status: OrderStatus;
  from: GeoPoint;
  to: GeoPoint;
  fromLabel: string;
  toLabel: string;
  km: number;
  min: number;
  price: number;
  surge: number;
  loaders: number;
  cargoNote: string;
  departAt: number | null;
  declined: string[];
  driver: DriverView | null;
  client: Omit<RiderCard, 'id'>;
  driverReview: Review | null;
  clientReview: Review | null;
  createdAt: number;
  searchStartedAt: number | null;
}

interface Row {
  id: string;
  client_id: string;
  driver_id: string | null;
  tariff: TariffId;
  status: OrderStatus;
  from_lat: number;
  from_lon: number;
  to_lat: number;
  to_lon: number;
  from_label: string;
  to_label: string;
  km: string;
  min: string;
  price: number;
  surge: string;
  loaders: number;
  cargo_note: string;
  depart_at: Date | null;
  declined: string[];
  driver_snapshot: DriverView | null;
  client_snapshot: Omit<RiderCard, 'id'>;
  driver_review: Review | null;
  client_review: Review | null;
  created_at: Date;
  search_started_at: Date | null;
}

const ms = (d: Date | null) => (d ? d.getTime() : null);

const fromRow = (r: Row): Order => ({
  id: r.id,
  clientId: r.client_id,
  driverId: r.driver_id,
  tariff: r.tariff,
  status: r.status,
  from: { lat: r.from_lat, lon: r.from_lon },
  to: { lat: r.to_lat, lon: r.to_lon },
  fromLabel: r.from_label,
  toLabel: r.to_label,
  km: Number(r.km),
  min: Number(r.min),
  price: r.price,
  surge: Number(r.surge),
  loaders: r.loaders,
  cargoNote: r.cargo_note,
  departAt: ms(r.depart_at),
  declined: r.declined,
  driver: r.driver_snapshot,
  client: r.client_snapshot,
  driverReview: r.driver_review,
  clientReview: r.client_review,
  createdAt: r.created_at.getTime(),
  searchStartedAt: ms(r.search_started_at),
});

const ACTIVE = `('scheduled', 'searching', 'accepted', 'arrived', 'in_progress')`;

const STAMP: Partial<Record<OrderStatus, string>> = {
  searching: 'search_started_at',
  accepted: 'accepted_at',
  arrived: 'arrived_at',
  in_progress: 'started_at',
  done: 'finished_at',
  cancelled: 'finished_at',
  no_drivers: 'finished_at',
};

export async function findByIdempotencyKey(db: Queryable, clientId: string, key: string): Promise<Order | null> {
  const { rows } = await db.query<Row>('SELECT * FROM orders WHERE client_id = $1 AND idempotency_key = $2', [clientId, key]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function insert(db: Queryable, o: Order, idempotencyKey: string | null = null): Promise<Order> {
  const { rows } = await db.query<Row>(
    `INSERT INTO orders (id, client_id, tariff, status, from_lat, from_lon, to_lat, to_lon, from_label, to_label,
       km, min, price, surge, loaders, cargo_note, depart_at, client_snapshot, search_started_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, to_timestamp($17 / 1000.0), $18,
       CASE WHEN $4 = 'searching' THEN now() END, $19)
     RETURNING *`,
    [
      o.id, o.clientId, o.tariff, o.status, o.from.lat, o.from.lon, o.to.lat, o.to.lon, o.fromLabel, o.toLabel,
      o.km, o.min, o.price, o.surge, o.loaders, o.cargoNote, o.departAt, JSON.stringify(o.client), idempotencyKey,
    ],
  );
  return fromRow(rows[0]!);
}

export async function get(db: Queryable, id: string): Promise<Order | null> {
  const { rows } = await db.query<Row>('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function activeFor(db: Queryable, role: 'client' | 'driver', id: string): Promise<Order | null> {
  const column = role === 'client' ? 'client_id' : 'driver_id';
  const { rows } = await db.query<Row>(`SELECT * FROM orders WHERE ${column} = $1 AND status IN ${ACTIVE} LIMIT 1`, [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listActive(db: Queryable): Promise<Order[]> {
  const { rows } = await db.query<Row>(`SELECT * FROM orders WHERE status IN ${ACTIVE}`);
  return rows.map(fromRow);
}

/** Scheduled orders whose departure is within `leadMs`; they move to `searching`. */
export async function dueScheduled(db: Queryable, leadMs: number): Promise<Order[]> {
  const { rows } = await db.query<Row>(
    `SELECT * FROM orders WHERE status = 'scheduled' AND depart_at <= now() + make_interval(secs => $1 / 1000.0)`,
    [leadMs],
  );
  return rows.map(fromRow);
}

/**
 * Compare-and-set status change. Returns null when the order is no longer in a state
 * that allows `to` — the caller lost a race and must not emit events.
 */
export async function transition(
  db: Queryable,
  id: string,
  to: OrderStatus,
  patch: { driverId?: string; driver?: DriverView } = {},
): Promise<Order | null> {
  const stamp = STAMP[to];
  const { rows } = await db.query<Row>(
    `UPDATE orders SET status = $2,
       driver_id = COALESCE($3, driver_id),
       driver_snapshot = COALESCE($4, driver_snapshot),
       ${stamp ? `${stamp} = now(),` : ''}
       updated_at = now()
     WHERE id = $1 AND status = ANY($5)
     RETURNING *`,
    [id, to, patch.driverId ?? null, patch.driver ? JSON.stringify(patch.driver) : null, sourcesOf(to)],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function addDeclined(db: Queryable, id: string, driverId: string): Promise<void> {
  await db.query(`UPDATE orders SET declined = array_append(declined, $2), updated_at = now() WHERE id = $1`, [id, driverId]);
}

export async function setReview(db: Queryable, id: string, field: 'driver_review' | 'client_review', review: Review): Promise<Order | null> {
  const { rows } = await db.query<Row>(
    `UPDATE orders SET ${field} = $2, updated_at = now() WHERE id = $1 AND status = 'done' AND ${field} IS NULL RETURNING *`,
    [id, JSON.stringify(review)],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function recentDone(db: Queryable, clientId: string, limit: number): Promise<Order[]> {
  const { rows } = await db.query<Row>(
    `SELECT * FROM orders WHERE client_id = $1 AND status = 'done' ORDER BY created_at DESC LIMIT $2`,
    [clientId, limit],
  );
  return rows.map(fromRow);
}
