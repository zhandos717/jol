import type { DriverAccount, DriverCard, DriverProfile, RiderCard } from '@jol/contracts';
import type { DbClient, Pool } from '@jol/kit';
import { averageRating } from './rating.js';

type Queryable = Pool | DbClient;

interface DriverRow {
  id: string;
  name: string;
  car: string;
  plate: string;
  tariff: DriverProfile['tariff'];
  rating_sum: number;
  rating_count: number;
  trips: number;
  earned: string;
}

const toAccount = (r: DriverRow): DriverAccount => ({
  id: r.id,
  name: r.name,
  car: r.car,
  plate: r.plate,
  tariff: r.tariff,
  rating: averageRating(r.rating_sum, r.rating_count),
  trips: r.trips,
  earned: Number(r.earned),
});

export async function upsertDriver(db: Queryable, p: DriverProfile): Promise<DriverAccount> {
  const { rows } = await db.query<DriverRow>(
    `INSERT INTO drivers (id, name, car, plate, tariff) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET name = $2, car = $3, plate = $4, tariff = $5, updated_at = now()
     RETURNING *`,
    [p.id, p.name, p.car, p.plate, p.tariff],
  );
  return toAccount(rows[0]!);
}

export async function findDriver(db: Queryable, id: string): Promise<DriverAccount | null> {
  const { rows } = await db.query<DriverRow>('SELECT * FROM drivers WHERE id = $1', [id]);
  return rows[0] ? toAccount(rows[0]) : null;
}

export function toCard({ earned: _earned, ...card }: DriverAccount): DriverCard {
  return card;
}

export async function findRider(db: Queryable, id: string): Promise<RiderCard> {
  const { rows } = await db.query<{ rating_sum: number; rating_count: number; trips: number }>(
    'SELECT rating_sum, rating_count, trips FROM riders WHERE id = $1',
    [id],
  );
  const r = rows[0];
  return { id, rating: averageRating(r?.rating_sum ?? 0, r?.rating_count ?? 0), trips: r?.trips ?? 0 };
}

export async function addDriverEarnings(db: Queryable, id: string, amount: number): Promise<void> {
  await db.query('UPDATE drivers SET earned = earned + $2, trips = trips + 1, updated_at = now() WHERE id = $1', [id, amount]);
}

export async function addRiderTrip(db: Queryable, id: string): Promise<void> {
  await db.query(
    `INSERT INTO riders (id, trips) VALUES ($1, 1)
     ON CONFLICT (id) DO UPDATE SET trips = riders.trips + 1, updated_at = now()`,
    [id],
  );
}

/** Applies one rating and returns the new average. */
export async function addRating(db: Queryable, role: 'driver' | 'client', id: string, stars: number): Promise<number> {
  const sql =
    role === 'driver'
      ? `UPDATE drivers SET rating_sum = rating_sum + $2, rating_count = rating_count + 1, updated_at = now()
         WHERE id = $1 RETURNING rating_sum, rating_count`
      : `INSERT INTO riders (id, rating_sum, rating_count) VALUES ($1, $2, 1)
         ON CONFLICT (id) DO UPDATE SET rating_sum = riders.rating_sum + $2, rating_count = riders.rating_count + 1, updated_at = now()
         RETURNING rating_sum, rating_count`;
  const { rows } = await db.query<{ rating_sum: number; rating_count: number }>(sql, [id, stars]);
  const r = rows[0];
  return r ? averageRating(r.rating_sum, r.rating_count) : NaN;
}
