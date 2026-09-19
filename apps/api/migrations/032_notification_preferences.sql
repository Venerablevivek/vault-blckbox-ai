-- What each person wants to hear about. No row means the defaults: every notification shown in
-- the app, nothing emailed.

CREATE TABLE notification_preferences (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- A summary email of unread notifications.
  digest         text NOT NULL DEFAULT 'off' CHECK (digest IN ('off', 'daily', 'weekly')),
  -- Types emailed as they happen, and types not shown at all.
  instant        text[] NOT NULL DEFAULT '{}',
  muted          text[] NOT NULL DEFAULT '{}',
  last_digest_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_preferences_digest_idx ON notification_preferences (digest) WHERE digest <> 'off';

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_preferences ON notification_preferences USING (app_user_visible(user_id)) WITH CHECK (true);
