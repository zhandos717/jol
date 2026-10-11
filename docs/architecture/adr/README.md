# Architecture Decision Records

Каждое значимое решение записано отдельно: контекст, решение, альтернативы, последствия. Решения не переписываются — если решение меняется, появляется новая запись со ссылкой на старую.

| # | Решение | Статус |
|---|---|---|
| [0001](0001-microservices-in-a-monorepo.md) | Микросервисы в монорепозитории | Принято |
| [0002](0002-nats-jetstream.md) | NATS JetStream для событий, RPC и KV | Принято |
| [0003](0003-database-per-service.md) | База на сервис: роль и схема в общем кластере | Принято |
| [0004](0004-outbox-and-idempotent-consumers.md) | Transactional outbox и идемпотентные потребители | Принято |
| [0005](0005-sse-for-realtime.md) | SSE вместо WebSocket | Принято |
| [0006](0006-fleet-presence-in-memory.md) | Присутствие водителей в памяти | Принято |
| [0007](0007-single-active-dispatcher.md) | Один активный dispatcher | Принято, пересмотреть при запуске второго города |
| [0008](0008-self-hosted-routing.md) | Свой OSRM, внешний геокодер | Принято |
| [0009](0009-no-postgis-yet.md) | PostGIS пока не нужен | Принято |
| [0010](0010-price-lock-in-kv.md) | Фиксация цены через NATS KV с TTL | Принято |
| [0011](0011-idempotent-order-creation.md) | Идемпотентное создание заказа | Принято |
