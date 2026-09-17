-- Read-only VIEWER role.
--
-- A contractor or auditor who should read documents but not upload, delete or share them
-- previously had to be made a MEMBER and trusted. VIEWER can list, preview and download,
-- and nothing else — in particular it cannot create share links, so it cannot move a
-- document outside the workspace.
--
-- In its own migration because a newly added enum value cannot be used in the same
-- transaction that adds it.

ALTER TYPE workspace_role ADD VALUE IF NOT EXISTS 'VIEWER';
