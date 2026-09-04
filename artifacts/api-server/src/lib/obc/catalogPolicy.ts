/**
 * Catalog-sync policy helpers with no DB or network imports so unit tests
 * can cover GCAT-recovery gating without booting postgres.
 */

/** Daily catalog cadence. GCAT and merge are gated independently at this interval. */
export const CATALOG_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CatalogSyncTimestamps {
  mergeSyncedAt: string | null;
  gcatSyncedAt: string | null;
}

function isStale(iso: string | null, nowMs: number, intervalMs: number): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= intervalMs;
}

/**
 * Catalog sync must run when *either* merge or GCAT is past the interval.
 * Gating only on mergeSyncedAt left GCAT stuck for days: doSync isolates
 * GCAT failures, merge still succeeds off Space-Track, and the next hourly
 * ticks then skipped the entire sync until merge aged out (~24h), so GCAT
 * got at most one retry per day.
 */
export function catalogNeedsSync(
  freshness: CatalogSyncTimestamps,
  nowMs = Date.now(),
  intervalMs = CATALOG_SYNC_INTERVAL_MS,
): boolean {
  return isStale(freshness.mergeSyncedAt, nowMs, intervalMs)
    || isStale(freshness.gcatSyncedAt, nowMs, intervalMs);
}

/** Map the newest gcat obc_sync_log row to a public, secret-free error string. */
export function formatGcatLastError(
  row: { status: string; error: string | null } | null | undefined,
): string | null {
  if (!row || row.status !== "error") return null;
  const msg = row.error?.trim();
  return msg && msg.length > 0 ? msg : "gcat sync failed";
}
