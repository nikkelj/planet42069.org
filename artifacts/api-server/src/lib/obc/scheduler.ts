import { logger } from "../logger";
import { runObcSync } from "./sync";
import { runGunterSync } from "./gunter";
import { getFreshness, primeCache, CatalogLoadingError, getSatcatFromStore } from "./store";
import { catalogNeedsSync, CATALOG_SYNC_INTERVAL_MS } from "./catalogPolicy";
import { runRecentElsetWatch, runTleBackfill } from "./tleArchive";
import {
  runRpodScan, latestRpodScanFinishedAtMs, rpodScanIsDue,
  RPOD_SCAN_INTERVAL_MS, RPOD_SCAN_CHECK_INTERVAL_MS, RPOD_SCAN_BOOT_DELAY_MS,
} from "../rpod/scan";

export { catalogNeedsSync, CATALOG_SYNC_INTERVAL_MS, RPOD_SCAN_INTERVAL_MS, rpodScanIsDue };

const SYNC_INTERVAL_MS = CATALOG_SYNC_INTERVAL_MS;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;     // hourly staleness check
const TLE_RECENT_INTERVAL_MS = 20 * 60 * 1000;   // recent-elsets watch cadence
const TLE_BACKFILL_INTERVAL_MS = 30 * 60 * 1000; // backfill step cadence

/**
 * Retry delays for a failed catalog-sync tick. Shorter than the hourly
 * interval so a transient DB blip does not leave the catalog stale all day.
 */
const SYNC_RETRY_DELAYS_MS = [5 * 60_000, 10 * 60_000]; // 5 min, then 10 min

function ageHours(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.round((nowMs - t) / 3_600_000 * 10) / 10;
}

