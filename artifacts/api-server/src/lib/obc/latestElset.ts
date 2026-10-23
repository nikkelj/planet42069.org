import { currentPoolClient, db, pool } from "@workspace/db";
import {
  obcLatestElset,
  obcSyncLog,
  obcWorkerState,
  type InsertObcTleHistory,
} from "@workspace/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { logger } from "../logger";

/**
 * Advisory lock for the one-time (and post-catalog) backfill. Distinct from
 * the TLE recent/backfill and RPOD scan locks so those workers can run.
 */
export const LOCK_LATEST_ELSET_BACKFILL = 421073;

const STATE_LATEST_ELSET = "tle_latest_elset_backfill";

/**
 * Catalog norads per backfill statement. Each one must be a single index
 * seek into obc_tle_history. 500 at a time was enough random heap I/O to
 * blow the 20s statement timeout (or get the backend killed) on the
 * ~17.9M-row archive, which rolled the batch back and left the cursor unmoved.
 */
export const LATEST_ELSET_BACKFILL_BATCH = 100;

/**
 * Upper bound for one `ensureLatestElsetReady` call. The RPOD scan must not
 * spend this on the archive: each batch is a history seek, and running that
 * on the scan connection saturated the host until the pointer read missed
 * its 30s client deadline (live 2026-10-23). TLE workers pass the shorter
 * maintain budget instead.
 */
export const LATEST_ELSET_BACKFILL_BUDGET_MS = 180_000;

/** Shorter slice used by the TLE workers so a backfill tick still fetches. */
export const LATEST_ELSET_MAINTAIN_BUDGET_MS = 20_000;

const BACKFILL_STATEMENT_TIMEOUT_MS = 20_000;

export interface LatestElsetBackfillState {
  cursor: number;
  done: boolean;
  /** ISO time of the merge sync-log row the sweep is caught up to. */
  catalogSeen: string | null;
  sweepCursor: number;
  /** Merge time the in-progress missing-norad sweep is walking. */
  sweepFor: string | null;
}

/**
 * True when the latest-elset table cannot yet answer the scan.
 * `done` means every catalogued norad was visited once. A newer catalog
 * merge means objects may have been added that already have history, so
 * the missing-norad sweep has to run again.
 */
export function latestElsetBackfillNeedsWork(
  state: LatestElsetBackfillState | null,
  catalogFinishedAt: string | null,
): boolean {
  if (!state?.done) return true;
  return (state.catalogSeen ?? null) !== catalogFinishedAt;
}

/** One row per norad, keeping the greatest epoch. Ties keep the later row. */
export function pickNewestElsets<T extends { norad: number; epoch: Date | string }>(rows: readonly T[]): T[] {
  const best = new Map<number, T>();
  for (const row of rows) {
    const prev = best.get(row.norad);
    if (!prev || epochMillis(row.epoch) >= epochMillis(prev.epoch)) best.set(row.norad, row);
  }
  return [...best.values()];
}

