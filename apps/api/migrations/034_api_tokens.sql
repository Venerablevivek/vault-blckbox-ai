-- Personal API tokens: a person's own credential for scripts and integrations. Only a hash of each
-- token is stored; the token itself is shown once, when it is created.

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  token_hash   bytea NOT NULL UNIQUE,
  -- The first characters, so a person can tell their tokens apart.
  token_prefix text NOT NULL,
  scopes       text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'write']::text[] AND cardinality(scopes) > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

CREATE INDEX api_tokens_user_idx ON api_tokens (user_id) WHERE revoked_at IS NULL;

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_tokens ON api_tokens USING (app_user_visible(user_id)) WITH CHECK (true);
