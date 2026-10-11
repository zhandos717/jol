ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
COMMENT ON COLUMN orders.idempotency_key IS 'Client-generated key of the "Order" tap (Idempotency-Key header); retries of the same tap return the same order instead of creating or rejecting a duplicate';
CREATE UNIQUE INDEX orders_idempotency_idx ON orders (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
