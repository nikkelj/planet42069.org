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
 * Stop every pre-persist stage this long before the hard cap so cluster,
 * persist, alerts, and retire still run.
 *
 * Only the SGP4 loops used to honor it. After they stopped, the co-aligned
 * screen, the widened rescreen, and the station-keeping history read kept
 * going against the hard cap. The persist checkpoint then threw
 * "rpod-scan timed out before persist" and stored lastScanEvents null
 * (live 2026-10-29 13:53Z and 15:04Z, after an 11:32Z success on the same
 * build). Must outlast alert posting plus a short persist/retire tail.
 *
 * Latest-elset pointer retries are not part of this reserve. They fail the
 * hour before screening, and one extra 30s client deadline cannot spend a
 * 25-minute scan.
 *
 * This reserve is not the whole post-screen budget. On a board of a few
 * hundred active events the persist + alert + reclassify + retire tail
 * overruns it (live 2026-11-18 17:09Z: rows landed at 17:07Z, then the
 * outer cap stored error / null). Screening still stops here so persist
 * starts inside the window. `RPOD_POST_SCREEN_TAIL_MS` is what lets that
 * tail finish after the cap instead of being recorded as a failed hour.
 */
export const RPOD_POST_SGP4_RESERVE_MS = 3 * 60 * 1000;

/**
 * How long a screened hour may keep the lock after the outer 25-minute cap.
 *
 * The cap used to reject `doScan` while persist, the 45s alert post,
 * reclassify, and retire were still running, then `cancelScanAttempt`
 * stored lastScanStatus=error and lastScanEvents=null. Live 2026-11-18
 * 17:09:01Z is that row: new events had been written at 17:07:21–17:07:38Z.
 * The tail gets this long, measured from the cap, to finish and write the
 * success row itself. A fast hour never waits it out.
 */
export const RPOD_POST_SCREEN_TAIL_MS = 8 * 60 * 1000;

/**
 * After the tail budget, ask doScan to stop between statements and wait
 * this long for the lock client to go idle before writing the success row
 * on another connection. Must outlast alert posting: that call has its own
 * deadline and will not notice cancellation until it returns.
 */
export const RPOD_POST_SCREEN_STOP_WAIT_MS = 60 * 1000;

/**
 * Deadline passed to catalog screens. Screening stops here and returns the
 * pairs already accepted, leaving `RPOD_POST_SGP4_RESERVE_MS` for persist.
 */
export function screenStopDeadlineMs(
  deadlineMs: number,
  reserveMs: number = RPOD_POST_SGP4_RESERVE_MS,
): number {
  return deadlineMs - reserveMs;
}

/** True when a pre-persist stage should stop so persist can still finish. */
export function sgp4ShouldStop(
  nowMs: number,
  deadlineMs: number,
  reserveMs: number = RPOD_POST_SGP4_RESERVE_MS,
): boolean {
  return nowMs > screenStopDeadlineMs(deadlineMs, reserveMs);
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

/**
 * Result of the catalog walk, published before persist. `catalogScreened`
 * is false when the hour never walked the catalog (elset fetch still
 * running, or both screens were skipped because the reserve was already
 * gone and they accepted no pairs). A finished walk that kept nothing is
 * screened: lastScanEvents 0 is a real empty board, not a skipped hour.
 */
export interface ScreenedScanTally {
  catalogScreened: boolean;
  rowCount: number;
  warnings: string[];
}

export interface HardCapSyncLog {
  status: "success" | "error";
  rowCount: number | null;
  error: string;
}

export type HardCapDisposition =
  | { kind: "rethrow" }
  | { kind: "keep"; failed: boolean }
  | { kind: "write"; via: "client" | "pool"; row: HardCapSyncLog };

/**
 * True when the outer `withDeadline(..., "rpod-scan")` timer won.
 * Stage throws ("timed out during SGP4", "timed out before elset fetch")
 * and elset-fetch failures are a different hour: those still retry.
 */
export function isRpodScanHardCapError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /rpod-scan timed out after \d+ms\b/.test(text);
}

