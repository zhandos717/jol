import { z } from 'zod';
import { Id, notifySubject, type Notification } from '@jol/contracts';
import { createHttp, decodeJson, defineService } from '@jol/kit';
import { SSE_PING, sseFrame } from './sse.js';

const PING_EVERY_MS = 20_000;
const Query = z.object({ role: z.enum(['client', 'driver', 'restaurant']), id: Id });

/**
 * Edge for push updates. Stateless: each open stream is a NATS subscription on `notify.<role>.<id>`,
 * so any number of replicas can run behind the gateway.
 */
export default defineService(z.object({}), async ({ config, log, bus, onShutdown }) => {
  let open = 0;
  const http = createHttp(log, { nats: async () => void (await bus.nc.flush()) });

  http.get('/api/events', async (req, reply) => {
    const { role, id } = Query.parse(req.query);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    open++;

    const sub = bus.subscribeRaw(notifySubject(role, id));
    void (async () => {
      for await (const m of sub) {
        const n = decodeJson(m.data) as Notification;
        res.write(sseFrame(n.event, n.data));
      }
    })();

    if (role !== 'restaurant') try {
      const snap = await bus.request('dispatch.snapshot', { role, id });
      if (snap.order) res.write(sseFrame('order', snap.order));
      if (snap.offer) res.write(sseFrame('offer', snap.offer));
    } catch (err) {
      req.log.warn({ err }, 'snapshot unavailable; stream continues with live updates only');
    }

    const ping = setInterval(() => res.write(SSE_PING), PING_EVERY_MS);
    req.raw.on('close', () => {
      clearInterval(ping);
      sub.unsubscribe();
      open--;
    });
  });

  http.get('/metrics/streams', async () => ({ open }));

  await http.listen({ host: '0.0.0.0', port: config.PORT });
  onShutdown(() => http.close());
});