function epochMillis(epoch: Date | string): number {
  const ms = epoch instanceof Date ? epoch.getTime() : Date.parse(epoch);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function normalizeSql(sqlText: string): string {
  return sqlText.toLowerCase().replace(/["`]/g, "").replace(/\s+/g, " ");
}

/**
 * True when `sqlText` is a read of obc_latest_elset and does not touch
 * obc_tle_history.
 *
 * Rejected shapes, all seen live:
 *  - DISTINCT ON (norad) selecting line1/line2 over an epoch window
 *    (2026-08-26, ~5.1M rows, statement_timeout)
 *  - MAX(epoch) GROUP BY norad, then join back for the TLE text
 *    (2026-09-28, ~19.1M rows, connection timeout)
 *  - LATERAL ORDER BY epoch DESC LIMIT 1 for every catalogued norad,
 *    including a UNION whose WHERE h.epoch > until sits *after* the lateral
 *    (2026-10-14 and still 2026-10-22: the host saturates and the retry's
 *    new handshake dies as "Connection terminated due to connection timeout")
 */
export function latestElsetsSqlIsCheap(sqlText: string): boolean {
  const s = normalizeSql(sqlText);
  if (/distinct\s+on/.test(s) && /line1/.test(s) && /line2/.test(s)) return false;
  if (/max\s*\(\s*epoch\s*\)/.test(s) && /group\s+by/.test(s)) return false;
  if (/obc_tle_history/.test(s) || /\blateral\b/.test(s)) return false;
  if (/distinct\s+norad/.test(s)) return false;
  const readsLatest = /from\s+obc_latest_elset\b/.test(s);
  const epochWindow = /epoch\s*>/.test(s) && /epoch\s*<=/.test(s);
  // Catalog membership is a semi-join on the small pointer, not the driver
  // of a history seek.
  const catalogFilter = /obc_objects/.test(s);
  return readsLatest && epochWindow && catalogFilter;
}

/**
 * True when a lateral history seek is driven by the whole catalog (or by
 * the pointer *before* the future-epoch filter). Postgres may apply a
 * WHERE that follows CROSS JOIN LATERAL only after the seek; the
 * 2026-10-22 scans still died that way.
 */
export function historyLateralIsCatalogWide(sqlText: string): boolean {
  const s = normalizeSql(sqlText);
  if (!/obc_tle_history/.test(s) || !/\blateral\b/.test(s)) return false;
  const lateralAt = s.search(/\blateral\b/);
  const head = s.slice(0, lateralAt);
  if (/distinct\s+norad/.test(head) && /obc_objects/.test(head)) return true;
  // Station-keeping history is a VALUES list of plane-matched candidate
  // NORADs (tens, not the catalog). That is an index seek per id.
  if (/\bvalues\s*\(/.test(head) || /\bunnest\s*\(/.test(head)) return false;
  if (!/from\s+obc_latest_elset\b/.test(head)) return true;
  if (!/epoch\s*>/.test(head)) return true;
  return false;
}

/**
 * True when the future-dated history seek can only be served by an index
 * that leads with norad (the unique (norad, epoch) key or
 * obc_tle_history_norad_idx).
 *
 * A bare `epoch > since AND epoch <= until ORDER BY epoch DESC LIMIT 1`
 * is also a legal plan on obc_tle_history_epoch_idx. That plan filters
 * every archive row in the window once per future-dated pointer. On a
 * 2.7M-row stand-in of the live archive (270,556 rows inside the 3-day
 * window) 30 such norads removed 270,556 rows each and took 1.06s
 * (~35ms/norad, 2.38M buffer hits). A few hundred future-dated pointers
 * then miss the 30s client deadline; the full future set measured here
 * (6,148) would be a few minutes. The same seek as a backward index scan
 * on (norad, epoch) finished all 6,148 norads in a few hundred milliseconds.
 */
export function futureElsetSeekPinsCompositeIndex(sqlText: string): boolean {
  const s = normalizeSql(sqlText);
  const lateralAt = s.search(/\blateral\b/);
  if (lateralAt < 0) return false;
  const body = s.slice(lateralAt);
  const rowLower = /\(\s*norad\s*,\s*epoch\s*\)\s*>/.test(body);
  const rowUpper = /\(\s*norad\s*,\s*epoch\s*\)\s*<=/.test(body);
  // ORDER BY epoch DESC alone is what makes the epoch-only index look cheap.
  const ordersComposite = /order\s+by\s+norad\s+desc\s*,\s*epoch\s+desc/.test(body);
  const oneRow = /limit\s+1/.test(body);
  return rowLower && rowUpper && ordersComposite && oneRow && /obc_tle_history/.test(body);
}

/**
 * In-window pointer rows. No history read.
 *
 * The 3-day window covers most of this ~30k-row table (active GP epochs
 * are current). obc_latest_elset_epoch_idx then heap-fetches line1/line2
 * for nearly every row, and non-HOT epoch updates scatter those pages.
 * Callers sequential-scan the pointer for this statement. The EXISTS is
 * a hash of obc_objects(norad), not a probe per archive row.
 *
 * Bounds are cast to `timestamp` so a timestamptz parameter cannot wrap
 * the column and drop the comparison off the (epoch, norad) index used
 * by the future-dated list.
 */
export function latestElsetsInWindowSql(since: Date, until: Date) {
  return sql`
    SELECT
      h.norad,
      h.epoch,
      h.line1,
      h.line2,
      h.inc_deg,
      h.raan_deg,
      h.eccentricity,
      h.arg_perigee_deg,
      h.mean_anomaly_deg,
      h.mean_motion_rev_per_day
    FROM obc_latest_elset AS h
    WHERE h.epoch > ${since}::timestamp
      AND h.epoch <= ${until}::timestamp
      AND EXISTS (
        SELECT 1
        FROM obc_objects AS o
        WHERE o.norad = h.norad
      )
  `;
}

/**
 * Objects whose stored newest epoch is past `until` (space-track slides
 * multi-day objects forward to the next perigee). The future filter is
 * inside the driving subquery so the lateral cannot run for every catalog
 * norad.
 *
 * The history predicate is a row comparison on (norad, epoch). That is
 * only an index condition on (norad, epoch). It is not an index condition
 * on obc_tle_history_epoch_idx, which is the plan that scans the whole
 * epoch window per future norad (see futureElsetSeekPinsCompositeIndex).
 */
export function latestElsetsFutureSql(since: Date, until: Date) {
  return sql`
    SELECT
      p.norad,
      p.epoch,
      p.line1,
      p.line2,
      p.inc_deg,
      p.raan_deg,
      p.eccentricity,
      p.arg_perigee_deg,
      p.mean_anomaly_deg,
      p.mean_motion_rev_per_day
    FROM (
      SELECT h.norad
      FROM obc_latest_elset AS h
      WHERE h.epoch > ${until}::timestamp
        AND EXISTS (
          SELECT 1
          FROM obc_objects AS o
          WHERE o.norad = h.norad
        )
    ) AS future
    CROSS JOIN LATERAL (
      SELECT
        norad,
        epoch,
        line1,
        line2,
        inc_deg,
        raan_deg,
        eccentricity,
        arg_perigee_deg,
        mean_anomaly_deg,
        mean_motion_rev_per_day
      FROM obc_tle_history
      WHERE (norad, epoch) > (future.norad, ${since}::timestamp)
        AND (norad, epoch) <= (future.norad, ${until}::timestamp)
      ORDER BY norad DESC, epoch DESC
      LIMIT 1
    ) AS p
  `;
}

/**
 * Pre-table plan: one backward index seek per catalogued norad. Kept as the
 * fallback until obc_latest_elset exists and the backfill has visited every
 * catalog norad, so a deploy never answers the scan from a half-built table.
 */
export function latestElsetsArchiveSql(since: Date, until: Date) {
  return sql`
    SELECT
      h.norad,
      h.epoch,
      h.line1,
      h.line2,
      h.inc_deg,
      h.raan_deg,
      h.eccentricity,
      h.arg_perigee_deg,
      h.mean_anomaly_deg,
      h.mean_motion_rev_per_day
    FROM (
      SELECT DISTINCT norad
      FROM obc_objects
      WHERE norad IS NOT NULL
    ) AS ids
    CROSS JOIN LATERAL (
      SELECT
        norad,
        epoch,
        line1,
        line2,
        inc_deg,
        raan_deg,
        eccentricity,
        arg_perigee_deg,
        mean_anomaly_deg,
        mean_motion_rev_per_day
      FROM obc_tle_history
      WHERE norad = ids.norad
        AND epoch > ${since}
        AND epoch <= ${until}
      ORDER BY epoch DESC
      LIMIT 1
    ) AS h
  `;
}

export function pgErrorCode(err: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isUndefinedLatestTable(err: unknown): boolean {
  return pgErrorCode(err) === "42P01";
}

/**
 * Point obc_latest_elset at anything in `rows` that is newer than the stored
 * epoch. Safe to call for rows that conflicted on (norad, epoch): an older
 * duplicate does not replace a newer pointer (`setWhere`).
 * One INSERT cannot upsert the same norad twice, so callers pass the
 * per-norad newest row only — pickNewestElsets does that.
 */
export async function rememberLatestElsets(rows: readonly InsertObcTleHistory[]): Promise<void> {
  const newest = pickNewestElsets(rows);
  if (newest.length === 0) return;
  try {
    await db
      .insert(obcLatestElset)
      .values(newest.map((row) => ({
        norad: row.norad,
        epoch: row.epoch instanceof Date ? row.epoch : new Date(row.epoch),
        line1: row.line1,
        line2: row.line2,
        incDeg: row.incDeg,
        raanDeg: row.raanDeg,
        eccentricity: row.eccentricity,
        argPerigeeDeg: row.argPerigeeDeg,
        meanAnomalyDeg: row.meanAnomalyDeg,
        meanMotionRevPerDay: row.meanMotionRevPerDay,
      })))
      .onConflictDoUpdate({
        target: obcLatestElset.norad,
        set: {
          epoch: sql`excluded.epoch`,
          line1: sql`excluded.line1`,
          line2: sql`excluded.line2`,
          incDeg: sql`excluded.inc_deg`,
          raanDeg: sql`excluded.raan_deg`,
          eccentricity: sql`excluded.eccentricity`,
          argPerigeeDeg: sql`excluded.arg_perigee_deg`,
          meanAnomalyDeg: sql`excluded.mean_anomaly_deg`,
          meanMotionRevPerDay: sql`excluded.mean_motion_rev_per_day`,
        },
        setWhere: sql`excluded.epoch >= ${obcLatestElset.epoch}`,
      });
  } catch (err) {
    if (isUndefinedLatestTable(err)) {
      logger.warn("tle-archive: obc_latest_elset is not created yet; skipping pointer update");
      return;
    }
    throw err;
  }
}

interface BackfillBatchResult {
  maxNorad: number | null;
  idCount: number;
  written: number;
}

/**
 * One backfill batch. The history lateral is a row comparison on
 * (norad, epoch), same pin as the scan's future-dated correction.
 * `WHERE norad = $1 ORDER BY epoch DESC LIMIT 1` is also a legal plan on
 * obc_tle_history_epoch_idx; that plan walks the archive once per norad
 * and is what wedges the host while a scan is trying to read the pointer.
 */
export function backfillBatchSql(afterNorad: number, batch: number, missingOnly: boolean) {
  const missing = missingOnly
    ? sql`AND NOT EXISTS (SELECT 1 FROM obc_latest_elset l WHERE l.norad = obc_objects.norad)`
    : sql``;
  return sql`
    WITH ids AS (
      SELECT norad
      FROM (
        SELECT DISTINCT norad
        FROM obc_objects
        WHERE norad IS NOT NULL
          AND norad > ${afterNorad}
          ${missing}
      ) AS d
      ORDER BY norad
      LIMIT ${batch}
    ),
    ins AS (
      INSERT INTO obc_latest_elset (
        norad, epoch, line1, line2, inc_deg, raan_deg, eccentricity,
        arg_perigee_deg, mean_anomaly_deg, mean_motion_rev_per_day
      )
      SELECT
        h.norad, h.epoch, h.line1, h.line2, h.inc_deg, h.raan_deg, h.eccentricity,
        h.arg_perigee_deg, h.mean_anomaly_deg, h.mean_motion_rev_per_day
      FROM ids
      CROSS JOIN LATERAL (
        SELECT
          norad, epoch, line1, line2, inc_deg, raan_deg, eccentricity,
          arg_perigee_deg, mean_anomaly_deg, mean_motion_rev_per_day
        FROM obc_tle_history
        WHERE (norad, epoch) > (ids.norad, '-infinity'::timestamp)
          AND (norad, epoch) <= (ids.norad, 'infinity'::timestamp)
        ORDER BY norad DESC, epoch DESC
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
      WHERE EXCLUDED.epoch >= obc_latest_elset.epoch
      RETURNING norad
    )
    SELECT
      (SELECT max(norad) FROM ids) AS max_norad,
      (SELECT count(*)::int FROM ids) AS id_count,
      (SELECT count(*)::int FROM ins) AS written
  `;
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstRow(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) return (result[0] as Record<string, unknown> | undefined) ?? null;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: Record<string, unknown>[] }).rows;
    return rows?.[0] ?? null;
  }
  return null;
}

async function runBackfillBatch(afterNorad: number, missingOnly: boolean): Promise<BackfillBatchResult> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${BACKFILL_STATEMENT_TIMEOUT_MS}`));
    // The lateral is already LIMIT 1, but a hash or merge over obc_tle_history
    // is still a legal plan and seq-scans ~17.9M rows. Forbid those so a
    // batch is N index seeks. A statement_timeout then cancels cleanly
    // instead of the backend being killed under memory pressure.
    await tx.execute(sql.raw("SET LOCAL enable_seqscan = off"));
    await tx.execute(sql.raw("SET LOCAL enable_hashjoin = off"));
    await tx.execute(sql.raw("SET LOCAL enable_mergejoin = off"));
    // A bitmap of obc_tle_history_epoch_idx is still a legal plan for a
    // norad filter and reads the epoch window once per batch member.
    await tx.execute(sql.raw("SET LOCAL enable_bitmapscan = off"));
    await tx.execute(sql.raw("SET LOCAL max_parallel_workers_per_gather = 0"));
    return tx.execute(backfillBatchSql(afterNorad, LATEST_ELSET_BACKFILL_BATCH, missingOnly));
  });
  const row = firstRow(result);
  return {
    maxNorad: asInt(row?.max_norad),
    idCount: asInt(row?.id_count) ?? 0,
    written: asInt(row?.written) ?? 0,
  };
}

function parseState(value: unknown): LatestElsetBackfillState | null {
  if (!value || typeof value !== "object") return null;
  const row = value as {
    cursor?: unknown; done?: unknown; catalogSeen?: unknown; sweepCursor?: unknown; sweepFor?: unknown;
  };
  const cursor = typeof row.cursor === "number" && Number.isFinite(row.cursor) ? row.cursor : -1;
  const sweepCursor = typeof row.sweepCursor === "number" && Number.isFinite(row.sweepCursor) ? row.sweepCursor : -1;
  return {
    cursor,
    done: row.done === true,
    catalogSeen: typeof row.catalogSeen === "string" ? row.catalogSeen : null,
    sweepCursor,
    sweepFor: typeof row.sweepFor === "string" ? row.sweepFor : null,
  };
}

async function readState(): Promise<LatestElsetBackfillState | null> {
  const rows = await db.select().from(obcWorkerState).where(eq(obcWorkerState.key, STATE_LATEST_ELSET)).limit(1);
  return parseState(rows[0]?.value);
}

async function writeState(state: LatestElsetBackfillState): Promise<void> {
  const value = {
    cursor: state.cursor,
    done: state.done,
    catalogSeen: state.catalogSeen,
    sweepCursor: state.sweepCursor,
    sweepFor: state.sweepFor,
  };
  await db
    .insert(obcWorkerState)
    .values({ key: STATE_LATEST_ELSET, value })
    .onConflictDoUpdate({
      target: obcWorkerState.key,
      set: { value, updatedAt: sql`now()` },
    });
}

async function catalogMergeFinishedAt(): Promise<string | null> {
  const [row] = await db
    .select({ finishedAt: obcSyncLog.finishedAt })
    .from(obcSyncLog)
    .where(eq(obcSyncLog.source, "merge"))
    .orderBy(desc(obcSyncLog.finishedAt))
    .limit(1);
  const t = row?.finishedAt;
  return t instanceof Date && Number.isFinite(t.getTime()) ? t.toISOString() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Idempotent DDL so a deploy that skips `drizzle-kit push` still has the
 * pointer table. The table starts empty; the backfill fills it. This does
 * not lock obc_tle_history.
 */
export const LATEST_ELSET_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS obc_latest_elset (
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
  )`,
  // (epoch, norad) answers "pointers past until" as an index-only scan.
  // The single-column epoch index could not return norad without a heap
  // fetch of line1/line2, and a 3-day range matches most of the table so
  // the wide read does not use it (see latestElsetsInWindowSql).
  `CREATE INDEX IF NOT EXISTS obc_latest_elset_epoch_norad_idx ON obc_latest_elset (epoch, norad)`,
  `DROP INDEX IF EXISTS obc_latest_elset_epoch_idx`,
] as const;

export async function ensureLatestElsetTable(): Promise<void> {
  const client = currentPoolClient();
  for (const statement of LATEST_ELSET_TABLE_DDL) {
    if (client) await client.query(statement);
    else await pool.query(statement);
  }
}

/**
 * Visit catalog norads until obc_latest_elset has a row for every one that
 * has history, then catch objects added by a later catalog merge.
 * Returns false when the table is missing, the budget runs out, or a batch
 * stops. Callers still read the pointer. A partial table is the scan input;
 * the full-catalog history lateral is not a fallback.
 *
 * Not used by the RPOD scan. The scan reads whatever the pointer already
 * holds; this fill runs on the TLE workers.
 */
export async function ensureLatestElsetReady(
  budgetMs: number = LATEST_ELSET_BACKFILL_BUDGET_MS,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  try {
    await ensureLatestElsetTable();
    const mergeAt = await catalogMergeFinishedAt();
    if (!latestElsetBackfillNeedsWork(await readState(), mergeAt)) return true;

    // The RPOD scan already holds a checked-out client. A second
    // pool.connect() here is the handshake that dies when the pool has
    // gone idle. Advisory locks stack on one session.
    const borrowed = currentPoolClient();
    const client = borrowed ?? await pool.connect();
    let locked = false;
    try {
      while (Date.now() < deadline) {
        const currentMerge = await catalogMergeFinishedAt();
        if (!latestElsetBackfillNeedsWork(await readState(), currentMerge)) return true;
        const lock = await client.query<{ locked?: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [LOCK_LATEST_ELSET_BACKFILL],
        );
        locked = lock.rows[0]?.locked === true;
        if (!locked) {
          await sleep(250);
          continue;
        }
        try {
          await fillUntil(deadline, currentMerge);
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [LOCK_LATEST_ELSET_BACKFILL]).catch(() => undefined);
          locked = false;
        }
        if (!latestElsetBackfillNeedsWork(await readState(), await catalogMergeFinishedAt())) return true;
      }
      return !latestElsetBackfillNeedsWork(await readState(), await catalogMergeFinishedAt());
    } finally {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_LATEST_ELSET_BACKFILL]).catch(() => undefined);
      }
      if (!borrowed) client.release();
    }
  } catch (err) {
    if (isUndefinedLatestTable(err)) return false;
    throw err;
  }
}

