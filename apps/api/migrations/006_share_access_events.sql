-- Share-link access visibility.
--
-- Answers the question every sender actually has after sharing a document: did they
-- open it? The `shares` table records when a link was created and revoked, but nothing
-- about use, so a link opened forty times looks identical to one never opened at all.
--
-- Privacy: the person opening a link is not our user and never agreed to be tracked, so
-- the raw IP address is never stored. We keep a keyed hash, which is enough to count
-- distinct viewers and spot forwarding, and useless for identifying anyone.
-- Events cascade away with the link, and with the document.

CREATE TABLE share_access_events (
  id          uuid PRIMARY KEY,
  share_id    uuid  NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  accessed_at timestamptz NOT NULL DEFAULT now(),
  ip_hash     bytea NOT NULL,          -- sha256(pepper || ip); never the address itself
  user_agent  text,
  outcome     text  NOT NULL
    CHECK (outcome IN ('resolved', 'downloaded', 'expired', 'revoked', 'document_deleted'))
);

CREATE INDEX share_access_events_share_idx
  ON share_access_events (share_id, accessed_at DESC);
