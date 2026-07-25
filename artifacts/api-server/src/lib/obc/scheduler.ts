import { logger } from "../logger";
import { runObcSync } from "./sync";
import { runGunterSync } from "./gunter";
import { getFreshness } from "./store";

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const CHECK_INTERVAL_MS = 60 * 60 * 1000;     // hourly staleness check

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

/** Boot-time staleness check + hourly re-check. Safe for autoscale: also
 *  fires on cold boot, so long-idle instances catch up immediately. */
export function startObcScheduler(): void {
  setTimeout(() => { void syncIfStale(); }, 2000);
  setInterval(() => { void syncIfStale(); }, CHECK_INTERVAL_MS).unref();
}
