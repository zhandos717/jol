const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const ACTIVE_ORDER = ['scheduled', 'searching', 'accepted', 'arrived', 'in_progress'];
const RECENT_MS = 24 * 60 * 60 * 1000;
const VOLATILE_DRIVER_FIELDS = new Set(['lat', 'lon', 'heading', 'online']);

const TABLES = {
  drivers: {
    snapshot: d => JSON.stringify(d, (k, v) => (VOLATILE_DRIVER_FIELDS.has(k) ? undefined : v)),
    sql: `INSERT INTO drivers (id, name, car, plate, tariff, rating_sum, rating_count, earned, trips, data, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
          ON CONFLICT (id) DO UPDATE SET name = $2, car = $3, plate = $4, tariff = $5, rating_sum = $6,
            rating_count = $7, earned = $8, trips = $9, data = $10, updated_at = now()`,
    params: (d, json) => [d.id, d.name, d.car || '', d.plate || '', d.tariff, d.ratingSum || 0, d.ratingCount || 0, d.earned || 0, d.trips || 0, json],
  },
  clients: {
    snapshot: c => JSON.stringify(c),
    sql: `INSERT INTO clients (id, rating_sum, rating_count, trips, data, updated_at)
          VALUES ($1, $2, $3, $4, $5, now())
          ON CONFLICT (id) DO UPDATE SET rating_sum = $2, rating_count = $3, trips = $4, data = $5, updated_at = now()`,
    params: (c, json, id) => [id, c.ratingSum || 0, c.ratingCount || 0, c.trips || 0, json],
  },
  orders: {
    snapshot: o => JSON.stringify(o),
    sql: `INSERT INTO orders (id, client_id, driver_id, tariff, status, price, surge, km, created_at, depart_at, data, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0), to_timestamp($10 / 1000.0), $11, now())
          ON CONFLICT (id) DO UPDATE SET driver_id = $3, status = $5, price = $6, data = $11, updated_at = now()`,
    params: (o, json) => [o.id, o.clientId, o.driverId, o.tariff, o.status, o.price, o.surge || 1, o.km, o.createdAt, o.departAt, json],
  },
  trips: {
    snapshot: t => JSON.stringify(t),
    sql: `INSERT INTO trips (id, driver_id, status, depart_at, seats, price_per_seat, data, updated_at)
          VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6, $7, now())
          ON CONFLICT (id) DO UPDATE SET status = $3, data = $7, updated_at = now()`,
    params: (t, json) => [t.id, t.driverId, t.status, t.departAt, t.seats, t.pricePerSeat, json],
  },
};

const saved = new Map();

async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await pool.query("COMMENT ON TABLE schema_migrations IS 'Применённые SQL-миграции из папки migrations'");
  await pool.query("COMMENT ON COLUMN schema_migrations.name IS 'Имя файла миграции'");
  await pool.query("COMMENT ON COLUMN schema_migrations.applied_at IS 'Когда миграция была применена'");
  const dir = path.join(__dirname, 'migrations');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Миграция применена: ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

async function load() {
  const db = { drivers: {}, clients: {}, orders: {}, trips: {} };
  const since = new Date(Date.now() - RECENT_MS);
  const rows = {
    drivers: await pool.query('SELECT id, data FROM drivers'),
    clients: await pool.query('SELECT id, data FROM clients'),
    orders: await pool.query('SELECT id, data FROM orders WHERE status = ANY($1) OR created_at >= $2', [ACTIVE_ORDER, since]),
    trips: await pool.query("SELECT id, data FROM trips WHERE status IN ('open', 'departed') OR depart_at >= $1", [since]),
  };
  for (const [table, res] of Object.entries(rows)) {
    for (const r of res.rows) {
      db[table][r.id] = r.data;
      saved.set(`${table}:${r.id}`, TABLES[table].snapshot(r.data));
    }
  }
  return db;
}

async function importJsonIfEmpty(db, file) {
  const { rows } = await pool.query('SELECT (SELECT count(*) FROM orders) + (SELECT count(*) FROM drivers) AS n');
  if (+rows[0].n > 0 || !fs.existsSync(file)) return false;
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const table of Object.keys(TABLES)) Object.assign(db[table], old[table] || {});
  await flush(db);
  console.log(`Импортировано из ${path.basename(file)}: ${Object.keys(old.orders || {}).length} заказов, ${Object.keys(old.drivers || {}).length} водителей`);
  return true;
}

let flushing = null;
async function flush(db) {
  if (flushing) return flushing;
  flushing = (async () => {
    const changes = [];
    for (const [table, cfg] of Object.entries(TABLES)) {
      for (const [id, entity] of Object.entries(db[table])) {
        const json = cfg.snapshot(entity);
        if (saved.get(`${table}:${id}`) !== json) changes.push({ table, id, entity, json });
      }
    }
    if (!changes.length) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of changes) await client.query(TABLES[c.table].sql, TABLES[c.table].params(c.entity, c.json, c.id));
      await client.query('COMMIT');
      for (const c of changes) saved.set(`${c.table}:${c.id}`, c.json);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

function evictFinished(db) {
  const cutoff = Date.now() - RECENT_MS;
  for (const [id, o] of Object.entries(db.orders)) {
    if (!ACTIVE_ORDER.includes(o.status) && o.createdAt < cutoff && saved.get(`orders:${id}`) === JSON.stringify(o)) {
      delete db.orders[id];
      saved.delete(`orders:${id}`);
    }
  }
  for (const [id, t] of Object.entries(db.trips)) {
    if (['done', 'cancelled'].includes(t.status) && t.departAt < cutoff && saved.get(`trips:${id}`) === JSON.stringify(t)) {
      delete db.trips[id];
      saved.delete(`trips:${id}`);
    }
  }
}

async function recentPlaces(clientId, limit) {
  const { rows } = await pool.query(
    `SELECT data FROM orders WHERE client_id = $1 AND status = 'done' ORDER BY created_at DESC LIMIT $2`,
    [clientId, limit],
  );
  return rows.map(r => r.data);
}

module.exports = { migrate, load, importJsonIfEmpty, flush, evictFinished, recentPlaces, close: () => pool.end() };
