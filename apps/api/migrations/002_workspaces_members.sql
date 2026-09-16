-- Workspaces and membership.
--
-- Two roles only (OWNER, MEMBER) to keep authorization easy to reason about.
-- The composite primary key on workspace_members is what makes duplicate membership
-- impossible at the database level, rather than relying on application checks.

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE workspace_role AS ENUM ('OWNER', 'MEMBER');

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  role         workspace_role NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Backs "list the workspaces I belong to", which runs on every page load.
CREATE INDEX workspace_members_user_id_idx ON workspace_members (user_id);
