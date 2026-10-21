import { currentPoolClient, db, pool, rebindDbClient, type DbPoolClient } from "@workspace/db";
import { obcTleHistory, obcWorkerState, obcSyncLog, type InsertObcTleHistory } from "@workspace/db/schema";
import { sql, asc, and, gte, eq, inArray, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { logger } from "../logger";
import { failLockClient, runLockedSession, waitForLockRecovery } from "./advisorySession";
import {
  ensureLatestElsetReady,
  isUndefinedLatestTable,
  latestElsetsArchiveSql,
  latestElsetsQuerySql,
  LATEST_ELSET_MAINTAIN_BUDGET_MS,
  refreshLatestElsetsForDeletedEpochs,
  rememberLatestElsets,
} from "./latestElset";

export { latestElsetsArchiveSql, latestElsetsQuerySql, latestElsetsSqlIsCheap } from "./latestElset";

/**
 * TLE history archive — samples space-track's public elset history into
 * Postgres so huge time ranges can be queried instantly.
 *
 *  - Recent watcher: polls the gp class for elsets PUBLISHED (CREATION_DATE) after a
 *    persisted watermark. This is the "recent elsets" tip-off feed — newly
 *    published objects (fresh launches, uncatalogued birds, maneuvers) show
 *    up here first.
 *  - Backfill: walks gp_history BACKWARD from the present in bounded
 *    epoch-range chunks, persisting a cursor so restarts resume.
 *
 * space-track etiquette (account-preserving, non-negotiable):
 *  - one shared serialized queue, ≥2s between requests
 *  - session cookie reused ~2h; 401/403 drops it and re-auths
 *  - exponential backoff on 429/5xx persisted across runs
 *  - hard per-run request budgets (callers never loop unbounded)
 */

const BASE = "https://www.space-track.org";
const MIN_GAP_MS = 2500;
const COOKIE_TTL_MS = 2 * 3600_000;
const FETCH_TIMEOUT_MS = 120_000;

// Sampling: keep at most one archived elset per object per UTC 6-hour bin
// for the recent window; beyond COARSE_AFTER_DAYS keep one per UTC day.
// Bounded storage, still enough time-resolution to see RAAN drift trends.
const SAMPLE_BIN_MS = 6 * 3600_000;
const COARSE_BIN_MS = 24 * 3600_000;
export const COARSE_AFTER_DAYS = 30;

// Retention horizon: the backfill stops walking once its cursor reaches this
// far into the past, and rows older than the horizon are pruned. Overridable
// via TLE_ARCHIVE_HORIZON_DAYS. Default 2 years — combined with 1/day
// sampling beyond 30 days, worst-case table size is bounded at roughly
// catalog_size × (30d × 4 + horizon_remainder × 1) rows.
export const BACKFILL_HORIZON_DAYS = (() => {
  const v = parseInt(process.env["TLE_ARCHIVE_HORIZON_DAYS"] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 730;
})();

// Prune pacing: bounded per backfill run so the delete never monopolizes the DB.
const PRUNE_ROW_LIMIT = 20_000;

// Backfill pacing
const BACKFILL_CHUNK_HOURS = 6;
const BACKFILL_REQUESTS_PER_RUN = 4;
const GP_HISTORY_ROW_LIMIT = 60_000;

/**
 * Recent-watch cursor on space-track CREATION_DATE (publish time). The old
 * "tle_recent_watermark" tracked EPOCH and is no longer read: see
 * nextRecentWatermarkMs for why an EPOCH cursor loses nearly every elset.
 */
const STATE_WATERMARK = "tle_recent_created_watermark";
/** UTC day (ms) the coarse thin is walking. The leading edge is thinned every run. */
const STATE_PRUNE_DAY = "tle_prune_coarse_day";
const DAY_MS = 86_400_000;
/** First run (or a fresh key) re-reads this much publish history so the RPOD scan's 3-day window refills. */
export const RECENT_INITIAL_LOOKBACK_MS = 4 * 86_400_000;
const STATE_BACKFILL = "tle_backfill_cursor";
const STATE_BACKOFF = "tle_backoff";

export interface GpRow {
  NORAD_CAT_ID: string;
  OBJECT_NAME?: string | null;
  EPOCH: string;
  CREATION_DATE?: string | null;
  INCLINATION: string;
  RA_OF_ASC_NODE: string;
  ARG_OF_PERICENTER: string;
  MEAN_ANOMALY: string;
  ECCENTRICITY: string;
  MEAN_MOTION: string;
  BSTAR?: string | null;
  TLE_LINE1: string | null;
  TLE_LINE2: string | null;
}

// ── shared throttled client ────────────────────────────────────────────────

let cookie: { value: string; expires: number } | null = null;
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

async function getCookie(): Promise<string> {
  if (cookie && cookie.expires > Date.now()) return cookie.value;
  const user = process.env["SPACETRACK_USERNAME"];
  const pass = process.env["SPACETRACK_PASSWORD"];
  if (!user || !pass) throw new Error("SPACETRACK_USERNAME / SPACETRACK_PASSWORD not set");
  const res = await fetch(`${BASE}/ajaxauth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ identity: user, password: pass }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`space-track login failed: ${res.status}`);
  const raw = res.headers.get("set-cookie");
  if (!raw) throw new Error("space-track login: no session cookie returned");
  cookie = { value: raw.split(";")[0], expires: Date.now() + COOKIE_TTL_MS };
  return cookie.value;
}

async function fetchJson<T>(path: string): Promise<T> {
  return throttled(async () => {
    const c = await getCookie();
    const res = await fetch(`${BASE}${path}`, {
      headers: { Cookie: c },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      cookie = null;
      throw new Error(`space-track unauthorized: ${res.status}`);
    }
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`space-track throttling/unavailable: ${res.status}`);
      (err as Error & { retryable?: boolean }).retryable = true;
      throw err;
    }
    if (!res.ok) throw new Error(`space-track fetch failed: ${res.status} ${path}`);
    return (await res.json()) as T;
  });
}

// ── cross-instance exclusion ───────────────────────────────────────────────

/**
 * Run `fn` under a session-scoped Postgres advisory lock so the politeness
 * budgets hold system-wide even with multiple server instances (autoscaled
 * deployment). When another instance holds the lock, this run is skipped.
 */
export async function withAdvisoryLock(
  key: number,
  label: string,
  fn: (client: DbPoolClient) => Promise<void>,
): Promise<void> {
  // pg-pool 3.13 (pg 8.20) builds "Connection terminated due to connection
  // timeout" with cause "Connection terminated unexpectedly" only in
  // Pool.newClient, when a *new* handshake exceeds connectionTimeoutMillis
  // (10s). pool.connect() stores that string as-is. A drizzle query that
  // has to dial (no idle client) wraps the same error as
  // "Failed query: … <- Connection terminated due to connection timeout".
  // That is the 2026-10-21 rpod_events failure: the scan had retired every
  // pooled client during SGP4, then persist dialed. One retry on the lock
  // checkout: the scan has not started, and a second dial usually lands.
  // The scan's own queries reuse this client instead of dialing again.
  const client = await retryOnceOnTransient(`${label} connect`, () => pool.connect());
  // The scan holds this socket across SGP4. pg 8.20 sets `_queryable` false
  // only after the socket errors (`Client._handleErrorEvent`). The next
  // query never reaches the server: "Client has encountered a connection
  // error and is not queryable", and a retry on that same client fails
  // again — that is the 22:56Z lastScanError. A heartbeat "Query read
  // timeout" does not clear `_queryable` and must not drop the session:
  // this backend still holds the advisory lock. When the socket really
  // dies, reacquire the lock on a new connection and rebind `db`.
  const ran = await runLockedSession(client, key, () => fn(client), (err) => {
    logger.error({ err: String(err), label }, "db: advisory lock session lost; discarding connection");
  }, 20_000, {
    connect: () => connectReplacementClient(label),
    onSwap: (next) => {
      rebindDbClient(next as DbPoolClient);
      logger.warn({ label }, "db: reacquired advisory lock on a new connection");
    },
  });
  if (!ran) logger.info(`${label}: another instance holds the lock, skipping run`);
}

/**
 * Handshake for a replacement lock socket. Not `retryOnceOnTransient`:
 * that waits on this recovery and would deadlock.
 */
async function connectReplacementClient(label: string): Promise<DbPoolClient> {
  let last: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      last = err;
      if (attempt >= 2 || !isTransientConnectionError(err)) throw err;
      logger.warn(
        { err: formatDbError(err), label, attempt },
        "db: advisory reconnect handshake failed, retrying once",
      );
      await new Promise((resolve) => setTimeout(resolve, DB_CONNECT_RETRY_DELAY_MS));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Wait out an in-flight lock reconnect. No-op when this call is not on the lock client. */
export async function ensureAdvisoryLockClient(): Promise<void> {
  const client = currentPoolClient();
  if (!client) return;
  await waitForLockRecovery(client);
}

export const LOCK_TLE_RECENT = 421070;
export const LOCK_TLE_BACKFILL = 421071;
export const LOCK_RPOD_SCAN = 421072;

// ── worker state ───────────────────────────────────────────────────────────

export async function getWorkerState<T extends Record<string, unknown>>(key: string): Promise<T | null> {
  const rows = await db.select().from(obcWorkerState).where(eq(obcWorkerState.key, key)).limit(1);
  return (rows[0]?.value as T | undefined) ?? null;
}

export async function setWorkerState(key: string, value: Record<string, unknown>): Promise<void> {
  await db
    .insert(obcWorkerState)
    .values({ key, value })
    .onConflictDoUpdate({ target: obcWorkerState.key, set: { value, updatedAt: sql`now()` } });
}

/** Shared backoff across recent+backfill: after a retryable failure both
 *  workers stand down until the persisted deadline passes. */
async function backoffActive(): Promise<boolean> {
  const s = await getWorkerState<{ until: number }>(STATE_BACKOFF);
  return s != null && typeof s.until === "number" && s.until > Date.now();
}

async function recordFailure(err: unknown): Promise<void> {
  const retryable = (err as { retryable?: boolean })?.retryable === true;
  const s = await getWorkerState<{ until: number; streak: number }>(STATE_BACKOFF);
  const streak = (s?.streak ?? 0) + 1;
  // 10 min, 20, 40 ... capped at 4h. Non-retryable errors get the base delay
  // too — login failures also deserve a stand-down, not a hammer loop.
  const delayMs = Math.min(10 * 60_000 * 2 ** Math.min(streak - 1, 5), 4 * 3600_000);
  await setWorkerState(STATE_BACKOFF, { until: Date.now() + delayMs, streak });
  logger.warn({ err: String(err), retryable, streak, delayMin: Math.round(delayMs / 60000) }, "tle-archive: backing off");
}

async function clearFailure(): Promise<void> {
  await setWorkerState(STATE_BACKOFF, { until: 0, streak: 0 });
}

// ── row conversion + sampled upsert ────────────────────────────────────────

function toRow(r: GpRow, source: "recent" | "backfill"): InsertObcTleHistory | null {
  const norad = parseInt(r.NORAD_CAT_ID, 10);
  const epochMs = Date.parse(r.EPOCH.endsWith("Z") ? r.EPOCH : r.EPOCH + "Z");
  if (!Number.isFinite(norad) || !Number.isFinite(epochMs)) return null;
  if (!r.TLE_LINE1 || !r.TLE_LINE2) return null;
  const f = (v: string | null | undefined): number => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : NaN;
  };
  const inc = f(r.INCLINATION), raan = f(r.RA_OF_ASC_NODE), ecc = f(r.ECCENTRICITY);
  const argp = f(r.ARG_OF_PERICENTER), ma = f(r.MEAN_ANOMALY), mm = f(r.MEAN_MOTION);
  if ([inc, raan, ecc, argp, ma, mm].some((x) => !Number.isFinite(x))) return null;
  const bstar = f(r.BSTAR);
  return {
    norad,
    epoch: new Date(epochMs),
    line1: r.TLE_LINE1,
    line2: r.TLE_LINE2,
    incDeg: inc,
    raanDeg: raan,
    eccentricity: ecc,
    argPerigeeDeg: argp,
    meanAnomalyDeg: ma,
    meanMotionRevPerDay: mm,
    bstar: Number.isFinite(bstar) ? bstar : null,
    source,
  };
}

/**
 * Downsample to one elset per object per bin (latest wins). Bins are 6h for
 * epochs within COARSE_AFTER_DAYS of `nowMs`, one UTC day beyond that — so
 * backfilled deep history lands at 1/object/day from the start.
 */
export function sampleRows(rows: InsertObcTleHistory[], nowMs: number = Date.now()): InsertObcTleHistory[] {
  const coarseBefore = nowMs - COARSE_AFTER_DAYS * 86_400_000;
  const byBin = new Map<string, InsertObcTleHistory>();
  for (const r of rows) {
    const epochMs = new Date(r.epoch as Date).getTime();
    const binMs = epochMs < coarseBefore ? COARSE_BIN_MS : SAMPLE_BIN_MS;
    const bin = Math.floor(epochMs / binMs);
    const key = `${r.norad}:${binMs}:${bin}`;
    const prev = byBin.get(key);
    if (!prev || new Date(r.epoch as Date).getTime() > new Date(prev.epoch as Date).getTime()) {
      byBin.set(key, r);
    }
  }
  return Array.from(byBin.values());
}

const CHUNK = 500;

export async function upsertTleHistory(rows: InsertObcTleHistory[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const res = await db
      .insert(obcTleHistory)
      .values(chunk)
      .onConflictDoNothing({ target: [obcTleHistory.norad, obcTleHistory.epoch] })
      .returning({ id: obcTleHistory.id });
    written += res.length;
    // Conflicts still carry the payload: a replay must not leave the pointer
    // behind the row that is already in history. Older epochs lose the
    // setWhere race against a newer pointer.
    await rememberLatestElsets(chunk);
  }
  return written;
}

async function logSync(source: string, status: "success" | "error", startedAt: Date, rowCount: number | null, error?: string) {
  try {
    await db.insert(obcSyncLog).values({
      source, status, rowCount,
      error: error ? error.slice(0, 2000) : null,
      startedAt,
    });
  } catch (err) {
    logger.error({ err }, "tle-archive: failed to write sync log");
  }
}

function stFmt(ms: number): string {
  // space-track wants "YYYY-MM-DD HH:MM:SS" (URL-encoded space)
  return new Date(ms).toISOString().slice(0, 19).replace("T", "%20");
}

// ── recent watcher ─────────────────────────────────────────────────────────

/**
 * Pull elsets published with EPOCH newer than the watermark from the gp
 * class (the current-catalog feed — where fresh launches and newly tracked
 * objects appear first). One request per run.
 */
export async function runRecentElsetWatch(): Promise<void> {
  if (await backoffActive()) return;
  return withAdvisoryLock(LOCK_TLE_RECENT, "tle-recent", doRecentElsetWatch);
}

function parseStUtc(v: string | null | undefined): number {
  if (!v) return NaN;
  return Date.parse(v.endsWith("Z") ? v : v + "Z");
}

/**
 * Next recent-watch cursor from the CREATION_DATEs we just received.
 *
 * The cursor used to be the max EPOCH seen, clamped to now. EPOCH is when
 * the object was observed, normally hours BEFORE space-track publishes the
 * elset, and the gp class also carries future-dated epochs (days ahead).
 * One future-dated row pinned the cursor to "now − 5 min" every run, and
 * since that row keeps matching EPOCH > cursor it stayed pinned. Every
 * elset published afterwards had an epoch below the cursor and was never
 * fetched, so obc_tle_history stopped growing on 2026-10-06 and the RPOD
 * scan ran out of in-window elsets on 2026-10-09.
 * CREATION_DATE is the publish time: monotonic, never in the future.
 */
export function nextRecentWatermarkMs(sinceMs: number, creationDates: (string | null | undefined)[], nowMs: number = Date.now()): number {
  let max = sinceMs;
  for (const c of creationDates) {
    const t = parseStUtc(c);
    if (Number.isFinite(t) && t > max) max = t;
  }
  // 5 min overlap for rows committed late at the boundary; the unique
  // (norad, epoch) index absorbs the duplicates.
  return Math.max(sinceMs, Math.min(max, nowMs) - 5 * 60_000);
}

async function maintainLatestElsetTable(): Promise<void> {
  await ensureLatestElsetReady(LATEST_ELSET_MAINTAIN_BUDGET_MS).catch((err: unknown) => {
    logger.warn({ err: formatDbError(err) }, "tle-archive: latest-elset backfill paused");
  });
}

async function doRecentElsetWatch(): Promise<void> {
  const started = new Date();
  try {
    await maintainLatestElsetTable();
    const s = await getWorkerState<{ epochMs: number }>(STATE_WATERMARK);
    const sinceMs = s?.epochMs ?? Date.now() - RECENT_INITIAL_LOOKBACK_MS;
    const path =
      `/basicspacedata/query/class/gp/CREATION_DATE/%3E${stFmt(sinceMs)}` +
      `/orderby/CREATION_DATE%20asc/limit/${GP_HISTORY_ROW_LIMIT}/format/json`;
    const raw = await fetchJson<GpRow[]>(path);
    const rows = raw.map((r) => toRow(r, "recent")).filter((r): r is InsertObcTleHistory => r != null);
    const sampled = sampleRows(rows);
    const written = await upsertTleHistory(sampled);
    await setWorkerState(STATE_WATERMARK, { epochMs: nextRecentWatermarkMs(sinceMs, raw.map((r) => r.CREATION_DATE)) });
    await clearFailure();
    await logSync("tle-recent", "success", started, written);
    logger.info({ fetched: raw.length, sampled: sampled.length, written }, "tle-archive: recent watch ok");
  } catch (err) {
    await recordFailure(err);
    await logSync("tle-recent", "error", started, null, String(err));
    logger.warn({ err }, "tle-archive: recent watch failed");
    throw err;
  }
}

// ── backward-walking backfill ──────────────────────────────────────────────

/**
 * Fetch gp_history in bounded chunks, walking backward from "now" toward the
 * past. The cursor (epoch ms of the oldest already-covered instant) persists
 * across restarts. Budgeted to a handful of requests per run.
 */
export async function runTleBackfill(): Promise<void> {
  if (await backoffActive()) return;
  return withAdvisoryLock(LOCK_TLE_BACKFILL, "tle-backfill", doTleBackfill);
}

/** Oldest instant the backfill is allowed to cover (ms since epoch). */
export function backfillHorizonMs(nowMs: number = Date.now()): number {
  return nowMs - BACKFILL_HORIZON_DAYS * 86_400_000;
}

async function doTleBackfill(): Promise<void> {
  const started = new Date();
  let totalWritten = 0;
  try {
    await maintainLatestElsetTable();
    const horizonMs = backfillHorizonMs();
    const s = await getWorkerState<{ cursorMs: number }>(STATE_BACKFILL);
    let cursorMs = s?.cursorMs ?? Date.now();
    if (cursorMs <= horizonMs) {
      // Horizon reached: backfill is done. Keep pruning so retention holds
      // as the horizon slides forward with time.
      const pruned = await pruneTleHistory(horizonMs);
      await clearFailure();
      await logSync("tle-backfill", "success", started, pruned);
      logger.info({ pruned, horizonDays: BACKFILL_HORIZON_DAYS }, "tle-archive: backfill at horizon, prune-only run");
      return;
    }
    for (let i = 0; i < BACKFILL_REQUESTS_PER_RUN && cursorMs > horizonMs; i++) {
      const endMs = cursorMs;
      const startMs = Math.max(endMs - BACKFILL_CHUNK_HOURS * 3600_000, horizonMs);
      // Descending epoch order: the walker moves backward in time, so on a
      // capped response the rows we HAVE are the newest of the interval and
      // everything already covered is contiguous with the previous chunk.
      const path =
        `/basicspacedata/query/class/gp_history/EPOCH/${stFmt(startMs)}--${stFmt(endMs)}` +
        `/orderby/EPOCH%20desc/limit/${GP_HISTORY_ROW_LIMIT}/format/json`;
      const raw = await fetchJson<GpRow[]>(path);
      const rows = raw.map((r) => toRow(r, "backfill")).filter((r): r is InsertObcTleHistory => r != null);
      const sampled = sampleRows(rows);
      totalWritten += await upsertTleHistory(sampled);
      if (raw.length >= GP_HISTORY_ROW_LIMIT) {
        // Overflow: only [oldestReceived, end] is fully covered. Resume just
        // below the oldest row we actually got so the remainder of this
        // interval is drained next iteration (minus 1s to skip that exact
        // epoch; the unique index absorbs any boundary duplicate anyway).
        const oldest = rows.reduce((m, r) => Math.min(m, new Date(r.epoch as Date).getTime()), endMs);
        cursorMs = Math.min(oldest - 1000, endMs - 60_000);
      } else {
        cursorMs = startMs;
      }
      await setWorkerState(STATE_BACKFILL, { cursorMs });
    }
    await pruneTleHistory(horizonMs);
    await clearFailure();
    await logSync("tle-backfill", "success", started, totalWritten);
    logger.info({ written: totalWritten, cursor: new Date((await getWorkerState<{ cursorMs: number }>(STATE_BACKFILL))!.cursorMs).toISOString() }, "tle-archive: backfill step ok");
  } catch (err) {
    await recordFailure(err);
    await logSync("tle-backfill", "error", started, totalWritten, String(err));
    logger.warn({ err }, "tle-archive: backfill failed");
    throw err;
  }
}

// ── retention pruning ──────────────────────────────────────────────────────

/**
 * Enforce retention on obc_tle_history, bounded to PRUNE_ROW_LIMIT deletes
 * per call so it never monopolizes the DB:
 *  1. drop rows with epoch older than the horizon;
 *  2. thin rows older than COARSE_AFTER_DAYS down to one per object per UTC
 *     day (newest of each day wins) — recent-feed rows are stored at 6h
 *     resolution and age past the coarse boundary over time.
 */
/** UTC midnight at or before `ms`. Matches sampleRows' UTC day bins. */
export function utcDayStartMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The UTC day that just became coarse: it contains the instant before `coarseBeforeMs`. */
export function newestCoarseDayStartMs(coarseBeforeMs: number): number {
  return utcDayStartMs(coarseBeforeMs - 1);
}

/**
 * Backlog cursor for coarse thinning. The leading edge (newest coarse day)
 * is thinned on every run, so the cursor walks older days and wraps to the
 * day just behind that edge instead of re-scanning the whole horizon.
 * A day that filled the delete budget stays put so the rest of its
 * duplicates are removed on the next run.
 */
export function coerceCoarsePruneCursor(
  cursorMs: number | null,
  horizonMs: number,
  coarseBeforeMs: number,
): number {
  const leading = newestCoarseDayStartMs(coarseBeforeMs);
  const floor = utcDayStartMs(horizonMs);
  const behind = leading - DAY_MS;
  const fallback = behind >= floor ? behind : leading;
  if (cursorMs == null || !Number.isFinite(cursorMs)) return fallback;
  const day = utcDayStartMs(cursorMs);
  if (day === leading || day >= coarseBeforeMs || day < floor) return fallback;
  return day;
}

export function advanceCoarsePruneCursor(
  cursorMs: number,
  deleted: number,
  budget: number,
  horizonMs: number,
  coarseBeforeMs: number,
): number {
  if (deleted >= budget) return utcDayStartMs(cursorMs);
  const prev = utcDayStartMs(cursorMs) - DAY_MS;
  const floor = utcDayStartMs(horizonMs);
  if (prev < floor) return coerceCoarsePruneCursor(null, horizonMs, coarseBeforeMs);
  return prev;
}

/**
 * Delete rn>1 rows inside one UTC day. The day bounds keep this off the
 * ~19M-row window the old `epoch < coarse AND epoch >= horizon` plan sorted
 * on every backfill tick. Winner is still the newest epoch, then highest id.
 */
export function coarseDayThinSql(
  dayStart: Date,
  dayEnd: Date,
  horizon: Date,
  coarseBefore: Date,
  budget: number,
) {
  return sql`
    delete from obc_tle_history where id in (
      select id from (
        select id, row_number() over (
          partition by norad
          order by epoch desc, id desc
        ) as rn
        from obc_tle_history
        where epoch >= ${dayStart}
          and epoch < ${dayEnd}
          and epoch < ${coarseBefore}
          and epoch >= ${horizon}
      ) t
      where t.rn > 1
      limit ${budget}
    )
  `;
}

export function horizonDeleteSql(horizon: Date, budget: number) {
  return sql`
    delete from obc_tle_history where id in (
      select id from obc_tle_history
      where epoch < ${horizon}
      limit ${budget}
    )
    returning norad, epoch
  `;
}

function deletedEpochRows(result: unknown): { norad: number; epoch: Date }[] {
  const rows = Array.isArray(result)
    ? result
    : (result && typeof result === "object" && "rows" in result
      ? ((result as { rows?: unknown[] }).rows ?? [])
      : []);
  const out: { norad: number; epoch: Date }[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const norad = Number((row as { norad?: unknown }).norad);
    const raw = (row as { epoch?: unknown }).epoch;
    const epoch = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isFinite(norad) && Number.isFinite(epoch.getTime())) out.push({ norad, epoch });
  }
  return out;
}

function executeRowCount(result: unknown): number {
  if (result && typeof result === "object" && "rowCount" in result) {
    const n = (result as { rowCount?: number | null }).rowCount;
    return typeof n === "number" ? n : 0;
  }
  return 0;
}

export async function pruneTleHistory(horizonMs: number, nowMs: number = Date.now()): Promise<number> {
  let deleted = 0;
  try {
    const horizon = new Date(horizonMs);
    const beyondHorizon = await db.execute(horizonDeleteSql(horizon, PRUNE_ROW_LIMIT));
    const removed = deletedEpochRows(beyondHorizon);
    deleted += removed.length || executeRowCount(beyondHorizon);
    if (removed.length > 0) {
      await refreshLatestElsetsForDeletedEpochs(removed);
    }

    const budget = PRUNE_ROW_LIMIT - deleted;
    const coarseBeforeMs = nowMs - COARSE_AFTER_DAYS * DAY_MS;
    if (budget > 0 && coarseBeforeMs > horizonMs) {
      const coarseBefore = new Date(coarseBeforeMs);
      const leading = newestCoarseDayStartMs(coarseBeforeMs);
      // Rows age into the coarse region here. Always thin this day so a
      // 6-hour sample cannot sit for a full walk of the horizon.
      const leadDeleted = executeRowCount(await db.execute(coarseDayThinSql(
        new Date(leading),
        new Date(leading + DAY_MS),
        horizon,
        coarseBefore,
        budget,
      )));
      deleted += leadDeleted;
      const backlogBudget = budget - leadDeleted;
      const saved = await getWorkerState<{ dayStartMs?: number }>(STATE_PRUNE_DAY);
      const cursor = coerceCoarsePruneCursor(saved?.dayStartMs ?? null, horizonMs, coarseBeforeMs);
      let backlogDeleted = 0;
      if (backlogBudget > 0 && cursor !== leading && cursor + DAY_MS > horizonMs && cursor < coarseBeforeMs) {
        backlogDeleted = executeRowCount(await db.execute(coarseDayThinSql(
          new Date(cursor),
          new Date(cursor + DAY_MS),
          horizon,
          coarseBefore,
          backlogBudget,
        )));
        deleted += backlogDeleted;
      }
      const next = backlogBudget > 0
        ? advanceCoarsePruneCursor(cursor, backlogDeleted, backlogBudget, horizonMs, coarseBeforeMs)
        : cursor;
      await setWorkerState(STATE_PRUNE_DAY, { dayStartMs: next });
    }
    if (deleted > 0) logger.info({ deleted }, "tle-archive: retention prune");
  } catch (err) {
    logger.warn({ err }, "tle-archive: retention prune failed");
  }
  return deleted;
}

// ── queries used by the RPOD scanner & status endpoint ─────────────────────

export interface LatestElset {
  norad: number;
  epoch: Date;
  line1: string;
  line2: string;
  incDeg: number;
  raanDeg: number;
  eccentricity: number;
  argPerigeeDeg: number;
  meanAnomalyDeg: number;
  meanMotionRevPerDay: number;
}

/**
 * space-track publishes future-dated epochs for "multi-day" objects (period
 * of days; the provider slides the epoch forward to the next perigee so
 * sensors can acquire them). Live newestEpoch has been ~4 days ahead.
 * DISTINCT ON (norad) … ORDER BY epoch DESC would otherwise pick that
 * predicted elset as "latest" and hide a real current TLE.
 *
 * 6h of slack covers clock skew and near-term predicted epochs without
 * letting multi-day objects monopolize the scan set.
 */
export const ELSET_FUTURE_SLACK_MS = 6 * 3600_000;

/**
 * Walk drizzle / pg error cause chains. Drizzle wraps the driver error as
 * `Failed query: <sql>\nparams: …` and puts the real Postgres message on
 * `error.cause`. `String(err)` therefore dropped "canceling statement due to
 * statement timeout" / "out of memory" from lastScanError — live 2026-08-26
 * only stored the DISTINCT ON SQL.
 */
export function formatDbError(err: unknown, maxLen = 2000): string {
  const parts: string[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let i = 0; i < 6 && current != null && !seen.has(current); i++) {
    seen.add(current);
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0 && !codes.includes(code)) codes.push(code);
    }
    if (current instanceof Error) {
      if (current.message) parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const text = (codes.length ? `[${codes.join(",")}] ` : "") + parts.join(" <- ");
  return text.slice(0, maxLen);
}

/**
 * Pause before the single reconnect attempt. Short enough that a dead
 * database still fails the attempt quickly; long enough to let a pooler
 * slot free after the 10s handshake abort.
 */
export const DB_CONNECT_RETRY_DELAY_MS = 1_000;

/**
 * True for a dropped or never-established Postgres socket.
 *
 * Matches the live 2026-10-14 lastScanError
 * ("Connection terminated due to connection timeout <- Connection terminated unexpectedly"),
 * the pool-full checkout error ("timeout exceeded when trying to connect"),
 * and SQLSTATE 57P01 ("terminating connection due to administrator command")
 * which the same Replit Postgres emits when it drops a live socket.
 * A statement_timeout cancel is a slow plan, not a dead socket — retrying it
 * repeats the same query.
 */
export function isTransientConnectionError(err: unknown): boolean {
  const text = formatDbError(err);
  if (/statement timeout/i.test(text)) return false;
  return /connection terminated|terminating connection due to administrator command|\b57P01\b|timeout exceeded when trying to connect|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket disconnected before secure TLS|Client has encountered a connection error|not queryable/i.test(text);
}

/**
 * Attempts for a cheap idempotent sync-log write or freshness read, including
 * the first try. The sleeps below (1s + 2s + 4s + 8s) plus five 10s
 * handshakes span ~65s: longer than the one-shot retry that still lost the
 * 2026-10-14 flap, and shorter than the 2-minute rpod-scan check, so a real
 * outage still fails the tick instead of retrying for hours.
 */
export const DB_CONNECT_RETRY_ATTEMPTS = 5;
export const DB_CONNECT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

/**
 * Retry an idempotent Postgres call across a brief connect flap.
 * `attempts` includes the first try. A non-transient error throws immediately.
 * The last transient failure is rethrown unchanged so a real outage stays visible.
 */
export async function retryTransientConnection<T>(
  label: string,
  fn: () => Promise<T>,
  attempts: number = DB_CONNECT_RETRY_ATTEMPTS,
  delaysMs: readonly number[] = DB_CONNECT_RETRY_DELAYS_MS,
): Promise<T> {
  if (attempts < 1) throw new Error("retryTransientConnection attempts must be >= 1");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransientConnectionError(err)) throw err;
      const delayMs = delaysMs.length === 0 ? 0 : delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0;
      logger.warn(
        { err: formatDbError(err), label, attempt, attempts, retryInMs: delayMs },
        attempts === 2
          ? "db: transient connection error, retrying once"
          : "db: transient connection error, retrying",
      );
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("retryTransientConnection exhausted without a result");
}

/**
 * Run an idempotent read (or a pool.connect that has not started work) once
 * more after a transient socket/handshake failure. The second failure
 * propagates unchanged so callers still log or skip it.
 */
export async function retryOnceOnTransient<T>(
  label: string,
  fn: () => Promise<T>,
  delayMs: number = DB_CONNECT_RETRY_DELAY_MS,
): Promise<T> {
  const startedAt = Date.now();
  // The client the attempt actually used. Recovery may swap it before the
  // rejection is observed; failLockClient ignores a client that was already replaced.
  let used: DbPoolClient | null = null;
  const attempt = async (): Promise<T> => {
    await ensureAdvisoryLockClient();
    used = currentPoolClient();
    return await fn();
  };
  try {
    return await attempt();
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err;
    logger.warn({
      err: formatDbError(err), label, elapsedMs: Date.now() - startedAt,
      poolTotal: pool.totalCount, poolIdle: pool.idleCount, poolWaiting: pool.waitingCount,
    }, "db: transient connection error, retrying once");
    if (used) failLockClient(used, err instanceof Error ? err : new Error(formatDbError(err)));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return await attempt();
  }
}

const pgDialect = new PgDialect();

/** SQL text drizzle will send (params as `$n`) — for plan-shape tests. */
export function sqlTemplateText(query: unknown): string {
  return pgDialect.sqlToQuery(query as SQL).sql;
}

type LatestElsetRow = {
  norad: unknown;
  epoch: unknown;
  line1: unknown;
  line2: unknown;
  inc_deg?: unknown;
  incDeg?: unknown;
  raan_deg?: unknown;
  raanDeg?: unknown;
  eccentricity: unknown;
  arg_perigee_deg?: unknown;
  argPerigeeDeg?: unknown;
  mean_anomaly_deg?: unknown;
  meanAnomalyDeg?: unknown;
  mean_motion_rev_per_day?: unknown;
  meanMotionRevPerDay?: unknown;
};

export function mapLatestElsetRow(r: LatestElsetRow): LatestElset {
  const epoch = r.epoch instanceof Date ? r.epoch : new Date(String(r.epoch));
  return {
    norad: Number(r.norad),
    epoch,
    line1: String(r.line1 ?? ""),
    line2: String(r.line2 ?? ""),
    incDeg: Number(r.inc_deg ?? r.incDeg),
    raanDeg: Number(r.raan_deg ?? r.raanDeg),
    eccentricity: Number(r.eccentricity),
    argPerigeeDeg: Number(r.arg_perigee_deg ?? r.argPerigeeDeg),
    meanAnomalyDeg: Number(r.mean_anomaly_deg ?? r.meanAnomalyDeg),
    meanMotionRevPerDay: Number(r.mean_motion_rev_per_day ?? r.meanMotionRevPerDay),
  };
}

export const LATEST_ELSETS_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * Socket backstop, shortly after statement_timeout. SET LOCAL
 * statement_timeout never arrives when the pooler drops the TCP session
 * without a reply — node-pg then waits until the 25-minute scan deadline,
 * and that deadline used to discard the sync-log write. Destroying the
 * socket rejects the query so the skip/error row is written in a couple of
 * minutes instead.
 */
export const LATEST_ELSETS_CLIENT_TIMEOUT_MS = 150_000;

/**
 * When `ms` elapses, destroy the driver's socket and reject `promise`.
 * `cancel` disarms the timer (call it when the query finishes) and makes a
 * later fire a no-op so a successful read is not killed while being released.
 *
 * `client` is the node-pg PoolClient. Its public type hides `connection`;
 * the socket is still there at runtime.
 */
export function attachLatestElsetClientDeadline(
  client: object,
  ms: number,
): { promise: Promise<never>; cancel: () => void } {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectPromise: (err: Error) => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    rejectPromise = reject;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`latest-elset fetch exceeded ${ms}ms client deadline`);
      // Reject before destroy so Promise.race reports the deadline, not the
      // socket error that destroy raises a moment later.
      reject(err);
      try {
        const stream = (client as { connection?: { stream?: { destroy: (e?: Error) => void } } }).connection?.stream;
        stream?.destroy(err);
      } catch {
        // Socket already gone.
      }
    }, ms);
    timer.unref?.();
  });
  // Handled by Promise.race when the fetch uses it. Also covers cancel()
  // settling the loser so a pending deadline is not retained, and covers
  // unit tests that only observe the socket destroy.
  void promise.catch(() => undefined);
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectPromise(new Error("latest-elset client deadline cancelled"));
    },
  };
}

/** Drop the pooled client when the socket is dead; keep it after a clean statement timeout. */
export function latestElsetClientIsDead(err: unknown): boolean {
  const text = formatDbError(err);
  return /terminated|ECONN|socket|client deadline|timeout exceeded when trying to connect|not queryable/i.test(text);
}

async function queryLatestElsetRows(query: SQL, seqscanOff: boolean): Promise<LatestElset[]> {
  // Inside the RPOD scan this is the advisory-lock client, already checked
  // out and heartbeated. Releasing it would return the lock session to the
  // pool while the scan still holds the lock.
  const borrowed = currentPoolClient();
  const client = borrowed ?? await pool.connect();
  const deadline = attachLatestElsetClientDeadline(client, LATEST_ELSETS_CLIENT_TIMEOUT_MS);
  const work = (async (): Promise<LatestElset[]> => {
    const q = pgDialect.sqlToQuery(query);
    const params = q.params ?? [];
    // SET LOCAL is transaction-scoped so it cannot leak onto a pooled client.
    // enable_seqscan=off is only for the archive fallback: a misestimate there
    // walks ~19M heap rows. The latest-elset table is ~30k rows and should
    // be free to sequential-scan.
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${LATEST_ELSETS_STATEMENT_TIMEOUT_MS}`);
    if (seqscanOff) await client.query("SET LOCAL enable_seqscan = off");
    const result = await client.query<LatestElsetRow>(q.sql, params);
    await client.query("COMMIT");
    return result.rows.map((r) => mapLatestElsetRow(r));
  })();
  // If the deadline wins, the query rejection must not surface as unhandled.
  void work.catch(() => undefined);
  let releaseErr: Error | undefined;
  try {
    return await Promise.race([work, deadline.promise]);
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    if (latestElsetClientIsDead(wrapped)) releaseErr = wrapped;
    await client.query("ROLLBACK").catch(() => undefined);
    throw wrapped;
  } finally {
    deadline.cancel();
    if (!borrowed) {
      try {
        if (releaseErr) client.release(releaseErr);
        else client.release();
      } catch (releaseFailure) {
        logger.warn({ err: String(releaseFailure) }, "tle-archive: latest-elset client release failed");
      }
    }
  }
}

