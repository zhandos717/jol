# Архитектура Jol

Документ для инженеров, которые будут развивать систему: как она устроена, почему именно так и где её пределы. Решения с обоснованием и альтернативами — в [ADR](adr/).

## 1. Контекст (C4, уровень 1)

```mermaid
flowchart LR
  P([Пассажир<br/>веб-приложение]) -->|заказ, оплата, оценка| J[Jol]
  D([Водитель<br/>веб-приложение]) -->|линия, координаты, заказы| J
  J -->|маршруты| O[(OSRM<br/>карта Казахстана)]
  P -.->|тайлы и поиск адресов| OSM[(OpenStreetMap<br/>Nominatim)]
  D -.->|тайлы| OSM
```

## 2. Контейнеры (C4, уровень 2)

```mermaid
flowchart TB
  subgraph Edge
    GW[gateway<br/>nginx: статика, маршрутизация,<br/>rate limit, X-Request-Id]
  end

  subgraph Services
    ACC[accounts<br/>профили, рейтинги, заработок]
    FLT[fleet<br/>онлайн и координаты водителей]
    PRC[pricing<br/>цена, коэффициент спроса]
    DSP[dispatch<br/>заказы, раздача, расписание]
    INT[intercity<br/>рейсы с попутчиками]
    FOOD[food<br/>рестораны, заказы еды]
    RT[realtime<br/>SSE в браузеры]
  end

  subgraph Data
    PG[(PostgreSQL<br/>схема на сервис)]
    NATS{{NATS JetStream<br/>события, RPC, KV}}
    OSRM[(OSRM)]
  end

  GW --> ACC & FLT & PRC & DSP & INT & FOOD & RT
  GW --> OSRM
  ACC & DSP & INT & FOOD --> PG
  PRC & INT --> OSRM
  ACC & FLT & PRC & DSP & INT & FOOD & RT <--> NATS
  FOOD -. dispatch.delivery.request .-> DSP
```

| Сервис | Ответственность | Данные | Почему отдельный |
|---|---|---|---|
| `accounts` | профили водителей и пассажиров, рейтинги, заработок | PostgreSQL `accounts` | меняется редко, нужен строгий учёт денег и оценок |
| `fleet` | онлайн-присутствие, координаты, поиск ближайших | память | горячий путь: тысячи обновлений в секунду, данные живут секунды |
| `pricing` | расчёт цены, коэффициент спроса, фиксация цены | NATS KV (TTL 3 мин) | бизнес-правила цены меняются чаще всего, без БД |
| `dispatch` | жизненный цикл заказа, раздача водителям, заказы на время | PostgreSQL `dispatch` | ядро домена, транзакционные переходы статусов |
| `intercity` | рейсы с попутчиками, брони мест | PostgreSQL `intercity` | другая модель (рейс и места), другой ритм |
| `food` | рестораны, меню, заказ еды, оркестрация курьера | PostgreSQL `food` | кухня — свой процесс и своя модель; курьера берёт у `dispatch` |
| `realtime` | доставка событий в браузер через SSE | — | держит тысячи долгих соединений, масштабируется отдельно |

## 3. Взаимодействие

Три вида связей, каждый для своей задачи:

| Тип | Транспорт | Гарантия | Пример |
|---|---|---|---|
| Доменные события | JetStream, стрим `JOL` | at-least-once, durable-потребители, дедупликация по id | `jol.dispatch.order.completed` → `accounts` начисляет заработок |
| Синхронные запросы | NATS request/reply | таймаут 3 с, схема запроса и ответа проверяется с обеих сторон | `dispatch` → `fleet.candidates` |
| Уведомления клиентам | core NATS `notify.<role>.<id>` | best effort | `dispatch` → `realtime` → браузер пассажира |

Все контракты в одном месте — пакет [`@jol/contracts`](../../packages/contracts/src). Каталог событий — [events.md](events.md).

## 4. Жизненный цикл заказа

```mermaid
sequenceDiagram
  autonumber
  participant C as Пассажир
  participant GW as gateway
  participant PR as pricing
  participant DS as dispatch
  participant FL as fleet
  participant AC as accounts
  participant RT as realtime
  participant D as Водитель

  C->>GW: POST /api/quote
  GW->>PR: цена всех тарифов
  PR-->>C: цены, quoteId (зафиксировано в KV на 3 мин)
  C->>GW: POST /api/orders {quoteId}
  GW->>DS: создать заказ
  DS->>PR: pricing.price (по quoteId)
  DS->>AC: accounts.rider.card
  DS->>DS: INSERT order + outbox(order.created) в одной транзакции
  DS->>FL: fleet.candidates (ближайший свободный)
  DS-)RT: notify.driver: offer (15 с на ответ)
  RT-)D: SSE offer
  D->>GW: POST /api/orders/:id/accept
  GW->>DS: CAS searching→accepted + outbox(order.accepted)
  DS-)RT: notify.client: order(accepted)
  Note over FL: order.accepted из JetStream:<br/>водитель занят, координаты идут пассажиру
  D->>GW: arrived → start → finish
  DS-)AC: order.completed (через outbox)
  AC->>AC: inbox(event_id) + заработок + поездки
```