async function syncIfStale(): Promise<void> {
  // ── catalog sync (with retry) ──────────────────────────────────────────
  for (let attempt = 0; ; attempt++) {
    try {
      const f = await getFreshness();
      const nowMs = Date.now();
      if (!catalogNeedsSync(f, nowMs)) {
        logger.info(
          { mergeAgeHours: ageHours(f.mergeSyncedAt, nowMs), gcatAgeHours: ageHours(f.gcatSyncedAt, nowMs) },
          "obc-scheduler: catalog fresh, skipping sync",
        );
      } else {
        logger.info(
          { mergeAgeHours: ageHours(f.mergeSyncedAt, nowMs), gcatAgeHours: ageHours(f.gcatSyncedAt, nowMs) },
          "obc-scheduler: catalog stale, running sync",
        );
        await runObcSync();
      }
      break; // success
    } catch (err) {
      const delay = SYNC_RETRY_DELAYS_MS[attempt];
      if (delay == null) {
        logger.error({ err: String(err), attempts: attempt + 1 }, "obc-scheduler: sync exhausted all retries");
        break;
      }
      logger.warn(
        { err: String(err), attempt: attempt + 1, retryInMs: delay },
        "obc-scheduler: sync failed, scheduling retry",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  // ── Gunter sync (with retry) ───────────────────────────────────────────
  // Separate daily cadence; run strictly after the main merge so annotations
  // land on fresh rows.
  for (let attempt = 0; ; attempt++) {
    try {
      const f = await getFreshness();
      const last = f.gunterSyncedAt ? new Date(f.gunterSyncedAt).getTime() : 0;
      const ageMs = Date.now() - last;
      if (ageMs < SYNC_INTERVAL_MS) {
        logger.info({ ageHours: Math.round(ageMs / 3600000 * 10) / 10 }, "obc-scheduler: gunter fresh, skipping");
        return;
      }
      logger.info("obc-scheduler: gunter stale, running daily crawl batch");
      await runGunterSync();
      return; // success
    } catch (err) {
      const delay = SYNC_RETRY_DELAYS_MS[attempt];
      if (delay == null) {
        logger.error({ err: String(err), attempts: attempt + 1 }, "obc-scheduler: gunter sync exhausted all retries");
        return;
      }
      logger.warn(
        { err: String(err), attempt: attempt + 1, retryInMs: delay },
        "obc-scheduler: gunter sync failed, scheduling retry",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Run one scheduled tick, swallowing every error. Worker entry points catch
 * their own failures, but errors thrown BEFORE their try blocks (advisory
 * lock acquisition, backoff-state reads — both DB round-trips) or from
 * failure-recording inside their catch blocks would otherwise escape as
 * unhandled rejections and kill the process on a transient DB disconnect.
 * A failed tick logs and waits for the next interval instead.
 */
function safeTick(label: string, fn: () => Promise<void>): void {
  fn().catch((err) => {
    logger.error({ err: String(err) }, `obc-scheduler: ${label} tick failed (will retry next interval)`);
  });
}

/**
 * Retry delays for failed TLE worker ticks. The recent watcher runs every
 * 20 min and the backfill every 30 min, so keep retries short enough to fit
 * a second attempt inside the same interval on a transient blip.
 */
const TLE_RETRY_DELAYS_MS = [2 * 60_000, 5 * 60_000]; // 2 min, then 5 min

/**
 * Retry delays for a failed RPOD scan tick. After each failure we wait this
 * long before trying again, so a single transient database blip does not
 * leave the case list stale for a full hour. If all retries are exhausted the
 * tick gives up and waits for the next hourly interval.
 */
const RPOD_RETRY_DELAYS_MS = [5 * 60_000, 10 * 60_000]; // 5 min, then 10 min

/**
 * Run the recent-elset watcher with retry. doRecentElsetWatch() re-throws
 * after logging so retries here actually fire.
 */
async function runRecentElsetWatchWithRetry(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runRecentElsetWatch();
      return;
    } catch (err) {
      const delay = TLE_RETRY_DELAYS_MS[attempt];
      if (delay == null) {
        logger.error({ err: String(err), attempts: attempt + 1 }, "obc-scheduler: tle-recent exhausted all retries");
        return;
      }
      logger.warn(
        { err: String(err), attempt: attempt + 1, retryInMs: delay },
        "obc-scheduler: tle-recent failed, scheduling retry",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Run the TLE backfill with retry. doTleBackfill() re-throws after logging
 * so retries here actually fire.
 */
async function runTleBackfillWithRetry(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runTleBackfill();
      return;
    } catch (err) {
      const delay = TLE_RETRY_DELAYS_MS[attempt];
      if (delay == null) {
        logger.error({ err: String(err), attempts: attempt + 1 }, "obc-scheduler: tle-backfill exhausted all retries");
        return;
      }
      logger.warn(
        { err: String(err), attempt: attempt + 1, retryInMs: delay },
        "obc-scheduler: tle-backfill failed, scheduling retry",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Run the RPOD scan when lastScanAt is older than RPOD_SCAN_INTERVAL_MS.
 * Checked on a short cadence so autoscale cold boots and a missed hourly
 * tick still recover — matching catalogNeedsSync, not a fire-and-forget
 * 60-minute setInterval from this process's boot.
 *
 * Space-Track backoff does not apply: the scan is local (DB + CPU).
 * If the in-memory catalog is still loading, defer to the next check so
 * interesting-only filtering has owner/operator metadata.
 */
async function runRpodScanIfDue(): Promise<void> {
  const last = await latestRpodScanFinishedAtMs();
  if (!rpodScanIsDue(last, Date.now())) {
    logger.info(
      { ageMin: last != null ? Math.round((Date.now() - last) / 60_000) : null },
      "obc-scheduler: rpod-scan fresh, skipping",
    );
    return;
  }
  try {
    await getSatcatFromStore();
  } catch (err) {
    if (err instanceof CatalogLoadingError) {
      logger.info("obc-scheduler: rpod-scan deferred, catalog still loading");
      return;
    }
  }
  await runRpodScanWithRetry();
}

/**
 * Run the RPOD scan. On failure, retry up to RPOD_RETRY_DELAYS_MS.length
 * times with increasing delays before giving up until the next due-check.
 * doScan() re-throws after logging so the retries here actually fire.
 */
async function runRpodScanWithRetry(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runRpodScan();
      return;
    } catch (err) {
      const delay = RPOD_RETRY_DELAYS_MS[attempt];
      if (delay == null) {
        logger.error({ err: String(err), attempts: attempt + 1 }, "obc-scheduler: rpod-scan exhausted all retries");
        return;
      }
      logger.warn(
        { err: String(err), attempt: attempt + 1, retryInMs: delay },
        "obc-scheduler: rpod-scan failed, scheduling retry",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Boot-time staleness check + hourly re-check. Safe for autoscale: also
 *  fires on cold boot, so long-idle instances catch up immediately. */
export function startObcScheduler(): void {
  // Start loading the in-memory catalog in the background immediately so
  // the server is ready to accept requests without waiting for the full
  // ~70 k-row DB query to complete (which can take several minutes cold).
  // Requests that arrive before the load finishes receive a 503 rather
  // than hanging; once the load lands all subsequent requests are served
  // from the warm cache.
  primeCache();

  setTimeout(() => safeTick("sync", syncIfStale), 2000);
  setInterval(() => safeTick("sync", syncIfStale), CHECK_INTERVAL_MS).unref();

  // TLE archive workers. The recent watcher runs first and often (it is the
  // tip-off feed); the backfill is deliberately offset so the two never
  // contend for the shared request queue at the same instant. The RPOD scan
  // is purely local (DB + CPU). It re-checks lastScanAt every few minutes
  // so a stale board recovers on the next tick instead of waiting for a
  // 60-minute timer that started at this process's boot.
  setTimeout(() => safeTick("tle-recent", runRecentElsetWatchWithRetry), 10_000);
  setInterval(() => safeTick("tle-recent", runRecentElsetWatchWithRetry), TLE_RECENT_INTERVAL_MS).unref();

  setTimeout(() => safeTick("tle-backfill", runTleBackfillWithRetry), 3 * 60_000);
  setInterval(() => safeTick("tle-backfill", runTleBackfillWithRetry), TLE_BACKFILL_INTERVAL_MS).unref();

  setTimeout(() => safeTick("rpod-scan", runRpodScanIfDue), RPOD_SCAN_BOOT_DELAY_MS);
  setInterval(() => safeTick("rpod-scan", runRpodScanIfDue), RPOD_SCAN_CHECK_INTERVAL_MS).unref();
}
