CREATE TABLE restaurants (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  cuisine      TEXT NOT NULL,
  address      TEXT NOT NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lon          DOUBLE PRECISION NOT NULL,
  prep_minutes SMALLINT NOT NULL DEFAULT 20,
  is_open      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE restaurants IS 'Restaurants that accept delivery orders';
COMMENT ON COLUMN restaurants.id IS 'Restaurant slug, also its id in the restaurant panel URL';
COMMENT ON COLUMN restaurants.name IS 'Display name';
COMMENT ON COLUMN restaurants.cuisine IS 'Cuisine shown in the list, e.g. казахская, пицца';
COMMENT ON COLUMN restaurants.address IS 'Pickup address shown to couriers';
COMMENT ON COLUMN restaurants.lat IS 'Pickup latitude, WGS84 degrees';
COMMENT ON COLUMN restaurants.lon IS 'Pickup longitude, WGS84 degrees';
COMMENT ON COLUMN restaurants.prep_minutes IS 'Typical cooking time, minutes; part of the delivery ETA';
COMMENT ON COLUMN restaurants.is_open IS 'Whether the restaurant accepts new orders right now';
COMMENT ON COLUMN restaurants.created_at IS 'When the restaurant was added';

CREATE TABLE menu_items (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  category      TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price         INTEGER NOT NULL CHECK (price > 0),
  is_available  BOOLEAN NOT NULL DEFAULT true,
  sort          SMALLINT NOT NULL DEFAULT 0
);
COMMENT ON TABLE menu_items IS 'Dishes a restaurant sells';
COMMENT ON COLUMN menu_items.id IS 'Item id, unique across restaurants';
COMMENT ON COLUMN menu_items.restaurant_id IS 'Owning restaurant';
COMMENT ON COLUMN menu_items.category IS 'Menu section, e.g. Горячее, Напитки';
COMMENT ON COLUMN menu_items.name IS 'Dish name';
COMMENT ON COLUMN menu_items.description IS 'Short description: portion, ingredients';
COMMENT ON COLUMN menu_items.price IS 'Price per portion, KZT';
COMMENT ON COLUMN menu_items.is_available IS 'False when the dish is out of stock today';
COMMENT ON COLUMN menu_items.sort IS 'Display order within the category';
CREATE INDEX menu_items_restaurant_idx ON menu_items (restaurant_id, category, sort);

CREATE TABLE food_orders (
  id                 UUID PRIMARY KEY,
  client_id          TEXT NOT NULL,
  restaurant_id      TEXT NOT NULL REFERENCES restaurants (id),
  status             TEXT NOT NULL,
  items              JSONB NOT NULL,
  items_total        INTEGER NOT NULL,
  delivery_fee       INTEGER NOT NULL,
  total              INTEGER NOT NULL,
  to_lat             DOUBLE PRECISION NOT NULL,
  to_lon             DOUBLE PRECISION NOT NULL,
  to_label           TEXT NOT NULL,
  recipient_name     TEXT NOT NULL,
  recipient_phone    TEXT NOT NULL,
  comment            TEXT NOT NULL DEFAULT '',
  courier_tariff     TEXT NOT NULL,
  courier_request_id UUID NOT NULL,
  courier_order_id   UUID,
  courier_attempts   SMALLINT NOT NULL DEFAULT 1,
  courier            JSONB,
  delivery_code      TEXT,
  idempotency_key    UUID,
  cancel_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at        TIMESTAMPTZ,
  ready_at           TIMESTAMPTZ,
  picked_up_at       TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE food_orders IS 'Restaurant orders and their kitchen plus delivery lifecycle';
COMMENT ON COLUMN food_orders.id IS 'Food order id';
COMMENT ON COLUMN food_orders.client_id IS 'Customer (accounts.riders.id)';
COMMENT ON COLUMN food_orders.restaurant_id IS 'Restaurant cooking the order';
COMMENT ON COLUMN food_orders.status IS 'placed - waits for the restaurant; cooking - accepted, courier being booked; ready - packed; delivering - courier picked up; delivered; rejected - by the restaurant; cancelled - by the customer or no courier found';
COMMENT ON COLUMN food_orders.items IS 'Snapshot of ordered dishes: [{itemId, name, price, qty}] with prices at order time, KZT';
COMMENT ON COLUMN food_orders.items_total IS 'Sum of dishes, KZT';
COMMENT ON COLUMN food_orders.delivery_fee IS 'Courier fee quoted by pricing, KZT';
COMMENT ON COLUMN food_orders.total IS 'items_total + delivery_fee, KZT';
COMMENT ON COLUMN food_orders.to_lat IS 'Delivery latitude, WGS84 degrees';
COMMENT ON COLUMN food_orders.to_lon IS 'Delivery longitude, WGS84 degrees';
COMMENT ON COLUMN food_orders.to_label IS 'Delivery address as entered by the customer';
COMMENT ON COLUMN food_orders.recipient_name IS 'Who receives the order';
COMMENT ON COLUMN food_orders.recipient_phone IS 'Phone the courier calls on arrival';
COMMENT ON COLUMN food_orders.comment IS 'Customer note: entrance, floor, cutlery';
COMMENT ON COLUMN food_orders.courier_tariff IS 'Courier tariff for the current attempt: courier_bike or courier_car';
COMMENT ON COLUMN food_orders.courier_request_id IS 'Idempotency key of the current courier booking in dispatch; a new attempt gets a new key';
COMMENT ON COLUMN food_orders.courier_order_id IS 'dispatch.orders.id of the courier delivery; NULL until booked';
COMMENT ON COLUMN food_orders.courier_attempts IS 'Courier bookings made: 1 by bike, 2 after falling back to car';
COMMENT ON COLUMN food_orders.courier IS 'Assigned courier card: name, rating, tariff';
COMMENT ON COLUMN food_orders.delivery_code IS '4-digit proof-of-delivery PIN from dispatch, shown to the customer only';
COMMENT ON COLUMN food_orders.idempotency_key IS 'Idempotency-Key of the customer''s order tap';
COMMENT ON COLUMN food_orders.cancel_reason IS 'client, restaurant or no_courier when the order did not complete';
COMMENT ON COLUMN food_orders.created_at IS 'When the customer placed the order';
COMMENT ON COLUMN food_orders.accepted_at IS 'When the restaurant accepted';
COMMENT ON COLUMN food_orders.ready_at IS 'When the restaurant marked the order packed';
COMMENT ON COLUMN food_orders.picked_up_at IS 'When the courier picked it up';
COMMENT ON COLUMN food_orders.finished_at IS 'When the order reached a final status';
COMMENT ON COLUMN food_orders.updated_at IS 'Last change';
CREATE INDEX food_orders_restaurant_active_idx ON food_orders (restaurant_id, created_at)
  WHERE status IN ('placed', 'cooking', 'ready', 'delivering');
CREATE INDEX food_orders_client_idx ON food_orders (client_id, created_at DESC);
CREATE UNIQUE INDEX food_orders_courier_order_idx ON food_orders (courier_order_id) WHERE courier_order_id IS NOT NULL;
CREATE UNIQUE INDEX food_orders_idempotency_idx ON food_orders (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE inbox (
  event_id     UUID PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE inbox IS 'Ids of consumed domain events; makes at-least-once delivery idempotent';
COMMENT ON COLUMN inbox.event_id IS 'Event envelope id';
COMMENT ON COLUMN inbox.processed_at IS 'When the event was applied';

CREATE TABLE outbox (
  id           UUID PRIMARY KEY,
  subject      TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
COMMENT ON TABLE outbox IS 'Transactional outbox: events written with the state change, published to NATS by a relay';
COMMENT ON COLUMN outbox.id IS 'Event envelope id, also the JetStream dedupe key';
COMMENT ON COLUMN outbox.subject IS 'NATS subject, equal to the event type';
COMMENT ON COLUMN outbox.payload IS 'Full event envelope';
COMMENT ON COLUMN outbox.created_at IS 'When the event was produced';
COMMENT ON COLUMN outbox.published_at IS 'When the relay published it; NULL means pending';
CREATE INDEX outbox_pending_idx ON outbox (created_at) WHERE published_at IS NULL;
