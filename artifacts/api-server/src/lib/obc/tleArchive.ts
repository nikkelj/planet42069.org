import { db, pool } from "@workspace/db";
import { obcTleHistory, obcWorkerState, obcSyncLog, type InsertObcTleHistory } from "@workspace/db/schema";
import { sql, desc, asc, and, gte, eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { logger } from "../logger";
import { runLockedSession } from "./advisorySession";

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
export async function withAdvisoryLock(key: number, label: string, fn: () => Promise<void>): Promise<void> {
  // pg-pool 3.13 (pg 8.20) is the only place that builds
  // "Connection terminated due to connection timeout" with cause
  // "Connection terminated unexpectedly": Pool.newClient destroys the
  // socket when a *new* handshake exceeds connectionTimeoutMillis (10s).
  // That rejection is not a Drizzle "Failed query", so runRpodScan's
  // lock-checkout catch stores it verbatim as lastScanStatus=error.
  // One retry: the scan has not started, and a second dial usually lands.
  const client = await retryOnceOnTransient(`${label} connect`, () => pool.connect());
  const ran = await runLockedSession(client, key, fn, (err) => {
    logger.error({ err: String(err), label }, "db: advisory lock session lost; discarding connection");
  });
  if (!ran) logger.info(`${label}: another instance holds the lock, skipping run`);
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

async function doRecentElsetWatch(): Promise<void> {
  const started = new Date();
  try {
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
  return /connection terminated|terminating connection due to administrator command|\b57P01\b|timeout exceeded when trying to connect|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket disconnected before secure TLS|Client has encountered a connection error/i.test(text);
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
  try {
    return await fn();
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err;
    logger.warn({
      err: formatDbError(err), label, elapsedMs: Date.now() - startedAt,
      poolTotal: pool.totalCount, poolIdle: pool.idleCount, poolWaiting: pool.waitingCount,
    }, "db: transient connection error, retrying once");
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return await fn();
  }
}

/**
 * True when `sqlText` is a cheap "latest elset per norad in a window" plan.
 *
 * The live 2026-08-26 scan failed on drizzle `selectDistinctOn(norad)` over
 * `obc_tle_history` (~5.1M rows) for a ~3-day epoch window while selecting
 * TLE `line1`/`line2`. Indexes are unique(norad, epoch) and (epoch). The
 * WHERE is an epoch range, so Postgres typically range-scans `epoch_idx`
 * then SORTS the matching heap rows by (norad, epoch DESC) for DISTINCT ON.
 * Those heap rows include two TEXT TLE lines — a few hundred thousand wide
 * tuples blow work_mem, spill, or hit statement_timeout.
 *
 * The Aug follow-up (MAX(epoch) GROUP BY norad, then join back) avoids
 * sorting TEXT, but the epoch index does not include norad, so the aggregate
 * still heap-fetches every row in the window. Live 2026-09-28 (~19.1M rows)
 * died on that plan with "Connection terminated due to connection timeout".
 *
 * Cheap at this size is LATERAL … ORDER BY epoch DESC LIMIT 1 keyed by
 * norad, which is an index seek on unique(norad, epoch). A wide DISTINCT ON,
 * or a window-wide MAX(epoch) aggregate, is not.
 */
export function latestElsetsSqlIsCheap(sqlText: string): boolean {
  const s = sqlText.toLowerCase().replace(/["`]/g, "").replace(/\s+/g, " ");
  const distinctOnWidePayload =
    /distinct\s+on/.test(s) && /line1/.test(s) && /line2/.test(s) && !/\blateral\b/.test(s);
  if (distinctOnWidePayload) return false;
  // The Sep 28 stall. Kept explicit so a regression to MAX+join fails the test
  // even if someone also pastes LATERAL somewhere in a comment.
  if (/max\s*\(\s*epoch\s*\)/.test(s) && /group\s+by\s+norad/.test(s)) return false;
  const lateralLimit =
    /\blateral\b/.test(s)
    && /\blimit\s+1\b/.test(s)
    && /order\s+by\s+[\w.]*epoch\s+desc/.test(s)
    && /norad\s*=\s*[\w.]*norad/.test(s);
  return lateralLimit;
}

/**
 * Latest-per-norad in (`since`, `until`] for every catalogued norad.
 *
 * Equivalent to MAX(epoch) per norad on the unique (norad, epoch) key, then
 * joining back for TLE lines — but driven from `obc_objects` (~70k norads)
 * so each object is one index seek + LIMIT 1. Empty ranges (no elset in the
 * window) drop out, matching the old inner join.
 *
 * Norads archived before they have an `obc_objects` row are omitted until
 * the next catalog merge. A window aggregate over `obc_tle_history` would
 * include them and is the plan that stalled at ~19M rows. New launches land
 * in `obc_objects` as space-track-only keys once that sync runs.
 */
export function latestElsetsQuerySql(since: Date, until: Date) {
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
  return /terminated|ECONN|socket|client deadline|timeout exceeded when trying to connect/i.test(text);
}

/** Latest archived elset per catalogued object with epoch in (`sinceMs`, `untilMs`]. */
export async function getLatestElsets(
  sinceMs: number,
  untilMs: number = Date.now() + ELSET_FUTURE_SLACK_MS,
): Promise<LatestElset[]> {
  const client = await pool.connect();
  const deadline = attachLatestElsetClientDeadline(client, LATEST_ELSETS_CLIENT_TIMEOUT_MS);
  const work = (async (): Promise<LatestElset[]> => {
    const q = pgDialect.sqlToQuery(latestElsetsQuerySql(new Date(sinceMs), new Date(untilMs)));
    const params = q.params ?? [];
    // SET LOCAL is transaction-scoped so it cannot leak onto a pooled client.
    // enable_seqscan=off stops a misestimate from walking ~19M heap rows; the
    // LATERAL seek on unique(norad, epoch) does not need a sequential scan.
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${LATEST_ELSETS_STATEMENT_TIMEOUT_MS}`);
    await client.query("SET LOCAL enable_seqscan = off");
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
    try {
      if (releaseErr) client.release(releaseErr);
      else client.release();
    } catch (releaseFailure) {
      logger.warn({ err: String(releaseFailure) }, "tle-archive: latest-elset client release failed");
    }
  }
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
 */
export const ARCHIVE_STATUS_CACHE_MS = 10_000;

let archiveStatusCache: { at: number; value: ArchiveStatus } | null = null;

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
  const value = await loadArchiveStatus();
  archiveStatusCache = { at: Date.now(), value };
  return value;
}

async function loadArchiveStatus(): Promise<ArchiveStatus> {
  const [newestRows, oldestRows, estResult, bf, wm, bo] = await Promise.all([
    db.select({ epoch: obcTleHistory.epoch }).from(obcTleHistory).orderBy(desc(obcTleHistory.epoch)).limit(1),
    db.select({ epoch: obcTleHistory.epoch }).from(obcTleHistory).orderBy(asc(obcTleHistory.epoch)).limit(1),
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
    getWorkerState<{ cursorMs: number }>(STATE_BACKFILL),
    getWorkerState<{ epochMs: number }>(STATE_WATERMARK),
    getWorkerState<{ until: number }>(STATE_BACKOFF),
  ]);
  const est = executeRows<{ total_rows: unknown; n_distinct: unknown }>(estResult)[0];
  const totalRows = estimatePgCount(asFiniteNumber(est?.total_rows));
  const objects = estimatePgDistinct(asFiniteNumber(est?.n_distinct), totalRows);
  const iso = (v: string | Date | null | undefined): string | null =>
    v == null ? null : new Date(v).toISOString();
  return {
    totalRows,
    objects,
    newestEpoch: iso(newestRows[0]?.epoch ?? null),
    oldestEpoch: iso(oldestRows[0]?.epoch ?? null),
    horizonDays: BACKFILL_HORIZON_DAYS,
    horizon: new Date(backfillHorizonMs()).toISOString(),
    coarseAfterDays: COARSE_AFTER_DAYS,
    backfillComplete: bf?.cursorMs != null && bf.cursorMs <= backfillHorizonMs(),
    backfillCursor: bf?.cursorMs != null ? new Date(bf.cursorMs).toISOString() : null,
    recentWatermark: wm?.epochMs != null ? new Date(wm.epochMs).toISOString() : null,
    backoffUntil: bo?.until != null && bo.until > Date.now() ? new Date(bo.until).toISOString() : null,
  };
}