/** Latest archived elset per catalogued object with epoch in (`sinceMs`, `untilMs`]. */
export async function getLatestElsets(
  sinceMs: number,
  untilMs: number = Date.now() + ELSET_FUTURE_SLACK_MS,
): Promise<LatestElset[]> {
  const since = new Date(sinceMs);
  const until = new Date(untilMs);
  let ready = false;
  try {
    ready = await ensureLatestElsetReady();
  } catch (err) {
    if (!isUndefinedLatestTable(err)) throw err;
  }
  if (ready) {
    try {
      return await queryLatestElsetRows(latestElsetsQuerySql(since, until), false);
    } catch (err) {
      if (!isUndefinedLatestTable(err)) throw err;
      logger.warn("tle-archive: obc_latest_elset missing at read time; using archive seek");
    }
  } else {
    logger.warn("tle-archive: latest-elset table not ready; using per-norad archive seek");
  }
  return queryLatestElsetRows(latestElsetsArchiveSql(since, until), true);
}

/**
 * RPOD scan loader: never throw. A failed DISTINCT ON used to hit doScan's
 * catch, write lastScanStatus=error, and skip the hour. Skip/log instead so
 * a bad fetch cannot abort screening/persist for the rest of the objects.
 */
export async function getLatestElsetsOrSkip(
  sinceMs: number,
  untilMs: number = Date.now() + ELSET_FUTURE_SLACK_MS,
  fetchFn: (sinceMs: number, untilMs: number) => Promise<LatestElset[]> = getLatestElsets,
): Promise<{ rows: LatestElset[]; warning: string | null }> {
  try {
    const rows = await retryOnceOnTransient("latest-elset fetch", () => fetchFn(sinceMs, untilMs));
    return { rows, warning: null };
  } catch (err) {
    const warning = `latest-elset fetch skipped: ${formatDbError(err)}`;
    logger.warn({ err: warning }, "tle-archive: latest-elset fetch failed");
    return { rows: [], warning };
  }
}

