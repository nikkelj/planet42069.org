-- Newest elset per NORAD for the RPOD scan.
--
-- Deploy applies this through Drizzle, not by running this file:
--   scripts/post-merge.sh → pnpm --filter db push
-- (`lib/db/package.json` script `push`, drizzle-kit push). Push creates
-- obc_latest_elset and obc_latest_elset_epoch_norad_idx from lib/db/src/schema/obc.ts
-- on the next Replit deploy. No separate migration step.
--
-- drizzle-kit push executes its statements inside one transaction, and
-- PostgreSQL rejects CREATE INDEX CONCURRENTLY inside a transaction. The
-- index below is built with the new, empty table, so it does not lock
-- obc_tle_history. Do not add a second (norad, epoch DESC) index on
-- obc_tle_history: unique (norad, epoch) already serves ORDER BY epoch DESC
-- LIMIT 1 via a backward index scan, and a duplicate would add hundreds of
-- MB on the ~19M-row archive.
--
-- The API backfills the table in batches of 500 catalog norads (advisory
-- lock 421073, worker state key tle_latest_elset_backfill) and keeps it
-- current on ingest. Until that backfill finishes, the scan keeps using the
-- per-norad archive seek so results stay complete. Running the INSERT below
-- by hand is optional; it does the same fill in one statement.

CREATE TABLE IF NOT EXISTS obc_latest_elset (
  norad integer PRIMARY KEY,
  epoch timestamp NOT NULL,
  line1 text NOT NULL,
  line2 text NOT NULL,
  inc_deg real NOT NULL,
  raan_deg real NOT NULL,
  eccentricity real NOT NULL,
  arg_perigee_deg real NOT NULL,
  mean_anomaly_deg real NOT NULL,
  mean_motion_rev_per_day real NOT NULL
);

-- (epoch, norad): future-dated pointer ids are an index-only range.
-- The wide in-window read sequential-scans this table; a single-column
-- epoch index heap-fetched line1/line2 for nearly every row.
CREATE INDEX IF NOT EXISTS obc_latest_elset_epoch_norad_idx
  ON obc_latest_elset (epoch, norad);

DROP INDEX IF EXISTS obc_latest_elset_epoch_idx;

-- Optional one-shot fill. Prefer the app's batched backfill on a busy
-- primary; this holds one connection for one index seek per catalogued norad
-- (~30k seeks, not a sequential scan of the archive).
INSERT INTO obc_latest_elset (
  norad, epoch, line1, line2, inc_deg, raan_deg, eccentricity,
  arg_perigee_deg, mean_anomaly_deg, mean_motion_rev_per_day
)
SELECT
  h.norad, h.epoch, h.line1, h.line2, h.inc_deg, h.raan_deg, h.eccentricity,
  h.arg_perigee_deg, h.mean_anomaly_deg, h.mean_motion_rev_per_day
FROM (
  SELECT DISTINCT norad
  FROM obc_objects
  WHERE norad IS NOT NULL
) AS ids
CROSS JOIN LATERAL (
  SELECT
    norad, epoch, line1, line2, inc_deg, raan_deg, eccentricity,
    arg_perigee_deg, mean_anomaly_deg, mean_motion_rev_per_day
  FROM obc_tle_history
  WHERE norad = ids.norad
  ORDER BY epoch DESC
  LIMIT 1
) AS h
ON CONFLICT (norad) DO UPDATE SET
  epoch = EXCLUDED.epoch,
  line1 = EXCLUDED.line1,
  line2 = EXCLUDED.line2,
  inc_deg = EXCLUDED.inc_deg,
  raan_deg = EXCLUDED.raan_deg,
  eccentricity = EXCLUDED.eccentricity,
  arg_perigee_deg = EXCLUDED.arg_perigee_deg,
  mean_anomaly_deg = EXCLUDED.mean_anomaly_deg,
  mean_motion_rev_per_day = EXCLUDED.mean_motion_rev_per_day
WHERE EXCLUDED.epoch >= obc_latest_elset.epoch;
