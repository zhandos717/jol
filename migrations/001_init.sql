CREATE TABLE drivers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  car          TEXT NOT NULL DEFAULT '',
  plate        TEXT NOT NULL DEFAULT '',
  tariff       TEXT NOT NULL,
  rating_sum   INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  earned       BIGINT NOT NULL DEFAULT 0,
  trips        INTEGER NOT NULL DEFAULT 0,
  data         JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE drivers IS 'Водители: профиль, машина, тариф и накопленная статистика';
COMMENT ON COLUMN drivers.id IS 'Идентификатор водителя, генерируется приложением водителя (UUID строкой)';
COMMENT ON COLUMN drivers.name IS 'Имя водителя, показывается пассажиру';
COMMENT ON COLUMN drivers.car IS 'Марка и модель машины, например Toyota Camry';
COMMENT ON COLUMN drivers.plate IS 'Госномер в верхнем регистре';
COMMENT ON COLUMN drivers.tariff IS 'Тариф, по которому водитель получает заказы: eco, comfort, business, cargo_s, cargo_m, cargo_l, intercity';
COMMENT ON COLUMN drivers.rating_sum IS 'Сумма всех звёзд, поставленных водителю пассажирами (1–5 за поездку)';
COMMENT ON COLUMN drivers.rating_count IS 'Количество оценок; рейтинг = rating_sum / rating_count, без оценок считается 5.0';
COMMENT ON COLUMN drivers.earned IS 'Заработок водителя за всё время, тенге';
COMMENT ON COLUMN drivers.trips IS 'Количество завершённых поездок и рейсов';
COMMENT ON COLUMN drivers.data IS 'Полная запись водителя из приложения (без координат и статуса онлайн — они живут только в памяти сервера)';
COMMENT ON COLUMN drivers.updated_at IS 'Время последнего сохранения записи';

CREATE TABLE clients (
  id           TEXT PRIMARY KEY,
  rating_sum   INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  trips        INTEGER NOT NULL DEFAULT 0,
  data         JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE clients IS 'Пассажиры: рейтинг и статистика поездок';
COMMENT ON COLUMN clients.id IS 'Идентификатор пассажира, генерируется приложением пассажира (UUID строкой)';
COMMENT ON COLUMN clients.rating_sum IS 'Сумма звёзд, поставленных пассажиру водителями (1–5 за поездку)';
COMMENT ON COLUMN clients.rating_count IS 'Количество оценок; рейтинг = rating_sum / rating_count, без оценок считается 5.0';
COMMENT ON COLUMN clients.trips IS 'Количество завершённых поездок пассажира';
COMMENT ON COLUMN clients.data IS 'Полная запись пассажира из приложения';
COMMENT ON COLUMN clients.updated_at IS 'Время последнего сохранения записи';

CREATE TABLE orders (
  id          UUID PRIMARY KEY,
  client_id   TEXT NOT NULL,
  driver_id   TEXT,
  tariff      TEXT NOT NULL,
  status      TEXT NOT NULL,
  price       INTEGER NOT NULL,
  surge       NUMERIC(3, 1) NOT NULL DEFAULT 1,
  km          NUMERIC(8, 2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  depart_at   TIMESTAMPTZ,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE orders IS 'Заказы такси, грузового такси и межгорода «вся машина»';
COMMENT ON COLUMN orders.id IS 'Идентификатор заказа';
COMMENT ON COLUMN orders.client_id IS 'Пассажир, оформивший заказ (clients.id)';
COMMENT ON COLUMN orders.driver_id IS 'Водитель, принявший заказ (drivers.id); NULL, пока водитель не найден';
COMMENT ON COLUMN orders.tariff IS 'Тариф заказа: eco, comfort, business, cargo_s, cargo_m, cargo_l, intercity';
COMMENT ON COLUMN orders.status IS 'Статус: scheduled — ждёт времени выезда, searching — поиск водителя, accepted — водитель едет к пассажиру, arrived — водитель на месте, in_progress — в пути, done — завершён, cancelled — отменён, no_drivers — водитель не найден';
COMMENT ON COLUMN orders.price IS 'Итоговая цена для пассажира, тенге, с учётом коэффициента спроса и грузчиков';
COMMENT ON COLUMN orders.surge IS 'Коэффициент спроса на момент заказа: 1.0 — обычная цена, максимум 2.5';
COMMENT ON COLUMN orders.km IS 'Длина маршрута по дорогам, километры';
COMMENT ON COLUMN orders.created_at IS 'Время создания заказа';
COMMENT ON COLUMN orders.depart_at IS 'Запланированное время выезда для заказа на дату; NULL — как можно скорее';
COMMENT ON COLUMN orders.data IS 'Полная запись заказа: адреса, координаты, отзывы, отметки времени по статусам';
COMMENT ON COLUMN orders.updated_at IS 'Время последнего сохранения записи';
CREATE INDEX orders_client_status_idx ON orders (client_id, status, created_at DESC);
CREATE INDEX orders_driver_status_idx ON orders (driver_id, status);
CREATE INDEX orders_active_idx ON orders (status) WHERE status IN ('scheduled', 'searching', 'accepted', 'arrived', 'in_progress');

CREATE TABLE trips (
  id             UUID PRIMARY KEY,
  driver_id      TEXT NOT NULL,
  status         TEXT NOT NULL,
  depart_at      TIMESTAMPTZ NOT NULL,
  seats          SMALLINT NOT NULL,
  price_per_seat INTEGER NOT NULL,
  data           JSONB NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE trips IS 'Межгородские рейсы с попутчиками, которые публикуют водители';
COMMENT ON COLUMN trips.id IS 'Идентификатор рейса';
COMMENT ON COLUMN trips.driver_id IS 'Водитель, опубликовавший рейс (drivers.id)';
COMMENT ON COLUMN trips.status IS 'Статус: open — набор пассажиров, departed — в пути, done — завершён, cancelled — отменён водителем';
COMMENT ON COLUMN trips.depart_at IS 'Время выезда';
COMMENT ON COLUMN trips.seats IS 'Всего мест для пассажиров в рейсе (1–7)';
COMMENT ON COLUMN trips.price_per_seat IS 'Цена одного места, тенге';
COMMENT ON COLUMN trips.data IS 'Полная запись рейса: города, координаты, комментарий, брони пассажиров';
COMMENT ON COLUMN trips.updated_at IS 'Время последнего сохранения записи';
CREATE INDEX trips_open_idx ON trips (status, depart_at) WHERE status IN ('open', 'departed');
CREATE INDEX trips_driver_idx ON trips (driver_id);
