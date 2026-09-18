-- Row-level security on tenant data.
--
-- Every query in the application is scoped by workspace, and authorization is checked before
-- anything is returned. These policies are the second line: while a request runs its multi-row
-- reads (listings, search, the dashboard, the audit trail, notifications) it sets app.user_id for
-- its transaction, and the database itself then only returns rows from workspaces that user
-- belongs to. A query that lost its workspace filter would return nothing it shouldn't.
--
-- When app.user_id is not set (background jobs, the public share routes, writes) the policies
-- allow everything, so they add protection without changing any existing behaviour.
--
-- The application connects as vault_app, which is neither the owner nor a superuser, so the
-- policies apply to it (owners and superusers bypass RLS).

/** True when no user is in context, or the user belongs to the workspace. Inlined by the planner. */
CREATE FUNCTION app_workspace_visible(ws uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.user_id', true), '') = ''
      OR EXISTS (
           SELECT 1 FROM workspace_members m
            WHERE m.workspace_id = ws
              -- NULLIF, not a bare cast: SQL doesn't promise to evaluate the OR above first, and a
              -- connection that ran a tenant transaction before reads the setting back as ''.
              AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
$$;

CREATE FUNCTION app_user_visible(owner_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.user_id', true), '') = ''
      OR owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents USING (app_workspace_visible(workspace_id)) WITH CHECK (true);

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON folders USING (app_workspace_visible(workspace_id)) WITH CHECK (true);

ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON uploads USING (app_workspace_visible(workspace_id)) WITH CHECK (true);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events USING (app_workspace_visible(workspace_id)) WITH CHECK (true);

-- Shares have no workspace column: a share is visible when its document is (documents' own policy
-- applies inside the subquery).
ALTER TABLE shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shares
  USING (COALESCE(current_setting('app.user_id', true), '') = ''
         OR EXISTS (SELECT 1 FROM documents d WHERE d.id = shares.document_id))
  WITH CHECK (true);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_notifications ON notifications USING (app_user_visible(user_id)) WITH CHECK (true);
