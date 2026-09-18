-- Tamper-evident audit trail.
--
-- Each event stores the hash of the previous event in its workspace and a hash over its own
-- content chained to it. Changing, inserting or removing an event in the middle of the chain
-- breaks every hash after it, which the verify endpoint reports. The application role already
-- cannot UPDATE or DELETE this table; the chain also exposes edits made with owner access.
--
-- seq gives a total order per workspace (created_at can tie). Events recorded before this
-- migration have no hash and are reported as unverified; the chain starts after them.
--
-- actor_user_id is part of the hash, so users must never be hard-deleted (ON DELETE SET NULL
-- would rewrite it): account deletion anonymises the user row instead.

ALTER TABLE audit_events
  ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN prev_hash bytea CHECK (prev_hash IS NULL OR length(prev_hash) = 32),
  ADD COLUMN hash bytea CHECK (hash IS NULL OR length(hash) = 32);

CREATE UNIQUE INDEX audit_events_chain_idx ON audit_events (workspace_id, seq);
