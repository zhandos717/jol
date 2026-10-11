import {
  AckPolicy,
  DeliverPolicy,
  connect,
  type JetStreamClient,
  type JetStreamManager,
  type KV,
  type NatsConnection,
  type Subscription,
} from 'nats';
import {
  Rpc,
  STREAM,
  STREAM_SUBJECTS,
  notifySubject,
  parseEvent,
  type Audience,
  type AnyEvent,
  type EventEnvelope,
  type EventType,
  type NotifyEvent,
  type RpcHandled,
  type RpcRequest,
  type RpcResponse,
  type RpcSubject,
} from '@jol/contracts';
import { DomainError } from './errors.js';
import type { Logger } from './logger.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const encode = (v: unknown) => enc.encode(JSON.stringify(v));
const decode = (d: Uint8Array) => JSON.parse(dec.decode(d)) as unknown;

const RPC_TIMEOUT_MS = 3000;
const REDELIVERY_DELAY_MS = 2000;
const DUPLICATE_WINDOW_NS = 2 * 60 * 1e9;

type RpcReply = { ok: true; data: unknown } | { ok: false; error: { status: number; code: string; message: string } };

/**
 * Thin typed facade over NATS:
 * - domain events: JetStream stream `JOL`, at-least-once, durable consumers, dedupe by event id;
 * - RPC: core request/reply with a queue group per service, schemas validated on both sides;
 * - notifications: core publish to `notify.<role>.<id>`, best effort.
 */
export class Bus {
  private constructor(
    readonly nc: NatsConnection,
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly service: string,
    private readonly log: Logger,
  ) {}

  static async connect(url: string, service: string, log: Logger): Promise<Bus> {
    const nc = await connect({ servers: url, name: service, maxReconnectAttempts: -1, reconnectTimeWait: 1000 });
    const jsm = await nc.jetstreamManager();
    const bus = new Bus(nc, nc.jetstream(), jsm, service, log);
    await bus.ensureStream();
    log.info({ url }, 'connected to NATS');
    return bus;
  }

  private async ensureStream() {
    const config = { name: STREAM, subjects: STREAM_SUBJECTS, duplicate_window: DUPLICATE_WINDOW_NS };
    try {
      await this.jsm.streams.info(STREAM);
      await this.jsm.streams.update(STREAM, config);
    } catch {
      await this.jsm.streams.add(config);
    }
  }

  async publish(event: EventEnvelope): Promise<void> {
    await this.js.publish(event.type, encode(event), { msgID: event.id });
  }

  /**
   * Durable pull consumer. Handler errors cause a delayed redelivery; malformed messages are terminated
   * so one bad payload cannot block the consumer.
   */
  async subscribe(durable: string, types: EventType[], handler: (event: AnyEvent) => Promise<void>): Promise<void> {
    const config = {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subjects: types,
      max_deliver: 20,
      ack_wait: 30e9,
    };
    try {
      await this.jsm.consumers.add(STREAM, config);
    } catch {
      await this.jsm.consumers.update(STREAM, durable, config);
    }
    const consumer = await this.js.consumers.get(STREAM, durable);
    const messages = await consumer.consume();
    void (async () => {
      for await (const m of messages) {
        let event: AnyEvent;
        try {
          event = parseEvent(decode(m.data));
        } catch (err) {
          this.log.error({ err, subject: m.subject }, 'malformed event, terminating');
          m.term();
          continue;
        }
        try {
          await handler(event);
          m.ack();
        } catch (err) {
          this.log.error({ err, type: event.type, id: event.id }, 'event handler failed, will retry');
          m.nak(REDELIVERY_DELAY_MS);
        }
      }
    })();
    this.log.info({ durable, types }, 'consumer started');
  }

  /**
   * Ordered ephemeral consumer starting from now: for services whose state is in memory
   * and rebuilt from a snapshot on start, so replaying history is neither needed nor wanted.
   */
  async follow(types: EventType[], handler: (event: AnyEvent) => Promise<void> | void): Promise<void> {
    const consumer = await this.js.consumers.get(STREAM, { filterSubjects: types, deliver_policy: DeliverPolicy.New });
    const messages = await consumer.consume();
    void (async () => {
      for await (const m of messages) {
        try {
          await handler(parseEvent(decode(m.data)));
        } catch (err) {
          this.log.error({ err, subject: m.subject }, 'event handler failed');
        }
      }
    })();
    this.log.info({ types }, 'following events');
  }

  serve<S extends RpcSubject>(subject: S, handler: (req: RpcHandled<S>) => Promise<RpcResponse<S>>): Subscription {
    const spec = Rpc[subject];
    const sub = this.nc.subscribe(subject, { queue: this.service });
    void (async () => {
      for await (const m of sub) {
        let reply: RpcReply;
        try {
          const req = spec.request.parse(decode(m.data));
          const res = await handler(req as never);
          reply = { ok: true, data: spec.response.parse(res) };
        } catch (err) {
          const e = err instanceof DomainError ? err : new DomainError(500, 'internal', (err as Error).message);
          if (e.status >= 500) this.log.error({ err, subject }, 'rpc handler failed');
          reply = { ok: false, error: e.toJSON() };
        }
        m.respond(encode(reply));
      }
    })();
    return sub;
  }

  async request<S extends RpcSubject>(subject: S, data: RpcRequest<S>, timeout = RPC_TIMEOUT_MS): Promise<RpcResponse<S>> {
    let msg;
    try {
      msg = await this.nc.request(subject, encode(data), { timeout });
    } catch (err) {
      throw new DomainError(503, 'unavailable', `${subject}: ${(err as Error).message}`);
    }
    const reply = decode(msg.data) as RpcReply;
    if (!reply.ok) throw new DomainError(reply.error.status, reply.error.code, reply.error.message);
    return Rpc[subject].response.parse(reply.data) as RpcResponse<S>;
  }

  notify(role: Audience, id: string, event: NotifyEvent, data: unknown): void {
    this.nc.publish(notifySubject(role, id), encode({ event, data }));
  }

  subscribeRaw(subject: string): Subscription {
    return this.nc.subscribe(subject);
  }

  kv(bucket: string, ttlMs: number): Promise<KV> {
    return this.js.views.kv(bucket, { ttl: ttlMs, history: 1 });
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}

export { decode as decodeJson, encode as encodeJson };
