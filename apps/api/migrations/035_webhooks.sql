-- Webhooks: a workspace's owners can have chosen activity POSTed, signed, to an HTTPS endpoint.

CREATE TABLE webhooks (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  url                  text NOT NULL CHECK (length(url) <= 2000),
  -- Signs each delivery (HMAC-SHA256). Kept as-is because signing needs it; shown once.
  secret               text NOT NULL,
  events               text[] NOT NULL CHECK (cardinality(events) > 0),
  created_by           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  disabled_at          timestamptz,
  disabled_reason      text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_delivery_at     timestamptz,
  last_status          integer
);

CREATE INDEX webhooks_workspace_idx ON webhooks (workspace_id) WHERE disabled_at IS NULL;

-- One row per attempt, kept for 30 days: what the owner sees when a receiver misbehaves.
CREATE TABLE webhook_deliveries (
  id           uuid PRIMARY KEY,
  webhook_id   uuid NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  event_id     uuid,
  event_type   text NOT NULL,
  success      boolean NOT NULL,
  status_code  integer,
  error        text,
  duration_ms  integer NOT NULL,
  attempted_at timestamptz NOT NULL
);

CREATE INDEX webhook_deliveries_recent_idx ON webhook_deliveries (webhook_id, attempted_at DESC);
CREATE INDEX webhook_deliveries_age_idx ON webhook_deliveries (attempted_at);

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhooks USING (app_workspace_visible(workspace_id)) WITH CHECK (true);
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_deliveries USING (app_workspace_visible(workspace_id)) WITH CHECK (true);
