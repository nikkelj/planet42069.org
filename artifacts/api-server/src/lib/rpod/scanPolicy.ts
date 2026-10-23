/**
 * RPOD scan scheduling / timeout policy with no DB or network imports so
 * unit tests can cover overdue-scan gating without booting postgres.
 *
 * The hourly wall-clock interval alone is not enough on Replit autoscale:
 * a cold instance must notice that lastScanAt is stale and start a scan
 * without waiting for the next 60-minute setInterval from *this* process's
 * boot. Catalog sync already works this way (catalogNeedsSync); RPOD did not.
 */

/** Full RPOD screen cadence — a success row younger than this is "fresh". */
export const RPOD_SCAN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * An error row is not a finished hour. The 5-minute and 10-minute retries
 * sleep inside the process that failed. Autoscale can recycle that process
 * during the sleep; every other instance was treating the error's finishedAt
 * as a fresh success for RPOD_SCAN_INTERVAL_MS, so nothing recorded another
 * attempt until the next hour. Five minutes matches the first in-process retry.
 */
export const RPOD_SCAN_ERROR_RETRY_MS = 5 * 60_000;

/**
 * How often the scheduler re-reads lastScanAt. Short so a warm autoscale
 * instance that missed the hourly tick (or booted after a hung replica)
 * catches up within minutes, not another hour.
 */
export const RPOD_SCAN_CHECK_INTERVAL_MS = 2 * 60 * 1000;

/** First staleness check after listen() — catalog primeCache is already running. */
export const RPOD_SCAN_BOOT_DELAY_MS = 20 * 1000;

/**
 * Wall-clock cap for one scan (elset fetch + screen + SGP4 + persist + alerts).
 * A hung tick used to hold the advisory lock (heartbeat keeps the session
 * alive) so every later hourly fire skipped, leaving lastScanAt frozen on
 * the previous success row.
 */
export const MAX_RPOD_SCAN_MS = 25 * 60 * 1000;

/** X citation posting must not hold the scan lock / delay lastScanAt. */
export const RPOD_ALERT_TIMEOUT_MS = 45 * 1000;

/**
 * Stop stage-2 SGP4 this long before the hard cap so cluster, persist,
 * alerts, and retire still run. The outer deadline used to win while SGP4
 * was in a pair, log "rpod-scan timed out after 1500000ms", and drop the
 * hour (lastScanEvents null) even when pairs were already flagged.
 * Must outlast alert posting plus a short persist/retire tail.
 */
export const RPOD_POST_SGP4_RESERVE_MS = 3 * 60 * 1000;

/** True when stage-2 should stop so the rest of the scan can finish. */
export function sgp4ShouldStop(
  nowMs: number,
  deadlineMs: number,
  reserveMs: number = RPOD_POST_SGP4_RESERVE_MS,
): boolean {
  return nowMs > deadlineMs - reserveMs;
}

export function rpodScanIsDue(
  lastFinishedAtMs: number | null | undefined,
  nowMs: number,
  intervalMs: number = RPOD_SCAN_INTERVAL_MS,
  status?: string | null,
): boolean {
  if (lastFinishedAtMs == null || !Number.isFinite(lastFinishedAtMs)) return true;
  const waitMs = status === "error" ? RPOD_SCAN_ERROR_RETRY_MS : intervalMs;
  return nowMs - lastFinishedAtMs >= waitMs;
}

/** Reject when `promise` has not settled by `ms`. Does not cancel `promise`. */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Flags for one scan attempt. `logged` is set synchronously before the
 * sync-log insert so a deadline that fires mid-insert does not add a second
 * row. `cancelled` stops the inner doScan from writing a late row after the
 * advisory lock is released.
 */
export interface ScanAttemptFlag {
  cancelled: boolean;
  logged: boolean;
}

export function markScanLogged(flag: ScanAttemptFlag): void {
  flag.logged = true;
}

/**
 * The wall-clock deadline won (or the inner attempt threw after the deadline
 * already logged). Returns true when this caller must insert the sync-log
 * row — a deadline used to set `cancelled` and return without a row, so
 * lastScanAt stayed on the previous success for hours.
 */
export function cancelScanAttempt(flag: ScanAttemptFlag): boolean {
  flag.cancelled = true;
  return !flag.logged;
}
