-- The application connects as a least-privilege role that cannot create or drop tables. Keeping
-- share-event partitions ready (and dropping expired ones) needs exactly that, so both run as
-- SECURITY DEFINER functions owned by the migration role, which the application may call but
-- whose SQL it cannot change. search_path is pinned so a caller can't redirect table names.

ALTER FUNCTION ensure_share_event_partitions(timestamptz, integer) SECURITY DEFINER SET search_path = public, pg_temp;

/** Drops monthly partitions of share_access_events for months before `cutoff`. Returns their names. */
CREATE FUNCTION drop_share_event_partitions_before(cutoff timestamptz) RETURNS SETOF text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cutoff_name text := format('share_access_events_%s', to_char(date_trunc('month', cutoff AT TIME ZONE 'UTC'), 'YYYY_MM'));
  partition_name text;
BEGIN
  FOR partition_name IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'share_access_events'
       AND c.relname ~ '^share_access_events_[0-9]{4}_[0-9]{2}$'
       AND c.relname < cutoff_name
     ORDER BY c.relname
  LOOP
    EXECUTE format('DROP TABLE %I', partition_name);
    RETURN NEXT partition_name;
  END LOOP;
END;
$$;
