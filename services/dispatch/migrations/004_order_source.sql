ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'app';
COMMENT ON COLUMN orders.source IS 'Who placed the order: app - passenger or sender in the Jol app; food - courier delivery requested by the food service for a restaurant order';

DROP INDEX orders_one_active_per_client;
CREATE UNIQUE INDEX orders_one_active_per_client ON orders (client_id)
  WHERE source = 'app' AND status IN ('scheduled', 'searching', 'accepted', 'arrived', 'in_progress');
