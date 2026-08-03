import { logger } from "../logger";
import { runObcSync } from "./sync";
import { runGunterSync } from "./gunter";
import { getFreshness, getSatcatFromStore } from "./store";
import { runRecentElsetWatch, runTleBackfill } from "./tleArchive";
import { runRpodScan } from "../rpod/scan";

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const CHECK_INTERVAL_MS = 60 * 60 * 1000;     // hourly staleness check
const TLE_RECENT_INTERVAL_MS = 20 * 60 * 1000;   // recent-elsets watch cadence
const TLE_BACKFILL_INTERVAL_MS = 30 * 60 * 1000; // backfill step cadence
const RPOD_SCAN_INTERVAL_MS = 60 * 60 * 1000;    // full RPOD screen cadence

async function syncIfStale(): Promise<void> {
  try {
    const f = await getFreshness();
    const last = f.mergeSyncedAt ? new Date(f.mergeSyncedAt).getTime() : 0;
    const ageMs = Date.now() - last;
    if (ageMs < SYNC_INTERVAL_MS) {
      logger.info({ ageHours: Math.round(ageMs / 3600000 * 10) / 10 }, "obc-scheduler: catalog fresh, skipping sync");
    } else {
      logger.info("obc-scheduler: catalog stale, running sync");
      await runObcSync();
    }
  } catch (err) {
    logger.error({ err }, "obc-scheduler: sync attempt failed");
  }

  // Gunter's Space Page: separate daily cadence (its own rate-limited crawl
  // budget), run strictly after the main merge so annotations land on fresh rows.
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
  } catch (err) {
    logger.error({ err }, "obc-scheduler: gunter sync attempt failed");
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

/** Boot-time staleness check + hourly re-check. Safe for autoscale: also
 *  fires on cold boot, so long-idle instances catch up immediately. */
export function startObcScheduler(): void {
  // Warm the in-memory catalog store immediately so the first API hits
  // (e.g. the RPOD page's events list) don't pay the ~1s cold-load cost.
  setTimeout(() => { void getSatcatFromStore().catch(() => undefined); }, 500);

  setTimeout(() => safeTick("sync", syncIfStale), 2000);
  setInterval(() => safeTick("sync", syncIfStale), CHECK_INTERVAL_MS).unref();

  // TLE archive workers. The recent watcher runs first and often (it is the
  // tip-off feed); the backfill is deliberately offset so the two never
  // contend for the shared request queue at the same instant. The RPOD scan
  // is purely local (DB + CPU) and runs hourly after fresh elsets land.
  setTimeout(() => safeTick("tle-recent", runRecentElsetWatch), 10_000);
  setInterval(() => safeTick("tle-recent", runRecentElsetWatch), TLE_RECENT_INTERVAL_MS).unref();

  setTimeout(() => safeTick("tle-backfill", runTleBackfill), 3 * 60_000);
  setInterval(() => safeTick("tle-backfill", runTleBackfill), TLE_BACKFILL_INTERVAL_MS).unref();

  setTimeout(() => safeTick("rpod-scan", runRpodScan), 5 * 60_000);
  setInterval(() => safeTick("rpod-scan", runRpodScan), RPOD_SCAN_INTERVAL_MS).unref();
}
