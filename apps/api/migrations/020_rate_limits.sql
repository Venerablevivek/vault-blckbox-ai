-- Shared rate-limit counters.
--
-- The limiter kept counters in each API process's memory, so two instances each allowed the full
-- limit and a restart reset every counter. Counters live here instead, so every instance enforces
-- one limit per client.
--
-- UNLOGGED: writes skip the write-ahead log, which makes this hot path cheap. The trade is that
-- the table is emptied if PostgreSQL crashes, which only means limits start fresh.

CREATE UNLOGGED TABLE rate_limits (
  -- sha256(pepper, route, client key): no raw IP address is stored.
  key            bytea PRIMARY KEY,
  count          integer NOT NULL,
  window_ends_at timestamptz NOT NULL
);

CREATE INDEX rate_limits_expiry_idx ON rate_limits (window_ends_at);
