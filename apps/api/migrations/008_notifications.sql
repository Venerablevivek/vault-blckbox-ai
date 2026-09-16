-- In-app notifications.
--
-- Deliberately in-app rather than email: there is no mail provider in this project, and
-- a notification you can only see by leaving the product is worse than one waiting for
-- you when you return. The delivery mechanism is polling, not websockets — this is a
-- modular monolith and a 20-second poll costs one indexed query.
--
-- read_at doubles as the unread filter, so no separate state table is needed.

CREATE TABLE notifications (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  type         text NOT NULL,
  title        text NOT NULL,
  body         text,
  resource_id  uuid,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- "My unread notifications, newest first" is the only query that matters.
CREATE INDEX notifications_inbox_idx
  ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx
  ON notifications (user_id) WHERE read_at IS NULL;
