-- Share-link activity at scale.
--
-- 1. Counters on the link. The document list and dashboard used to count access events on every
--    request, so a link opened 100,000 times made every listing slower. Counts now live on the
--    link and are updated in the same transaction as the event.
-- 2. share_viewers: one row per distinct (hashed) viewer of a link. Distinct-viewer counts, "is
--    this a new viewer?" and the 30-minute refresh de-duplication read this small table instead of
--    scanning events, and the de-duplication becomes a single atomic upsert (no check-then-insert
--    race between two tabs).
-- 3. share_access_events partitioned by month, so old history is dropped by detaching a partition
--    rather than deleting millions of rows, and time-bounded queries only touch recent months.

ALTER TABLE shares
  ADD COLUMN open_count        bigint NOT NULL DEFAULT 0,
  ADD COLUMN viewer_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN blocked_count     bigint NOT NULL DEFAULT 0,
  ADD COLUMN first_accessed_at timestamptz,
  ADD COLUMN last_accessed_at  timestamptz;

CREATE TABLE share_viewers (
  share_id       uuid NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  ip_hash        bytea NOT NULL,
  first_seen_at  timestamptz NOT NULL,
  -- Last counted page view; drives the 30-minute de-duplication. Null if only downloaded.
  last_viewed_at timestamptz,
  PRIMARY KEY (share_id, ip_hash)
);

-- Backfill from the existing history.
UPDATE shares s SET
  open_count        = a.opens,
  blocked_count     = a.blocked,
  first_accessed_at = a.first_at,
  last_accessed_at  = a.last_at
FROM (
  SELECT share_id,
         COUNT(*) FILTER (WHERE outcome = 'resolved') AS opens,
         COUNT(*) FILTER (WHERE outcome NOT IN ('resolved', 'downloaded')) AS blocked,
         MIN(accessed_at) FILTER (WHERE outcome IN ('resolved', 'downloaded')) AS first_at,
         MAX(accessed_at) FILTER (WHERE outcome IN ('resolved', 'downloaded')) AS last_at
    FROM share_access_events GROUP BY share_id
) a
WHERE a.share_id = s.id;

INSERT INTO share_viewers (share_id, ip_hash, first_seen_at, last_viewed_at)
SELECT share_id, ip_hash, MIN(accessed_at), MAX(accessed_at) FILTER (WHERE outcome = 'resolved')
  FROM share_access_events
 WHERE outcome IN ('resolved', 'downloaded')
 GROUP BY share_id, ip_hash;

UPDATE shares s SET viewer_count = v.viewers
  FROM (SELECT share_id, COUNT(*) AS viewers FROM share_viewers GROUP BY share_id) v
 WHERE v.share_id = s.id;

-- Rebuild the events table as a monthly-partitioned table. The partition key must be part of the
-- primary key.
ALTER TABLE share_access_events RENAME TO share_access_events_unpartitioned;

CREATE TABLE share_access_events (
  id          uuid NOT NULL,
  share_id    uuid NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  accessed_at timestamptz NOT NULL,
  ip_hash     bytea NOT NULL,
  user_agent  text,
  outcome     text NOT NULL CHECK (outcome IN ('resolved', 'downloaded', 'expired', 'revoked',
                                               'document_deleted', 'exhausted', 'bad_password')),
  PRIMARY KEY (id, accessed_at)
) PARTITION BY RANGE (accessed_at);

CREATE INDEX share_access_events_share_time_idx ON share_access_events (share_id, accessed_at DESC);
CREATE INDEX share_access_events_outcome_time_idx ON share_access_events (share_id, outcome, accessed_at DESC);

/**
 * Creates the monthly partitions covering [from, from + months). Idempotent. Called by this
 * migration, by the maintenance pass (always keeping the next months ready) and, as a safety net,
 * when an insert finds no partition for its row.
 */
CREATE FUNCTION ensure_share_event_partitions(from_ts timestamptz, months integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  month_start date := date_trunc('month', from_ts AT TIME ZONE 'UTC')::date;
  name text;
BEGIN
  FOR i IN 0 .. months - 1 LOOP
    name := format('share_access_events_%s', to_char(month_start + make_interval(months => i), 'YYYY_MM'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF share_access_events FOR VALUES FROM (%L) TO (%L)',
      name,
      (month_start + make_interval(months => i))::timestamp AT TIME ZONE 'UTC',
      (month_start + make_interval(months => i + 1))::timestamp AT TIME ZONE 'UTC'
    );
  END LOOP;
END;
$$;

-- Partitions for every month that has history, through three months ahead.
SELECT ensure_share_event_partitions(
  LEAST(COALESCE((SELECT MIN(accessed_at) FROM share_access_events_unpartitioned), now()), now()),
  (EXTRACT(YEAR FROM age(date_trunc('month', now()),
     date_trunc('month', LEAST(COALESCE((SELECT MIN(accessed_at) FROM share_access_events_unpartitioned), now()), now())))) * 12
   + EXTRACT(MONTH FROM age(date_trunc('month', now()),
     date_trunc('month', LEAST(COALESCE((SELECT MIN(accessed_at) FROM share_access_events_unpartitioned), now()), now()))))
  )::integer + 4
);

INSERT INTO share_access_events (id, share_id, accessed_at, ip_hash, user_agent, outcome)
SELECT id, share_id, accessed_at, ip_hash, user_agent, outcome FROM share_access_events_unpartitioned;

DROP TABLE share_access_events_unpartitioned;
