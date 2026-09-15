/**
 * Catalog-sync policy helpers with no DB or network imports so unit tests
 * can cover catalog-recovery gating without booting postgres.
 */

/** Daily catalog cadence. GCAT, Space-Track, and merge are gated independently. */
export const CATALOG_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CatalogSyncTimestamps {
  mergeSyncedAt: string | null;
  gcatSyncedAt: string | null;
  spacetrackSyncedAt: string | null;
}

function isStale(iso: string | null, nowMs: number, intervalMs: number): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= intervalMs;
}

/**
 * Catalog sync must run when *any* of merge / GCAT / Space-Track is past the
 * interval. Gating only on merge (then merge+GCAT) left the other isolated
 * source stuck: doSync swallows per-source failures, merge still succeeds off
 * the healthy source, and hourly ticks then skipped the entire sync until
 * merge aged out (~24h), so the failed source got at most one retry per day.
 */
export function catalogNeedsSync(
  freshness: CatalogSyncTimestamps,
  nowMs = Date.now(),
  intervalMs = CATALOG_SYNC_INTERVAL_MS,
): boolean {
  return isStale(freshness.mergeSyncedAt, nowMs, intervalMs)
    || isStale(freshness.gcatSyncedAt, nowMs, intervalMs)
    || isStale(freshness.spacetrackSyncedAt, nowMs, intervalMs);
}

/** Map the newest gcat obc_sync_log row to a public, secret-free error string. */
export function formatGcatLastError(
  row: { status: string; error: string | null } | null | undefined,
): string | null {
  return formatSourceLastError(row, "gcat sync failed");
}

/** Map the newest spacetrack obc_sync_log row to a public, secret-free error string. */
export function formatSpacetrackLastError(
  row: { status: string; error: string | null } | null | undefined,
): string | null {
  return formatSourceLastError(row, "spacetrack sync failed");
}

function formatSourceLastError(
  row: { status: string; error: string | null } | null | undefined,
  fallback: string,
): string | null {
  if (!row || row.status !== "error") return null;
  const msg = row.error?.trim();
  return msg && msg.length > 0 ? msg : fallback;
}
