// Runs inside the compose network (see `make bench`) and calls services directly,
// so it measures service throughput rather than the gateway's per-client rate limit.
const FLEET = process.env.FLEET_URL || 'http://fleet:8080';
const PRICING = process.env.PRICING_URL || 'http://pricing:8080';
const DRIVERS = +(process.argv[2] || 1000);
const post = (base, p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const rnd = (a, d) => a + Math.random() * d;

async function bench(name, total, concurrency, request) {
  let started = 0, failed = 0;
  const latency = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (started < total) {
      started++;
      const s = performance.now();
      const r = await request();
      if (!r.ok) failed++;
      await r.text();
      latency.push(performance.now() - s);
    }
  }));
  const sec = (performance.now() - t0) / 1000;
  latency.sort((a, b) => a - b);
  const p = q => latency[Math.floor(latency.length * q)].toFixed(0);
  console.log(`${name.padEnd(28)} ${String(Math.round(total / sec)).padStart(6)} req/s   p50 ${p(.5)} ms   p99 ${p(.99)} ms   ошибок ${failed}`);
}

(async () => {
  const ids = Array.from({ length: DRIVERS }, (_, i) => `bench-${i}`);
  for (let i = 0; i < ids.length; i += 200) {
    await Promise.all(ids.slice(i, i + 200).map(id => post(FLEET, '/api/driver/online',
      { id, name: 'Bench', car: 'Bench', plate: '000', tariff: 'eco', lat: rnd(43.2, .1), lon: rnd(76.85, .1) }).then(r => r.text())));
  }
  console.log(`Водителей онлайн: ${DRIVERS}\n`);
  await bench('координаты водителя', 20000, 100, () => post(FLEET, '/api/driver/location', { id: ids[Math.floor(Math.random() * ids.length)], lat: rnd(43.2, .1), lon: rnd(76.85, .1) }));
  await bench('машины рядом', 3000, 50, () => fetch(`${FLEET}/api/drivers/nearby?lat=43.25&lon=76.9`));
  await bench('карта спроса', 3000, 50, () => fetch(`${PRICING}/api/surge/map?lat=43.25&lon=76.9`));
  await bench('расчёт цены (OSRM)', 2000, 50, () => post(PRICING, '/api/quote', { from: { lat: rnd(43.2, .08), lon: rnd(76.85, .1) }, to: { lat: rnd(43.2, .08), lon: rnd(76.85, .1) } }));
  await Promise.all(ids.map(id => post(FLEET, '/api/driver/offline', { id }).then(r => r.text())));
})();
