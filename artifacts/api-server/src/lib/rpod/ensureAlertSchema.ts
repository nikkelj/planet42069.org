import { logger } from "../logger";
import { dbErrorFields } from "../dbError";

/**
 * Idempotent DDL for the RPOD review queue.
 *
 * Replit git pull does not always run postMerge `pnpm --filter db push`, so
 * production can boot code that SELECTs `rpod_alert_queue` against a database
 * that never got the table. These statements only add missing objects. They
 * do not alter or drop columns that already exist.
 *
 * Column types match lib/db/src/schema/obc.ts (timestamp without time zone).
 */
export const RPOD_ALERT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rpod_exercise_flags (
    id serial PRIMARY KEY,
    norad integer,
    norad_b integer,
    note text,
    source text,
    expires_at timestamp,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE rpod_exercise_flags ADD COLUMN IF NOT EXISTS norad integer`,
  `ALTER TABLE rpod_exercise_flags ADD COLUMN IF NOT EXISTS norad_b integer`,
  `ALTER TABLE rpod_exercise_flags ADD COLUMN IF NOT EXISTS note text`,
  `ALTER TABLE rpod_exercise_flags ADD COLUMN IF NOT EXISTS source text`,
  `ALTER TABLE rpod_exercise_flags ADD COLUMN IF NOT EXISTS expires_at timestamp`,
  `ALTER TABLE rpod_exercise_flags ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()`,
  `CREATE INDEX IF NOT EXISTS rpod_exercise_flags_norad_idx ON rpod_exercise_flags (norad)`,

  `CREATE TABLE IF NOT EXISTS rpod_alert_queue (
    id serial PRIMARY KEY,
    event_id integer NOT NULL,
    objects jsonb NOT NULL,
    text text NOT NULL,
    score real NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'pending',
    ledger_key integer NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(),
    posted_at timestamp,
    tweet_id text
  )`,
  `ALTER TABLE rpod_alert_queue ADD COLUMN IF NOT EXISTS event_id integer`,
  `ALTER TABLE rpod_alert_queue ADD COLUMN IF NOT EXISTS objects jsonb`,
  `ALTER TABLE rpod_alert_queue ADD COLUMN IF NOT EXISTS text text`,
  `ALTER TABLE rpod_alert_queue ADD COLUMN IF NOT EXISTS score real NOT NULL DEFAULT 0`,
  `ALTER TABLE rpod_alert_queue ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE rpod_alert_queue ADD COLUMN IF NOT EXISTS ledger_key integer`,
  `ALTER TABLE rpod_alert_queue ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()`,
  `ALTER TABLE rpod_alert_queue ADD COLUMN IF NOT EXISTS posted_at timestamp`,
  `ALTER TABLE rpod_alert_queue ADD COLUMN IF NOT EXISTS tweet_id text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rpod_alert_queue_ledger_uq ON rpod_alert_queue (ledger_key)`,
  `CREATE INDEX IF NOT EXISTS rpod_alert_queue_status_idx ON rpod_alert_queue (status, created_at)`,

  `ALTER TABLE rpod_events ADD COLUMN IF NOT EXISTS scan_count integer NOT NULL DEFAULT 1`,
  `ALTER TABLE rpod_events ADD COLUMN IF NOT EXISTS first_min_range_km real`,
  `ALTER TABLE rpod_events ADD COLUMN IF NOT EXISTS max_range_km real`,
  `ALTER TABLE rpod_events ADD COLUMN IF NOT EXISTS last_elset_epochs jsonb`,
  `ALTER TABLE rpod_events ADD COLUMN IF NOT EXISTS suspected_cross_tag boolean NOT NULL DEFAULT false`,
];

export type SqlRunner = (statement: string) => Promise<unknown>;

/**
 * Apply every statement. One failure does not skip the rest. Throws an
 * AggregateError when any statement failed so startup can log and continue.
 * The default runner is imported lazily so unit tests can pass a fake and
 * never touch DATABASE_URL.
 */
export async function ensureRpodAlertSchema(query?: SqlRunner): Promise<void> {
  const run = query ?? (await defaultRunner());
  const errors: unknown[] = [];
  for (const statement of RPOD_ALERT_SCHEMA_STATEMENTS) {
    try {
      await run(statement);
    } catch (err) {
      errors.push(err);
      logger.error(
        { err, ...dbErrorFields(err), statement: statement.slice(0, 120) },
        "rpod-alert: schema statement failed",
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `rpod alert schema: ${errors.length} statement(s) failed`);
  }
}

async function defaultRunner(): Promise<SqlRunner> {
  const { pool } = await import("@workspace/db");
  return (statement) => pool.query(statement);
}
