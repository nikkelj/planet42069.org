/**
 * RPOD scan scheduling / timeout policy with no DB or network imports so
 * unit tests can cover overdue-scan gating without booting postgres.
 *
 * The hourly wall-clock interval alone is not enough on Replit autoscale:
 * a cold instance must notice that lastScanAt is stale and start a scan
 * without waiting for the next 60-minute setInterval from *this* process's
 * boot. Catalog sync already works this way (catalogNeedsSync); RPOD did not.
 */

/** Full RPOD screen cadence — lastScanAt younger than this is "fresh". */
export const RPOD_SCAN_INTERVAL_MS = 60 * 60 * 1000;

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

export function rpodScanIsDue(
  lastFinishedAtMs: number | null | undefined,
  nowMs: number,
  intervalMs: number = RPOD_SCAN_INTERVAL_MS,
): boolean {
  if (lastFinishedAtMs == null || !Number.isFinite(lastFinishedAtMs)) return true;
  return nowMs - lastFinishedAtMs >= intervalMs;
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