async function fillUntil(deadline: number, mergeAt: string | null): Promise<void> {
  let state = (await readState()) ?? {
    cursor: -1, done: false, catalogSeen: null, sweepCursor: -1, sweepFor: null,
  };
  // A catalog merge that lands mid-sweep added low norads the cursor already
  // passed. Start that sweep over so those objects are not skipped.
  if (state.done && state.catalogSeen !== mergeAt && state.sweepFor !== mergeAt) {
    state = { ...state, sweepCursor: -1, sweepFor: mergeAt };
    await writeState(state);
  }
  while (Date.now() < deadline) {
    if (!state.done) {
      let batch: BackfillBatchResult;
      try {
        batch = await runBackfillBatch(state.cursor, false);
      } catch (err) {
        // Leave the cursor where the last committed batch put it. The scan
        // reads the pointer next; retrying this batch via the archive probe
        // is what wedged the host.
        logger.warn({ err: String(err) }, "tle-archive: latest-elset backfill batch stopped");
        return;
      }
      const exhausted = batch.idCount < LATEST_ELSET_BACKFILL_BATCH;
      state = {
        cursor: batch.maxNorad ?? state.cursor,
        done: exhausted,
        catalogSeen: exhausted ? mergeAt : state.catalogSeen,
        sweepCursor: exhausted ? -1 : state.sweepCursor,
        sweepFor: exhausted ? null : state.sweepFor,
      };
      await writeState(state);
      if (batch.idCount > 0) {
        logger.info(
          { cursor: state.cursor, written: batch.written, idCount: batch.idCount, done: state.done },
          "tle-archive: latest-elset backfill batch",
        );
      }
      if (exhausted) {
        await db.execute(sql`ANALYZE obc_latest_elset`).catch((err: unknown) => {
          logger.warn({ err: String(err) }, "tle-archive: ANALYZE obc_latest_elset failed");
        });
      }
      if (!latestElsetBackfillNeedsWork(state, mergeAt)) return;
      if (batch.idCount === 0) return;
      continue;
    }
    let batch: BackfillBatchResult;
    try {
      batch = await runBackfillBatch(state.sweepCursor, true);
    } catch (err) {
      logger.warn({ err: String(err) }, "tle-archive: latest-elset catalog sweep batch stopped");
      return;
    }
    const exhausted = batch.idCount < LATEST_ELSET_BACKFILL_BATCH;
    state = {
      ...state,
      sweepCursor: exhausted ? -1 : (batch.maxNorad ?? state.sweepCursor),
      catalogSeen: exhausted ? mergeAt : state.catalogSeen,
      sweepFor: exhausted ? null : mergeAt,
    };
    await writeState(state);
    if (batch.written > 0 || batch.idCount > 0) {
      logger.info(
        { sweepCursor: state.sweepCursor, written: batch.written, idCount: batch.idCount, caughtUp: exhausted },
        "tle-archive: latest-elset catalog sweep batch",
      );
    }
    if (exhausted) return;
    if (batch.idCount === 0) return;
  }
}

