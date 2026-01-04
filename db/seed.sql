-- Optional seed data.
-- Initialize inventory rows for supported coins.
INSERT INTO coin_inventory (symbol, available_atomic, reserved_atomic, suspended)
VALUES
  ('BTC', 0, 0, false),
  ('ETH', 0, 0, false),
  ('LTC', 0, 0, false),
  ('XRP', 0, 0, false),
  ('TRX', 0, 0, false)
ON CONFLICT (symbol) DO NOTHING;

