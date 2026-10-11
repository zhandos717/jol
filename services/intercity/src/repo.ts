import type { DriverCard, Place, RiderCard } from '@jol/contracts';
import type { DbClient, Pool } from '@jol/kit';
import type { TripStatus } from './rules.js';

type Queryable = Pool | DbClient;

export interface Booking {
  clientId: string;
  seats: number;
  rider: Omit<RiderCard, 'id'>;
}

export interface Trip {
  id: string;
  driverId: string;
  status: TripStatus;
  from: Place;
  to: Place;
  departAt: number;
  seats: number;
  pricePerSeat: number;
  km: number;
  hours: number;
  comment: string;
  driver: DriverCard;
  bookings: Booking[];
}

interface Row {
  id: string;
  driver_id: string;
  status: TripStatus;
  from_lat: number;
  from_lon: number;
  from_label: string;
  to_lat: number;
  to_lon: number;
  to_label: string;
  depart_at: Date;
  seats: number;
  price_per_seat: number;
  km: string;
  hours: string;
  comment: string;
  driver_snapshot: DriverCard;
  bookings: Array<{ client_id: string; seats: number; rider_snapshot: Omit<RiderCard, 'id'> }> | null;
}

const SELECT = `
  SELECT t.*, (
    SELECT json_agg(json_build_object('client_id', b.client_id, 'seats', b.seats, 'rider_snapshot', b.rider_snapshot))
    FROM bookings b WHERE b.trip_id = t.id AND b.status = 'active'
  ) AS bookings
  FROM trips t`;

const fromRow = (r: Row): Trip => ({
  id: r.id,
  driverId: r.driver_id,
  status: r.status,
  from: { lat: r.from_lat, lon: r.from_lon, label: r.from_label },
  to: { lat: r.to_lat, lon: r.to_lon, label: r.to_label },
  departAt: r.depart_at.getTime(),
  seats: r.seats,
  pricePerSeat: r.price_per_seat,
  km: Number(r.km),
  hours: Number(r.hours),
  comment: r.comment,
  driver: r.driver_snapshot,
  bookings: (r.bookings ?? []).map(b => ({ clientId: b.client_id, seats: b.seats, rider: b.rider_snapshot })),
});

export const seatsTaken = (t: Trip) => t.bookings.reduce((n, b) => n + b.seats, 0);

export async function insert(db: Queryable, t: Omit<Trip, 'bookings' | 'status'>): Promise<Trip> {
  await db.query(
    `INSERT INTO trips (id, driver_id, status, from_lat, from_lon, from_label, to_lat, to_lon, to_label,
       depart_at, seats, price_per_seat, km, hours, comment, driver_snapshot)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0), $10, $11, $12, $13, $14, $15)`,
    [t.id, t.driverId, t.from.lat, t.from.lon, t.from.label, t.to.lat, t.to.lon, t.to.label, t.departAt, t.seats,
      t.pricePerSeat, t.km, t.hours, t.comment, JSON.stringify(t.driver)],
  );
  return (await get(db, t.id))!;
}

export async function get(db: Queryable, id: string, lock = false): Promise<Trip | null> {
  if (lock) await db.query('SELECT 1 FROM trips WHERE id = $1 FOR UPDATE', [id]);
  const { rows } = await db.query<Row>(`${SELECT} WHERE t.id = $1`, [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function openBetween(db: Queryable, fromMs: number, toMs: number): Promise<Trip[]> {
  const { rows } = await db.query<Row>(
    `${SELECT} WHERE t.status = 'open' AND t.depart_at > now()
       AND t.depart_at >= to_timestamp($1 / 1000.0) AND t.depart_at < to_timestamp($2 / 1000.0)
     ORDER BY t.depart_at`,
    [fromMs, toMs],
  );
  return rows.map(fromRow);
}

export async function activeForDriver(db: Queryable, driverId: string): Promise<Trip[]> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE t.driver_id = $1 AND t.status IN ('open', 'departed') ORDER BY t.depart_at`, [driverId]);
  return rows.map(fromRow);
}

export async function activeForClient(db: Queryable, clientId: string): Promise<Trip[]> {
  const { rows } = await db.query<Row>(
    `${SELECT} WHERE t.status IN ('open', 'departed')
       AND EXISTS (SELECT 1 FROM bookings b WHERE b.trip_id = t.id AND b.client_id = $1 AND b.status = 'active')
     ORDER BY t.depart_at`,
    [clientId],
  );
  return rows.map(fromRow);
}

export async function addBooking(db: Queryable, tripId: string, b: Booking): Promise<void> {
  await db.query('INSERT INTO bookings (trip_id, client_id, seats, rider_snapshot) VALUES ($1, $2, $3, $4)', [
    tripId, b.clientId, b.seats, JSON.stringify(b.rider),
  ]);
}

export async function cancelBooking(db: Queryable, tripId: string, clientId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE trip_id = $1 AND client_id = $2 AND status = 'active'`,
    [tripId, clientId],
  );
  return !!rowCount;
}

export async function setStatus(db: Queryable, id: string, from: TripStatus, to: TripStatus): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE trips SET status = $3, updated_at = now() WHERE id = $1 AND status = $2', [id, from, to]);
  return !!rowCount;
}