Если водитель отказался или молчит 15 секунд, заказ уходит следующему ближайшему. Через 90 секунд без согласия — статус `no_drivers`.

## 5. Доставка: посылки и еда

Курьерские тарифы (`courier_foot`, `courier_bike`, `courier_car`) — это обычные заказы `dispatch` со своим радиусом поиска (2, 5 и 15 км) и блоком `delivery`: получатель, что везём и 4-значный код вручения ([ADR-0013](adr/0013-proof-of-delivery-pin.md)).

Еда — отдельный процесс в сервисе `food`, который использует курьерскую доставку `dispatch` как сервис ([ADR-0012](adr/0012-food-orchestrates-delivery.md)):

```mermaid
sequenceDiagram
  autonumber
  participant C as Клиент
  participant F as food
  participant R as Ресторан
  participant DS as dispatch
  participant K as Курьер

  C->>F: POST /api/food/orders (Idempotency-Key)
  F->>F: цены из меню, доставка через pricing, outbox(food.order.placed)
  F-)R: notify.restaurant: новый заказ
  R->>F: Принять
  F->>F: placed → cooking
  F->>DS: dispatch.delivery.request (externalId = courier_request_id)
  DS-->>F: заказ курьера + код вручения
  F-)C: notify.client: готовится, код 8693
  DS-)K: предложение
  K->>DS: принять → прибыл → забрал
  DS-)F: order.accepted / started (source = food)
  F-)C: курьер Данияр, в пути
  K->>DS: finish {code: 8693}
  DS-)F: order.completed
  F->>F: delivering → delivered
  Note over F,DS: Нет курьера за 90 с → order.cancelled(no_drivers) →<br/>food повторяет с courier_car, после второй неудачи — no_courier
```

## 6. Надёжность

- **Нет потерянных событий.** Изменение состояния и событие пишутся в одной транзакции (transactional outbox, [ADR-0004](adr/0004-outbox-and-idempotent-consumers.md)). Relay публикует с `Nats-Msg-Id = event.id`, JetStream отбрасывает дубли в окне 2 минуты.
- **Нет двойной обработки.** Потребители с состоянием (`accounts`) записывают id события в `inbox` в той же транзакции, что и эффект.
- **Нет гонок за заказ.** Переходы статусов — compare-and-set: `UPDATE … WHERE status = ANY(<разрешённые источники>)`. Плюс частичные уникальные индексы: один активный заказ на пассажира и на водителя.
- **Деградация вместо падения.** `accounts` недоступен → заказ создаётся с карточкой пассажира по умолчанию. `fleet` недоступен для `pricing` → используется последнее известное предложение машин.
- **Корректная остановка.** SIGTERM: HTTP перестаёт принимать запросы, outbox дописывает очередь, NATS-соединение drain'ится, пул БД закрывается.
- **Самовосстановление памяти.** `fleet` после рестарта забирает активные назначения у `dispatch`; водители возвращаются сами, потому что приложение повторно выходит на линию, если сервер их не знает.

## 7. Масштабирование

| Сервис | Как растёт | Ограничение сейчас |
|---|---|---|
| `realtime`, `pricing`, `accounts`, `intercity`, `food` | горизонтально, без изменений: queue group в NATS, состояние в БД или KV | — |
| `fleet` | шардирование по городам или H3-ячейкам; или состояние в Redis/NATS KV | один экземпляр, состояние в памяти ([ADR-0006](adr/0006-fleet-presence-in-memory.md)) |
| `dispatch` | партиционирование по городу, лидер на партицию через NATS KV-лок | один активный экземпляр, офферы в памяти ([ADR-0007](adr/0007-single-active-dispatcher.md)) |
| PostgreSQL | реплики на чтение для истории; при росте — вынос схем в отдельные кластеры без изменения кода | один кластер |

Замер нагрузки монолитной версии на 1 vCPU: ~10 000 обновлений координат в секунду, ~800 расчётов цены в секунду. Сервисная версия держит те же пути, теперь их можно масштабировать независимо.

## 8. Наблюдаемость

- Логи — структурированный JSON (pino) с полем `service`; gateway пишет JSON-лог доступа.
- `X-Request-Id` создаётся на шлюзе, передаётся в сервисы и попадает в каждую строку лога запроса.
- У каждого сервиса `/healthz` (жив ли процесс) и `/readyz` (доступны ли БД и NATS) — для оркестратора.
- Мониторинг NATS — `:8222` (стримы, отставание потребителей).

Следующий шаг — OpenTelemetry: трассировка через HTTP и заголовки NATS, метрики в Prometheus.

## 9. Безопасность: что сознательно не сделано

Это демонстрационный проект, и это главный пробел перед продакшеном: **нет аутентификации.** Пассажир и водитель определяются по id, который генерирует браузер. Сервер проверяет владение заказом по этому id, но подделать его может любой. План: вход по SMS → JWT на шлюзе → `sub` из токена вместо id в теле запроса.
