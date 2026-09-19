-- Which notifications have been in a digest. Marking rows (rather than comparing timestamps with
-- the last digest) means nothing is summarised twice or skipped, however close together they are.
ALTER TABLE notifications ADD COLUMN digested_at timestamptz;