/** Recent samples for one object (for RAAN-trend checks and event plots). */
export async function getRecentSamples(norad: number, sinceMs: number): Promise<LatestElset[]> {
  return db
    .select({
      norad: obcTleHistory.norad,
      epoch: obcTleHistory.epoch,
      line1: obcTleHistory.line1,
      line2: obcTleHistory.line2,
      incDeg: obcTleHistory.incDeg,
      raanDeg: obcTleHistory.raanDeg,
      eccentricity: obcTleHistory.eccentricity,
      argPerigeeDeg: obcTleHistory.argPerigeeDeg,
      meanAnomalyDeg: obcTleHistory.meanAnomalyDeg,
      meanMotionRevPerDay: obcTleHistory.meanMotionRevPerDay,
    })
    .from(obcTleHistory)
    .where(and(eq(obcTleHistory.norad, norad), gte(obcTleHistory.epoch, new Date(sinceMs))))
    .orderBy(asc(obcTleHistory.epoch));
}

export interface ArchiveStatus {
  totalRows: number;
  objects: number;
  newestEpoch: string | null;
  oldestEpoch: string | null;
  backfillCursor: string | null;
  recentWatermark: string | null;
  backoffUntil: string | null;
  /** Configured retention horizon in days; backfill never walks past it. */
  horizonDays: number;
  /** Oldest instant the archive retains (ISO), i.e. now − horizonDays. */
  horizon: string;
  /** Beyond this age (days), sampling coarsens to one elset/object/day. */
  coarseAfterDays: number;
  /** True once the backfill cursor has reached the horizon. */
  backfillComplete: boolean;
}