/**
 * A walk that returns immediately because the deadline already passed
 * accepted no pairs. That is a skipped screen. A walk that finished, or
 * that stopped after accepting pairs, screened the catalog. Any kept
 * count above zero is persistable even if the flags disagree.
 */
export function catalogScreenCountsAsScreened(input: {
  stage1Invoked: boolean;
  stage1Pairs: number;
  stage1Truncated: boolean;
  coInvoked: boolean;
  coPairs: number;
  coTruncated: boolean;
  skRan: boolean;
  rowCount: number;
}): boolean {
  if (input.rowCount > 0) return true;
  const stage1Ran = input.stage1Invoked && !(input.stage1Truncated && input.stage1Pairs === 0);
  const coRan = input.coInvoked && !(input.coTruncated && input.coPairs === 0);
  return stage1Ran || coRan || input.skRan;
}

/**
 * Sync-log row for an outer hard cap. A screened tally is success with
 * that count, including 0. No tally, or a screen that never walked, stays
 * error / null so a failed elset fetch still retries.
 */
export function syncLogForHardCap(
  tally: ScreenedScanTally | null | undefined,
  timeoutError: string,
): HardCapSyncLog {
  const error = timeoutError.slice(0, 2000);
  if (
    tally?.catalogScreened !== true
    || !Number.isFinite(tally.rowCount)
    || tally.rowCount < 0
  ) {
    return { status: "error", rowCount: null, error };
  }
  const extra = tally.warnings.map((w) => w.trim()).filter((w) => w.length > 0).join("; ");
  const note = extra
    ? `${error} after a screened catalog (${tally.rowCount} events); ${extra}`
    : `${error} after a screened catalog (${tally.rowCount} events)`;
  return { status: "success", rowCount: tally.rowCount, error: note.slice(0, 2000) };
}

/**
 * The outer cap won the race with doScan. A screened hour keeps running
 * until it logs, or until the tail budget is gone.
 *
 * - "keep": doScan already wrote the sync-log row. `failed` means that
 *   row is an error and the scheduler should retry.
 * - "write" / client: doScan has released the lock client and did not log.
 *   The caller writes the screened success row on that client.
 * - "write" / pool: doScan is still on the client. The caller writes the
 *   same success row on another connection. `flag.logged` is set first so
 *   the late doScan cannot insert error / null.
 * - "rethrow": the catalog was not screened. The caller logs error / null.
 */
export async function dispositionAfterHardCap(
  tally: ScreenedScanTally | null | undefined,
  timeoutError: string,
  scan: Promise<unknown>,
  flag: ScanAttemptFlag & { loggedStatus?: "success" | "error" },
  tailMs: number,
  stopWaitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
): Promise<HardCapDisposition> {
  if (tally?.catalogScreened !== true) {
    void scan.then(() => {}, () => {});
    return { kind: "rethrow" };
  }
  let settled = false;
  const observed = scan.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  const first = await Promise.race([
    observed.then(() => "settled" as const),
    sleep(tailMs).then(() => "budget" as const),
  ]);
  if (flag.logged) return { kind: "keep", failed: flag.loggedStatus === "error" };
  if (first === "settled" || settled) {
    return { kind: "write", via: "client", row: syncLogForHardCap(tally, timeoutError) };
  }
  // Persist and the rest of the tail are still using the lock client.
  // Cancellation is noticed between events and between tail phases.
  flag.cancelled = true;
  const second = await Promise.race([
    observed.then(() => "settled" as const),
    sleep(stopWaitMs).then(() => "budget" as const),
  ]);
  if (flag.logged) return { kind: "keep", failed: flag.loggedStatus === "error" };
  if (second === "settled" || settled) {
    return { kind: "write", via: "client", row: syncLogForHardCap(tally, timeoutError) };
  }
  markScanLogged(flag);
  return { kind: "write", via: "pool", row: syncLogForHardCap(tally, timeoutError) };
}