function deletedEpochPayload(deleted: readonly { norad: number; epoch: Date }[]): string {
  return JSON.stringify(deleted.map((row) => ({
    norad: row.norad,
    epoch: timestampWithoutZone(row.epoch),
  })));
}

function timestampWithoutZone(epoch: Date): string {
  return epoch.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Horizon deletes can remove an object's newest row (nothing newer than the
 * retention window). Re-point the latest table at the new newest row, or
 * drop it when the object has no history left. Only norads whose stored
 * epoch was one of the deleted epochs are touched, and a concurrent ingest
 * that stored a different epoch is left alone.
 */
export async function refreshLatestElsetsForDeletedEpochs(
  deleted: readonly { norad: number; epoch: Date }[],
): Promise<void> {
  if (deleted.length === 0) return;
  const payload = deletedEpochPayload(deleted);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        CREATE TEMP TABLE tmp_deleted_elset (
          norad integer NOT NULL,
          epoch timestamp NOT NULL
        ) ON COMMIT DROP
      `);
      await tx.execute(sql`
        INSERT INTO tmp_deleted_elset (norad, epoch)
        SELECT (e->>'norad')::int, (e->>'epoch')::timestamp
        FROM jsonb_array_elements(${payload}::jsonb) AS e
      `);
      await tx.execute(sql`
        INSERT INTO obc_latest_elset (
          norad, epoch, line1, line2, inc_deg, raan_deg, eccentricity,
          arg_perigee_deg, mean_anomaly_deg, mean_motion_rev_per_day
        )
        SELECT
          h.norad, h.epoch, h.line1, h.line2, h.inc_deg, h.raan_deg, h.eccentricity,
          h.arg_perigee_deg, h.mean_anomaly_deg, h.mean_motion_rev_per_day
        FROM (
          SELECT d.norad, max(d.epoch) AS deleted_epoch
          FROM tmp_deleted_elset d
          JOIN obc_latest_elset l ON l.norad = d.norad AND l.epoch = d.epoch
          GROUP BY d.norad
        ) AS still
        CROSS JOIN LATERAL (
          SELECT
            norad, epoch, line1, line2, inc_deg, raan_deg, eccentricity,
            arg_perigee_deg, mean_anomaly_deg, mean_motion_rev_per_day
          FROM obc_tle_history
          WHERE (norad, epoch) > (still.norad, '-infinity'::timestamp)
            AND (norad, epoch) <= (still.norad, 'infinity'::timestamp)
          ORDER BY norad DESC, epoch DESC
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
        WHERE obc_latest_elset.epoch = (
          SELECT max(d.epoch) FROM tmp_deleted_elset d
          WHERE d.norad = obc_latest_elset.norad
        )
      `);
      await tx.execute(sql`
        DELETE FROM obc_latest_elset l
        USING (
          SELECT d.norad, max(d.epoch) AS deleted_epoch
          FROM tmp_deleted_elset d
          GROUP BY d.norad
        ) AS still
        WHERE l.norad = still.norad
          AND l.epoch = still.deleted_epoch
      `);
    });
  } catch (err) {
    if (isUndefinedLatestTable(err)) return;
    throw err;
  }
}