/**
 * Live GET /api/rpod/status (2026-08-25) timed out at 25s / 0 bytes, and a
 * retry took 59s, while GET /rpod/events returned in 0.26s. The status
 * handler used one aggregate:
 *   count(*), count(distinct norad), max(epoch), min(epoch)
 * over obc_tle_history (~5.1M rows). Mixing count(distinct) with min/max
 * forces a sequential scan and throws away the epoch-index min/max plan.
 *
 * Status must never seq-scan the archive: newest/oldest are LIMIT 1 index
 * probes; row/object counts come from planner stats (pg_class / pg_stats).
 * newestEpoch can still be days in the future — space-track publishes
 * predicted epochs for multi-day objects. That is archive truth, not the
 * scan window (getLatestElsets caps at now + ELSET_FUTURE_SLACK_MS).
 *
 * Live 2026-10-21 ~15:16Z: an unbounded `ORDER BY epoch ASC LIMIT 1` on the
 * 17.9M-row archive took ~27s (dead leading edge from horizon deletes) while
 * GET /api/rpod/events stayed under a second and the 10s cache made the
 * retry look healthy. The oldest probe starts a week before the horizon so
 * the index seek skips that graveyard and still reports a prune backlog.
 */
export const ARCHIVE_STATUS_CACHE_MS = 10_000;

