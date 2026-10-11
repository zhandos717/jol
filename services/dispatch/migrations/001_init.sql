CREATE TABLE orders (
  id                UUID PRIMARY KEY,
  client_id         TEXT NOT NULL,
  driver_id         TEXT,
  tariff            TEXT NOT NULL,
  status            TEXT NOT NULL,
  from_lat          DOUBLE PRECISION NOT NULL,
  from_lon          DOUBLE PRECISION NOT NULL,
  to_lat            DOUBLE PRECISION NOT NULL,
  to_lon            DOUBLE PRECISION NOT NULL,
  from_label        TEXT NOT NULL DEFAULT '',
  to_label          TEXT NOT NULL DEFAULT '',
  km                NUMERIC(8, 2) NOT NULL,
  min               NUMERIC(8, 2) NOT NULL,
  price             INTEGER NOT NULL,
  surge             NUMERIC(3, 1) NOT NULL DEFAULT 1,
  loaders           SMALLINT NOT NULL DEFAULT 0,
  cargo_note        TEXT NOT NULL DEFAULT '',
  depart_at         TIMESTAMPTZ,
  declined          TEXT[] NOT NULL DEFAULT '{}',
  driver_snapshot   JSONB,
  client_snapshot   JSONB NOT NULL,
  driver_review     JSONB,
  client_review     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_started_at TIMESTAMPTZ,
  accepted_at       TIMESTAMPTZ,
  arrived_at        TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE orders IS 'Ride orders: city taxi, cargo and intercity whole-car';
COMMENT ON COLUMN orders.id IS 'Order id';
COMMENT ON COLUMN orders.client_id IS 'Passenger who placed the order (accounts.riders.id)';
COMMENT ON COLUMN orders.driver_id IS 'Driver who accepted the order (accounts.drivers.id); NULL until accepted';
COMMENT ON COLUMN orders.tariff IS 'eco, comfort, business, cargo_s, cargo_m, cargo_l, intercity';
COMMENT ON COLUMN orders.status IS 'scheduled - waits for departure time; searching - offering to drivers; accepted - driver heading to pickup; arrived - driver at pickup; in_progress - riding; done; cancelled - by passenger; no_drivers - nobody accepted in time';
COMMENT ON COLUMN orders.from_lat IS 'Pickup latitude, WGS84 degrees';
COMMENT ON COLUMN orders.from_lon IS 'Pickup longitude, WGS84 degrees';
COMMENT ON COLUMN orders.to_lat IS 'Destination latitude, WGS84 degrees';
COMMENT ON COLUMN orders.to_lon IS 'Destination longitude, WGS84 degrees';
COMMENT ON COLUMN orders.from_label IS 'Pickup address as shown to the passenger';
COMMENT ON COLUMN orders.to_label IS 'Destination address as shown to the passenger';
COMMENT ON COLUMN orders.km IS 'Road distance, kilometres';
COMMENT ON COLUMN orders.min IS 'Estimated drive time, minutes';
COMMENT ON COLUMN orders.price IS 'Final price for the passenger, KZT, including surge and loaders';
COMMENT ON COLUMN orders.surge IS 'Demand multiplier applied: 1.0 normal, up to 2.5';
COMMENT ON COLUMN orders.loaders IS 'Number of loaders for cargo orders (0-4), 3000 KZT each';
COMMENT ON COLUMN orders.cargo_note IS 'What is being moved: floor, lift, dimensions';
COMMENT ON COLUMN orders.depart_at IS 'Requested departure for scheduled orders; NULL means as soon as possible';
COMMENT ON COLUMN orders.declined IS 'Drivers who declined or ignored the offer; not offered again';
COMMENT ON COLUMN orders.driver_snapshot IS 'Driver card and position at acceptance (name, car, plate, rating)';
COMMENT ON COLUMN orders.client_snapshot IS 'Passenger rating and ride count at ordering, shown to drivers';
COMMENT ON COLUMN orders.driver_review IS 'Passenger review of the driver: stars 1-5, tags, comment';
COMMENT ON COLUMN orders.client_review IS 'Driver review of the passenger: stars 1-5, tags, comment';
COMMENT ON COLUMN orders.created_at IS 'When the order was placed';
COMMENT ON COLUMN orders.search_started_at IS 'When offering to drivers began; search times out 90 s later';
COMMENT ON COLUMN orders.accepted_at IS 'When a driver accepted';
COMMENT ON COLUMN orders.arrived_at IS 'When the driver reported arrival at pickup';
COMMENT ON COLUMN orders.started_at IS 'When the ride started';
COMMENT ON COLUMN orders.finished_at IS 'When the order reached a final status';
COMMENT ON COLUMN orders.updated_at IS 'Last change';
CREATE INDEX orders_client_idx ON orders (client_id, created_at DESC);
CREATE INDEX orders_active_idx ON orders (status) WHERE status IN ('scheduled', 'searching', 'accepted', 'arrived', 'in_progress');
CREATE UNIQUE INDEX orders_one_active_per_client ON orders (client_id) WHERE status IN ('scheduled', 'searching', 'accepted', 'arrived', 'in_progress');
CREATE UNIQUE INDEX orders_one_active_per_driver ON orders (driver_id) WHERE status IN ('accepted', 'arrived', 'in_progress');

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
