-- Refunds: one row per refund. A retried request carries the same Idempotency-Key as the first one.
CREATE TABLE IF NOT EXISTS refunds (
  id              bigserial PRIMARY KEY,
  order_number    integer NOT NULL REFERENCES orders(number),
  idempotency_key text NOT NULL,
  amount          integer NOT NULL CHECK (amount > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_number, idempotency_key)
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded integer NOT NULL DEFAULT 0;
