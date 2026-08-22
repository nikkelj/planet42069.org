import { db, pool } from "@workspace/db";
import { obcTleHistory, obcWorkerState, obcSyncLog, type InsertObcTleHistory } from "@workspace/db/schema";
import { sql, desc, asc, gt, and, gte, eq } from "drizzle-orm";
import { logger } from "../logger";

/**
 * TLE history archive — samples space-track's public elset history into
 * Postgres so huge time ranges can be queried instantly.
 *
 *  - Recent watcher: polls the gp class for elsets with EPOCH newer than a
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

const STATE_WATERMARK = "tle_recent_watermark";
const STATE_BACKFILL = "tle_backfill_cursor";
const STATE_BACKOFF = "tle_backoff";

export interface GpRow {
  NORAD_CAT_ID: string;
  OBJECT_NAME?: string | null;
  EPOCH: string;
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
export async function withAdvisoryLock(key: number, label: string, fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [key]);
    if (!res.rows[0]?.locked) {
      logger.info(`${label}: another instance holds the lock, skipping run`);
      return;
    }
    try {
      await fn();
    } finally {
      // If the connection died mid-run the lock is already gone with the
      // session; a failed unlock must not mask fn's outcome or crash callers.
      await client.query("select pg_advisory_unlock($1)", [key]).catch((err) => {
        logger.warn({ err: String(err), label }, "advisory unlock failed (session likely dropped)");
      });
    }
  } finally {
    client.release();
  }
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

async function doRecentElsetWatch(): Promise<void> {
  const started = new Date();
  try {
    const s = await getWorkerState<{ epochMs: number }>(STATE_WATERMARK);
    // First run: start 6h back — the backfill owns the deep past.
    const sinceMs = s?.epochMs ?? Date.now() - 6 * 3600_000;
    const path =
      `/basicspacedata/query/class/gp/EPOCH/%3E${stFmt(sinceMs)}` +
      `/orderby/EPOCH%20asc/limit/${GP_HISTORY_ROW_LIMIT}/format/json`;
    const raw = await fetchJson<GpRow[]>(path);
    const rows = raw.map((r) => toRow(r, "recent")).filter((r): r is InsertObcTleHistory => r != null);
    const sampled = sampleRows(rows);
    const written = await upsertTleHistory(sampled);
    const maxEpoch = rows.reduce((m, r) => Math.max(m, new Date(r.epoch as Date).getTime()), sinceMs);
    // Step the watermark back 5 min to tolerate late-arriving elsets at the
    // boundary, and NEVER advance it past "now": space-track occasionally
    // publishes future-dated epochs, and letting one of those set the
    // watermark would silently skip every elset published in between.
    await setWorkerState(STATE_WATERMARK, { epochMs: Math.max(sinceMs, Math.min(maxEpoch, Date.now()) - 5 * 60_000) });
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
export async function pruneTleHistory(horizonMs: number, nowMs: number = Date.now()): Promise<number> {
  let deleted = 0;
  try {
    const beyondHorizon = await db.execute(sql`
      delete from obc_tle_history where id in (
        select id from obc_tle_history
        where epoch < ${new Date(horizonMs)}
        limit ${PRUNE_ROW_LIMIT}
      )`);
    deleted += beyondHorizon.rowCount ?? 0;

    const budget = PRUNE_ROW_LIMIT - deleted;
    if (budget > 0) {
      const coarseBefore = new Date(nowMs - COARSE_AFTER_DAYS * 86_400_000);
      const thinned = await db.execute(sql`
        delete from obc_tle_history where id in (
          select id from (
            select id, row_number() over (
              partition by norad, date_trunc('day', epoch)
              order by epoch desc, id desc
            ) as rn
            from obc_tle_history
            where epoch < ${coarseBefore} and epoch >= ${new Date(horizonMs)}
          ) t where t.rn > 1
          limit ${budget}
        )`);
      deleted += thinned.rowCount ?? 0;
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

/** Latest archived elset per object with epoch newer than `sinceMs`. */
export async function getLatestElsets(sinceMs: number): Promise<LatestElset[]> {
  const rows = await db
    .selectDistinctOn([obcTleHistory.norad], {
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
    .where(gt(obcTleHistory.epoch, new Date(sinceMs)))
    .orderBy(obcTleHistory.norad, desc(obcTleHistory.epoch));
  return rows;
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

export async function getArchiveStatus(): Promise<ArchiveStatus> {
  const [agg] = await db
    .select({
      totalRows: sql<number>`count(*)::int`,
      objects: sql<number>`count(distinct ${obcTleHistory.norad})::int`,
      newest: sql<string | null>`max(${obcTleHistory.epoch})`,
      oldest: sql<string | null>`min(${obcTleHistory.epoch})`,
    })
    .from(obcTleHistory);
  const [bf, wm, bo] = await Promise.all([
    getWorkerState<{ cursorMs: number }>(STATE_BACKFILL),
    getWorkerState<{ epochMs: number }>(STATE_WATERMARK),
    getWorkerState<{ until: number }>(STATE_BACKOFF),
  ]);
  const iso = (v: string | Date | null | undefined): string | null =>
    v == null ? null : new Date(v).toISOString();
  return {
    totalRows: agg?.totalRows ?? 0,
    objects: agg?.objects ?? 0,
    newestEpoch: iso(agg?.newest ?? null),
    oldestEpoch: iso(agg?.oldest ?? null),
    horizonDays: BACKFILL_HORIZON_DAYS,
    horizon: new Date(backfillHorizonMs()).toISOString(),
    coarseAfterDays: COARSE_AFTER_DAYS,
    backfillComplete: bf?.cursorMs != null && bf.cursorMs <= backfillHorizonMs(),
    backfillCursor: bf?.cursorMs != null ? new Date(bf.cursorMs).toISOString() : null,
    recentWatermark: wm?.epochMs != null ? new Date(wm.epochMs).toISOString() : null,
    backoffUntil: bo?.until != null && bo.until > Date.now() ? new Date(bo.until).toISOString() : null,
  };
}