/** How far before the retention horizon the oldest-epoch probe may start. */
export const ARCHIVE_OLDEST_PROBE_SLACK_MS = 7 * 86_400_000;

export function oldestArchiveProbeCutoff(nowMs: number = Date.now()): Date {
  return new Date(backfillHorizonMs(nowMs) - ARCHIVE_OLDEST_PROBE_SLACK_MS);
}

/**
 * One round trip, two index probes. The oldest probe is bounded so it does
 * not walk dead tuples from years of horizon deletes. The newest probe is
 * the live right edge (future-dated epochs included).
 */
export function archiveEpochBoundsSql(cutoff: Date = oldestArchiveProbeCutoff()) {
  return sql`
    SELECT
      (
        SELECT epoch FROM obc_tle_history
        WHERE epoch >= ${cutoff}
        ORDER BY epoch ASC
        LIMIT 1
      ) AS oldest_epoch,
      (
        SELECT epoch FROM obc_tle_history
        ORDER BY epoch DESC
        LIMIT 1
      ) AS newest_epoch
  `;
}

let archiveStatusCache: { at: number; value: ArchiveStatus } | null = null;
let archiveStatusInflight: Promise<ArchiveStatus> | null = null;

export function clearArchiveStatusCache(): void {
  archiveStatusCache = null;
}

