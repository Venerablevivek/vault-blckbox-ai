-- View-only links and links restricted to named people.
--
-- allow_download = false: the recipient can view the file (PDFs and images, watermarked) but the
-- download endpoint refuses. allowed_emails non-empty: only those addresses can open the link,
-- each proving it with a one-time code sent to that address.

ALTER TABLE shares
  ADD COLUMN allow_download boolean NOT NULL DEFAULT true,
  ADD COLUMN allowed_emails text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(allowed_emails) <= 50);

-- Who opened a restricted link, as they proved it. Null for open links.
ALTER TABLE share_access_events ADD COLUMN viewer_email text;

-- The check's name depends on history (018 rebuilt this table while the old one still held the
-- plain name, so here it may be ..._check1). Drop whichever outcome check the table has.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'share_access_events'::regclass AND contype = 'c'
              AND conname LIKE 'share_access_events_outcome_check%'
  LOOP
    EXECUTE format('ALTER TABLE share_access_events DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE share_access_events ADD CONSTRAINT share_access_events_outcome_check
  CHECK (outcome IN ('resolved', 'downloaded', 'expired', 'revoked', 'document_deleted',
                     'exhausted', 'bad_password', 'bad_code'));

-- One-time codes. Only a keyed hash of the code is kept; a code dies after a few wrong tries,
-- after it is used, or after ten minutes.
CREATE TABLE share_email_codes (
  id          uuid PRIMARY KEY,
  share_id    uuid NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
  email       text NOT NULL,
  code_hash   bytea NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX share_email_codes_lookup_idx ON share_email_codes (share_id, email, created_at DESC);
CREATE INDEX share_email_codes_expiry_idx ON share_email_codes (expires_at);
