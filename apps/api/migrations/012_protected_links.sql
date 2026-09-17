-- Protected share links: optional password, and an optional download limit.
--
-- A one-time link is simply max_downloads = 1. The counter is incremented with a
-- conditional UPDATE (download_count < max_downloads), so two simultaneous downloads of a
-- one-time link cannot both succeed.
--
-- password_hash is Argon2id, like account passwords. Failed attempts are recorded as
-- access events so repeated guessing against one link can be throttled per link, not
-- only per IP.

ALTER TABLE shares
  ADD COLUMN password_hash  text,
  ADD COLUMN max_downloads  integer CHECK (max_downloads IS NULL OR max_downloads > 0),
  ADD COLUMN download_count integer NOT NULL DEFAULT 0;

ALTER TABLE share_access_events DROP CONSTRAINT share_access_events_outcome_check;
ALTER TABLE share_access_events ADD CONSTRAINT share_access_events_outcome_check
  CHECK (outcome IN ('resolved', 'downloaded', 'expired', 'revoked', 'document_deleted',
                     'exhausted', 'bad_password'));

CREATE INDEX share_access_events_outcome_idx
  ON share_access_events (share_id, outcome, accessed_at DESC);