/** Coerce a pg/js numeric (number | string | bigint) to a finite number. */
export function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** pg_class.reltuples is -1 before ANALYZE; never return a negative count. */
export function estimatePgCount(reltuples: number | null | undefined): number {
  if (reltuples == null || !Number.isFinite(reltuples) || reltuples < 0) return 0;
  return Math.round(reltuples);
}

/**
 * Decode pg_stats.n_distinct: positive = count, negative = −(fraction of
 * rows that are distinct). See PostgreSQL "Statistics Used by the Planner".
 */
export function estimatePgDistinct(nDistinct: number | null | undefined, reltuples: number): number {
  const rows = estimatePgCount(reltuples);
  if (nDistinct == null || !Number.isFinite(nDistinct) || nDistinct === 0) return 0;
  if (nDistinct < 0) return Math.max(0, Math.round((-nDistinct) * rows));
  return Math.max(0, Math.round(nDistinct));
}

function executeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    return ((result as { rows?: T[] }).rows) ?? [];
  }
  return [];
}

export async function getArchiveStatus(): Promise<ArchiveStatus> {
  if (archiveStatusCache && Date.now() - archiveStatusCache.at < ARCHIVE_STATUS_CACHE_MS) {
    return archiveStatusCache.value;
  }
  // A retry during a slow load used to start a second set of checkouts
  // before the cache was filled. Share the in-flight read.
  if (!archiveStatusInflight) {
    archiveStatusInflight = loadArchiveStatus()
      .then((value) => {
        archiveStatusCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        archiveStatusInflight = null;
      });
  }
  return archiveStatusInflight;
}

