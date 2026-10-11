# Каталог событий и контрактов

Источник истины — [`packages/contracts/src`](../../packages/contracts/src). Схемы zod проверяются при публикации (`makeEvent`) и при чтении (`parseEvent`), поэтому несовместимое событие не пройдёт ни туда, ни обратно.

## Конверт

```json
{ "id": "uuid", "type": "jol.dispatch.order.completed", "occurredAt": "2026-10-11T08:40:42.345Z", "data": { } }
```

`id` — ключ дедупликации в JetStream (`Nats-Msg-Id`) и в `inbox` потребителей.

## Доменные события (JetStream, стрим `JOL`)

| Событие | Издатель | Данные | Потребители |
|---|---|---|---|
| `jol.dispatch.order.created` | dispatch | orderId, clientId, tariff, from, price, surge | pricing (спрос) |
| `jol.dispatch.order.accepted` | dispatch | orderId, clientId, driverId | fleet (водитель занят, координаты идут пассажиру) |
| `jol.dispatch.order.arrived` | dispatch | orderId, clientId, driverId | — |
| `jol.dispatch.order.started` | dispatch | orderId, clientId, driverId | — |
| `jol.dispatch.order.completed` | dispatch | orderId, clientId, driverId, price, tariff | accounts (заработок, поездки), fleet (водитель свободен) |
| `jol.dispatch.order.cancelled` | dispatch | orderId, clientId, driverId, reason: `client` \| `no_drivers` | fleet |
| `jol.dispatch.order.rated` | dispatch | orderId, targetRole, targetId, stars | accounts (рейтинг) |
| `jol.intercity.trip.published` | intercity | tripId, driverId, departAt, seats | — |
| `jol.intercity.trip.booked` | intercity | tripId, clientId, seats | — |
| `jol.intercity.trip.completed` | intercity | tripId, driverId, earned | accounts (заработок) |
| `jol.intercity.trip.cancelled` | intercity | tripId, driverId | — |
| `jol.accounts.rating.changed` | accounts | role, id, rating | fleet (обновить карточку водителя) |
| `jol.fleet.driver.online` | fleet | driverId, tariff | — (аналитика) |
| `jol.fleet.driver.offline` | fleet | driverId | — (аналитика) |

События без потребителей публикуются намеренно: это журнал домена для будущей аналитики и новых сервисов (уведомления, антифрод) без изменения издателей.

**Потребители:**
- `accounts` — durable-потребитель `accounts`, идемпотентный через `inbox`.
- `fleet`, `pricing` — ordered-потребители «с текущего момента»: их состояние в памяти восстанавливается из снимков, а не из истории.

## Синхронные запросы (NATS request/reply)

| Тема | Отвечает | Запрос → ответ | Кто вызывает |
|---|---|---|---|
| `accounts.driver.register` | accounts | профиль → аккаунт со статистикой | fleet, intercity |
| `accounts.driver.card` | accounts | id → карточка или null | — |
| `accounts.rider.card` | accounts | id → рейтинг и поездки | dispatch, intercity |
| `fleet.candidates` | fleet | точка, тариф, радиус, исключения → ближайшие свободные | dispatch |
| `fleet.supply` | fleet | — → свободные машины по зонам | pricing |
| `pricing.price` | pricing | маршрут, тариф, грузчики, quoteId → цена, коэффициент, км, мин | dispatch |
| `dispatch.assignments` | dispatch | — → активные пары водитель–пассажир | fleet при старте |
| `dispatch.snapshot` | dispatch | роль, id → активный заказ и предложение | realtime при подключении |

Ошибка передаётся как `{ ok: false, error: { status, code, message } }` и превращается в такую же HTTP-ошибку у вызывающего. Таймаут — 3 с, после него 503.

## Уведомления в приложения (core NATS → SSE)

Тема `notify.<client|driver>.<id>`, полезная нагрузка `{ event, data }`. `realtime` пересылает её в браузер как SSE-событие `event`.

| SSE-событие | Кому | Когда |
|---|---|---|
| `order` | пассажиру и водителю заказа | любое изменение заказа |
| `offer` | водителю | новое предложение заказа |
| `offer_expired` | водителю | предложение отозвано или истекло |
| `driver_location` | пассажиру | новая координата назначенного водителя |
| `trip` | водителю рейса и забронировавшим | изменение рейса или брони |
