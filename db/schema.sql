-- Vercel Postgres schema (integer-only money/amounts)
-- Apply via Vercel Postgres SQL editor or psql.
--
-- Notes
-- - KRW amounts are stored as BIGINT in "won" units (no decimals).
-- - Crypto amounts are stored as BIGINT "atomic" units (per-coin decimals are defined in app code).
-- - FX is stored as BIGINT "KRW per USD * 1e4" (e.g., 1334.1234 -> 13341234).
-- - Foreign USD spot is stored as BIGINT "USD * 1e6" (microusd).
-- - Kimchi premium is stored as INTEGER basis points (bp): 100bp = 1.00%.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ===== Users & balances =====
CREATE TABLE IF NOT EXISTS users (
  discord_id BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS balances (
  discord_id BIGINT PRIMARY KEY REFERENCES users(discord_id) ON DELETE CASCADE,
  krw_balance BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only KRW ledger (auditable)
CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id BIGINT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- 'deposit', 'purchase', 'refund', 'admin_adjust', ...
  delta_krw BIGINT NOT NULL,
  ref_table TEXT,
  ref_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_entries_discord_id_created_at_idx
  ON ledger_entries(discord_id, created_at DESC);

-- ===== iOS deposit webhook events =====
CREATE TABLE IF NOT EXISTS deposit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id BIGINT NOT NULL REFERENCES users(discord_id) ON DELETE RESTRICT,
  amount_krw BIGINT NOT NULL,
  depositor_name TEXT,
  bank_name TEXT,
  identifier TEXT, -- memo/식별값 (추천: Discord ID 또는 주문번호)
  event_ts_ms BIGINT NOT NULL, -- from iOS payload
  nonce TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  credited BOOLEAN NOT NULL DEFAULT false,
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS deposit_events_payload_hash_uidx
  ON deposit_events(payload_hash);
CREATE UNIQUE INDEX IF NOT EXISTS deposit_events_nonce_uidx
  ON deposit_events(nonce);
CREATE INDEX IF NOT EXISTS deposit_events_discord_id_created_at_idx
  ON deposit_events(discord_id, created_at DESC);

-- ===== Price cache (cron-refreshed) =====
CREATE TABLE IF NOT EXISTS price_cache (
  symbol TEXT PRIMARY KEY, -- BTC/ETH/LTC/XRP/TRX
  foreign_usd_price_e6 BIGINT NOT NULL,
  fx_krw_per_usd_e4 BIGINT NOT NULL,
  domestic_krw_price BIGINT NOT NULL,
  kimchi_bp INTEGER NOT NULL,
  buy_krw_price BIGINT NOT NULL, -- computed: foreign*fx*(1+kimchi+fee)
  fee_bp INTEGER NOT NULL,
  sources JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_cache_updated_at_idx
  ON price_cache(updated_at DESC);

-- ===== Inventory =====
CREATE TABLE IF NOT EXISTS coin_inventory (
  symbol TEXT PRIMARY KEY, -- BTC/ETH/LTC/XRP/TRX
  available_atomic BIGINT NOT NULL DEFAULT 0, -- on-wallet stock (atomic)
  reserved_atomic BIGINT NOT NULL DEFAULT 0,  -- allocated to user holdings/transfer queue
  suspended BOOLEAN NOT NULL DEFAULT false, -- auto-suspend when insufficient
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User coin balances (atomic). Credited on purchase; debited on transfer.
CREATE TABLE IF NOT EXISTS user_coin_balances (
  discord_id BIGINT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  balance_atomic BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_id, symbol)
);

CREATE TABLE IF NOT EXISTS inventory_valuation (
  symbol TEXT PRIMARY KEY,
  available_atomic BIGINT NOT NULL,
  unit_scale INTEGER NOT NULL, -- atomic per 1 coin (e.g., 1e8)
  price_krw BIGINT NOT NULL, -- per 1 coin
  value_krw BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Orders / transfers =====
CREATE TYPE order_status AS ENUM ('pending', 'filled', 'cancelled', 'failed');
CREATE TYPE transfer_status AS ENUM ('requested', 'broadcasted', 'confirmed', 'failed', 'cancelled');

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id BIGINT NOT NULL REFERENCES users(discord_id) ON DELETE RESTRICT,
  symbol TEXT NOT NULL,
  krw_spent BIGINT NOT NULL,
  coin_amount_atomic BIGINT NOT NULL,
  unit_scale INTEGER NOT NULL,
  fee_bp INTEGER NOT NULL,
  kimchi_bp INTEGER NOT NULL,
  price_snapshot JSONB NOT NULL,
  status order_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_orders_discord_id_created_at_idx
  ON purchase_orders(discord_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transfer_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id BIGINT NOT NULL REFERENCES users(discord_id) ON DELETE RESTRICT,
  symbol TEXT NOT NULL,
  to_address TEXT NOT NULL,
  coin_amount_atomic BIGINT NOT NULL, -- after fee deduction
  fee_coin_atomic BIGINT NOT NULL,
  unit_scale INTEGER NOT NULL,
  network TEXT NOT NULL DEFAULT 'mainnet',
  tx_hash TEXT,
  status transfer_status NOT NULL DEFAULT 'requested',
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transfer_requests_discord_id_created_at_idx
  ON transfer_requests(discord_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS transfer_requests_tx_hash_uidx
  ON transfer_requests(tx_hash) WHERE tx_hash IS NOT NULL;

-- ===== Admin alerts (Discord webhook sink) =====
CREATE TABLE IF NOT EXISTS admin_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL, -- 'inventory_low', 'price_refresh_failed', ...
  message TEXT NOT NULL,
  context JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Payment provider webhooks (optional) =====
CREATE TABLE IF NOT EXISTS payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'generic',
  provider_event_id TEXT,
  discord_id BIGINT NOT NULL REFERENCES users(discord_id) ON DELETE RESTRICT,
  amount_krw BIGINT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  credited BOOLEAN NOT NULL DEFAULT false,
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_payload_hash_uidx
  ON payment_events(payload_hash);
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_provider_event_uidx
  ON payment_events(provider, provider_event_id) WHERE provider_event_id IS NOT NULL;