async function loadArchiveStatus(): Promise<ArchiveStatus> {
  const [boundResult, estResult, stateRows] = await Promise.all([
    db.execute(archiveEpochBoundsSql()),
    db.execute(sql`
      SELECT
        c.reltuples AS total_rows,
        s.n_distinct AS n_distinct
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stats s
        ON s.schemaname = n.nspname
       AND s.tablename = c.relname
       AND s.attname = 'norad'
      WHERE c.relname = 'obc_tle_history'
        AND n.nspname = ANY (current_schemas(false))
      LIMIT 1
    `).catch((err: unknown) => {
      logger.warn({ err }, "tle-archive: pg_class stats unavailable");
      return null;
    }),
    db.select().from(obcWorkerState).where(inArray(obcWorkerState.key, [
      STATE_BACKFILL, STATE_WATERMARK, STATE_BACKOFF,
    ])),
  ]);
  const bounds = executeRows<{ oldest_epoch: Date | string | null; newest_epoch: Date | string | null }>(boundResult)[0];
  const est = executeRows<{ total_rows: unknown; n_distinct: unknown }>(estResult)[0];
  const totalRows = estimatePgCount(asFiniteNumber(est?.total_rows));
  const objects = estimatePgDistinct(asFiniteNumber(est?.n_distinct), totalRows);
  const state = new Map(stateRows.map((row) => [row.key, row.value]));
  const bf = state.get(STATE_BACKFILL) as { cursorMs?: number } | undefined;
  const wm = state.get(STATE_WATERMARK) as { epochMs?: number } | undefined;
  const bo = state.get(STATE_BACKOFF) as { until?: number } | undefined;
  const iso = (v: string | Date | null | undefined): string | null =>
    v == null ? null : new Date(v).toISOString();
  return {
    totalRows,
    objects,
    newestEpoch: iso(bounds?.newest_epoch ?? null),
    oldestEpoch: iso(bounds?.oldest_epoch ?? null),
    horizonDays: BACKFILL_HORIZON_DAYS,
    horizon: new Date(backfillHorizonMs()).toISOString(),
    coarseAfterDays: COARSE_AFTER_DAYS,
    backfillComplete: bf?.cursorMs != null && bf.cursorMs <= backfillHorizonMs(),
    backfillCursor: bf?.cursorMs != null ? new Date(bf.cursorMs).toISOString() : null,
    recentWatermark: wm?.epochMs != null ? new Date(wm.epochMs).toISOString() : null,
    backoffUntil: bo?.until != null && bo.until > Date.now() ? new Date(bo.until).toISOString() : null,
  };
}
