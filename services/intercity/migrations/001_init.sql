CREATE TABLE trips (
  id              UUID PRIMARY KEY,
  driver_id       TEXT NOT NULL,
  status          TEXT NOT NULL,
  from_lat        DOUBLE PRECISION NOT NULL,
  from_lon        DOUBLE PRECISION NOT NULL,
  from_label      TEXT NOT NULL,
  to_lat          DOUBLE PRECISION NOT NULL,
  to_lon          DOUBLE PRECISION NOT NULL,
  to_label        TEXT NOT NULL,
  depart_at       TIMESTAMPTZ NOT NULL,
  seats           SMALLINT NOT NULL CHECK (seats BETWEEN 1 AND 7),
  price_per_seat  INTEGER NOT NULL CHECK (price_per_seat >= 500),
  km              NUMERIC(8, 1) NOT NULL,
  hours           NUMERIC(5, 2) NOT NULL,
  comment         TEXT NOT NULL DEFAULT '',
  driver_snapshot JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE trips IS 'Intercity carpool trips published by drivers';
COMMENT ON COLUMN trips.id IS 'Trip id';
COMMENT ON COLUMN trips.driver_id IS 'Driver who published the trip (accounts.drivers.id)';
COMMENT ON COLUMN trips.status IS 'open - taking bookings; departed - on the road; done; cancelled - by the driver';
COMMENT ON COLUMN trips.from_lat IS 'Departure city latitude, WGS84 degrees';
COMMENT ON COLUMN trips.from_lon IS 'Departure city longitude, WGS84 degrees';
COMMENT ON COLUMN trips.from_label IS 'Departure city name';
COMMENT ON COLUMN trips.to_lat IS 'Destination city latitude, WGS84 degrees';
COMMENT ON COLUMN trips.to_lon IS 'Destination city longitude, WGS84 degrees';
COMMENT ON COLUMN trips.to_label IS 'Destination city name';
COMMENT ON COLUMN trips.depart_at IS 'Planned departure time';
COMMENT ON COLUMN trips.seats IS 'Passenger seats offered (1-7)';
COMMENT ON COLUMN trips.price_per_seat IS 'Price of one seat, KZT';
COMMENT ON COLUMN trips.km IS 'Road distance between the cities, kilometres';
COMMENT ON COLUMN trips.hours IS 'Estimated drive time, hours';
COMMENT ON COLUMN trips.comment IS 'Driver notes: luggage, stops, rules';
COMMENT ON COLUMN trips.driver_snapshot IS 'Driver card at publication (name, car, plate, rating)';
COMMENT ON COLUMN trips.created_at IS 'When the trip was published';
COMMENT ON COLUMN trips.updated_at IS 'Last change';
CREATE INDEX trips_search_idx ON trips (depart_at) WHERE status = 'open';
CREATE INDEX trips_driver_idx ON trips (driver_id, depart_at);

CREATE TABLE bookings (
  trip_id         UUID NOT NULL REFERENCES trips (id),
  client_id       TEXT NOT NULL,
  seats           SMALLINT NOT NULL CHECK (seats >= 1),
  status          TEXT NOT NULL DEFAULT 'active',
  rider_snapshot  JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at    TIMESTAMPTZ,
  PRIMARY KEY (trip_id, client_id, created_at)
);
COMMENT ON TABLE bookings IS 'Seats booked by passengers on intercity trips';
COMMENT ON COLUMN bookings.trip_id IS 'Booked trip';
COMMENT ON COLUMN bookings.client_id IS 'Passenger (accounts.riders.id)';
COMMENT ON COLUMN bookings.seats IS 'Number of seats booked';
COMMENT ON COLUMN bookings.status IS 'active or cancelled (by the passenger before departure)';
COMMENT ON COLUMN bookings.rider_snapshot IS 'Passenger rating and ride count at booking, shown to the driver';
COMMENT ON COLUMN bookings.created_at IS 'When the booking was made';
COMMENT ON COLUMN bookings.cancelled_at IS 'When the booking was cancelled; NULL while active';
CREATE UNIQUE INDEX bookings_one_active_idx ON bookings (trip_id, client_id) WHERE status = 'active';
CREATE INDEX bookings_client_idx ON bookings (client_id) WHERE status = 'active';

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
