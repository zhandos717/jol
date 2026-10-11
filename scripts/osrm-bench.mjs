// Compares OSRM setups on identical random routes. Run inside the container network:
//   node scripts/osrm-bench.mjs http://osrm-bench:5000
const BASE = process.argv[2] ?? 'http://localhost:5000';
const rnd = (a, d) => a + Math.random() * d;
const CITIES = [[43.2389, 76.8897], [51.1283, 71.4305], [42.3155, 69.5869], [49.8047, 73.1094], [43.8667, 77.0667]];

async function run(name, total, concurrency, makeUrl) {
  let i = 0, failed = 0;
  const lat = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < total) {
      i++;
      const s = performance.now();
      const r = await fetch(BASE + makeUrl());
      const j = await r.json();
      if (j.code !== 'Ok') failed++;
      lat.push(performance.now() - s);
    }
  }));
  lat.sort((a, b) => a - b);
  const p = q => lat[Math.floor(lat.length * q)].toFixed(0);
  console.log(`${name.padEnd(30)} ${String(Math.round(total / ((performance.now() - t0) / 1000))).padStart(5)} req/s  p50 ${p(0.5)} ms  p99 ${p(0.99)} ms  ошибок ${failed}`);
}

const city = full => () => {
  const a = `${rnd(76.82, 0.16)},${rnd(43.18, 0.12)}`, b = `${rnd(76.82, 0.16)},${rnd(43.18, 0.12)}`;
  return `/route/v1/driving/${a};${b}?${full ? 'overview=full&geometries=geojson&steps=true' : 'overview=false'}`;
};
const intercity = () => {
  const [a, b] = [CITIES[Math.floor(Math.random() * 5)], CITIES[Math.floor(Math.random() * 5)]];
  return `/route/v1/driving/${a[1]},${a[0]};${b[1] + 0.01},${b[0] + 0.01}?overview=false`;
};

await run('прогрев', 300, 10, city(false));
await run('цена: город', 2000, 20, city(false));
await run('карта: город, геометрия+шаги', 500, 10, city(true));
await run('межгород', 200, 5, intercity);
