/**
 * Regression tests for GCAT catalog-sync recovery (2026-09 stuck sync).
 *
 *  1. Scheduler must retry when any isolated source is stale while others
 *     stay fresh (GCAT stuck behind merge; Space-Track stuck behind GCAT+merge).
 *  2. Dual TSV pull is sequential, times out above the old 60s bar, and keeps
 *     the minimum-size sanity check — all without live network.
 *  3. Summary freshness surfaces the latest GCAT sync-log error.
 *
 * Run with: pnpm --filter @workspace/api-server run test:gcat-sync
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogNeedsSync,
  CATALOG_SYNC_INTERVAL_MS,
  formatGcatLastError,
  formatSpacetrackLastError,
} from "../lib/obc/catalogPolicy";
import {
  fetchGcatCatalog,
  GCAT_FETCH_TIMEOUT_MS,
  GCAT_MIN_BYTES,
  GCAT_SATCAT_URL,
  GCAT_LAUNCH_URL,
  type GcatFetch,
} from "../lib/obc/gcat";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.parse("2026-09-04T16:00:00.000Z");
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

function testCatalogNeedsSync(): void {
  console.log("\n[1] Scheduler: any stale source (GCAT / Space-Track / merge) must still attempt sync");

  const fresh = (h: number) => ({
    mergeSyncedAt: hoursAgo(h),
    gcatSyncedAt: hoursAgo(h),
    spacetrackSyncedAt: hoursAgo(h),
  });

  check(
    "merge fresh (22h) + gcat stale (7.5d) + st fresh → needs sync",
    catalogNeedsSync({
      mergeSyncedAt: hoursAgo(22),
      gcatSyncedAt: hoursAgo(24 * 7.5),
      spacetrackSyncedAt: hoursAgo(22),
    }, NOW) === true,
  );
  check(
    "merge+gcat fresh (17h) + spacetrack stale (42h) → needs sync",
    catalogNeedsSync({
      mergeSyncedAt: hoursAgo(17),
      gcatSyncedAt: hoursAgo(17),
      spacetrackSyncedAt: hoursAgo(42),
    }, NOW) === true,
  );
  check(
    "all three fresh (22h) → skip",
    catalogNeedsSync(fresh(22), NOW) === false,
  );
  check(
    "merge stale (25h) + gcat/st fresh → needs sync",
    catalogNeedsSync({
      mergeSyncedAt: hoursAgo(25),
      gcatSyncedAt: hoursAgo(1),
      spacetrackSyncedAt: hoursAgo(1),
    }, NOW) === true,
  );
  check(
    "never synced (nulls) → needs sync",
    catalogNeedsSync({ mergeSyncedAt: null, gcatSyncedAt: null, spacetrackSyncedAt: null }, NOW) === true,
  );
  check(
    "spacetrack never synced, merge+gcat fresh → needs sync",
    catalogNeedsSync({
      mergeSyncedAt: hoursAgo(1),
      gcatSyncedAt: hoursAgo(1),
      spacetrackSyncedAt: null,
    }, NOW) === true,
  );
  check(
    "exactly at the interval → needs sync",
    catalogNeedsSync(fresh(24), NOW) === true,
  );
  check(
    "just under the interval → skip",
    catalogNeedsSync(fresh(23.9), NOW) === false,
  );
  check(
    "catalog interval is daily",
    CATALOG_SYNC_INTERVAL_MS === 24 * 60 * 60 * 1000,
  );
}

async function testSequentialFetch(): Promise<void> {
  console.log("\n[2] GCAT fetch: sequential dual-TSV pull (no live network)");

  const events: string[] = [];
  let releaseSatcat!: () => void;
  const holdSatcat = new Promise<void>((r) => {
    releaseSatcat = r;
  });
  const body = "x".repeat(GCAT_MIN_BYTES);

  const mockFetch: GcatFetch = async (url) => {
    if (url === GCAT_SATCAT_URL) {
      events.push("satcat-start");
      await holdSatcat;
      events.push("satcat-end");
      return new Response(body, { status: 200 });
    }
    if (url === GCAT_LAUNCH_URL) {
      events.push("launch-start");
      events.push("launch-end");
      return new Response(body, { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const pending = fetchGcatCatalog(mockFetch);
  await new Promise<void>((r) => setImmediate(r));
  check(
    "launch has not started while satcat is in flight",
    !events.includes("launch-start"),
    `events=${events.join(",")}`,
  );
  releaseSatcat();
  const result = await pending;
  check(
    "order is satcat then launch",
    events.join(",") === "satcat-start,satcat-end,launch-start,launch-end",
    `events=${events.join(",")}`,
  );
  check("satcat body returned", result.satTsv.length === GCAT_MIN_BYTES);
  check("launch body returned", result.launchTsv.length === GCAT_MIN_BYTES);
}

async function testFetchHardening(): Promise<void> {
  console.log("\n[3] GCAT fetch: timeout bar, min-size check, HTTP errors");

  check(
    "timeout is longer than the 60s that stalled on autoscale",
    GCAT_FETCH_TIMEOUT_MS > 60_000,
    `got ${GCAT_FETCH_TIMEOUT_MS}`,
  );
  check(
    "timeout is at least 3 minutes per file",
    GCAT_FETCH_TIMEOUT_MS >= 180_000,
    `got ${GCAT_FETCH_TIMEOUT_MS}`,
  );

  let tinyThrew = "";
  try {
    await fetchGcatCatalog(async () => new Response("tiny", { status: 200 }));
  } catch (err) {
    tinyThrew = String(err);
  }
  check(
    "rejects suspiciously small bodies",
    /suspiciously small/.test(tinyThrew),
    tinyThrew.slice(0, 180),
  );

  let httpThrew = "";
  try {
    await fetchGcatCatalog(async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }));
  } catch (err) {
    httpThrew = String(err);
  }
  check(
    "rejects non-OK HTTP with status in the message",
    /gcat fetch failed: 503/.test(httpThrew),
    httpThrew.slice(0, 180),
  );

  let abortThrew = "";
  try {
    await fetchGcatCatalog(async () => {
      throw new Error("TimeoutError: signal timed out");
    });
  } catch (err) {
    abortThrew = String(err);
  }
  check(
    "wraps abort/timeout with url + elapsed time",
    /gcat fetch aborted\/failed after \d+ms/.test(abortThrew) && abortThrew.includes("satcat"),
    abortThrew.slice(0, 220),
  );
}

function testGcatLastError(): void {
  console.log("\n[4] Freshness: latest GCAT/Space-Track errors are admin-safe and diagnosable");

  check("no row → null", formatGcatLastError(undefined) === null);
  check("success row → null", formatGcatLastError({ status: "success", error: null }) === null);
  check(
    "error row with message → message",
    formatGcatLastError({ status: "error", error: "gcat fetch aborted/failed after 60012ms" })
      === "gcat fetch aborted/failed after 60012ms",
  );
  check(
    "error row with empty message → generic",
    formatGcatLastError({ status: "error", error: "  " }) === "gcat sync failed",
  );
  check(
    "error row with null message → generic",
    formatGcatLastError({ status: "error", error: null }) === "gcat sync failed",
  );
  check(
    "spacetrack error row with message → message",
    formatSpacetrackLastError({ status: "error", error: "space-track satcat fetch failed: 401" })
      === "space-track satcat fetch failed: 401",
  );
  check(
    "spacetrack error row with null message → generic",
    formatSpacetrackLastError({ status: "error", error: null }) === "spacetrack sync failed",
  );
}

function testSourceContracts(): void {
  console.log("\n[5] Source contracts: scheduler gates GCAT; sync fetches sequentially");

  const here = dirname(fileURLToPath(import.meta.url));
  const schedulerSrc = readFileSync(join(here, "../lib/obc/scheduler.ts"), "utf8");
  const syncSrc = readFileSync(join(here, "../lib/obc/sync.ts"), "utf8");
  const policySrc = readFileSync(join(here, "../lib/obc/catalogPolicy.ts"), "utf8");
  const storeSrc = readFileSync(join(here, "../lib/obc/store.ts"), "utf8");

  check(
    "scheduler uses catalogNeedsSync (not merge-only age)",
    schedulerSrc.includes("catalogNeedsSync(f"),
  );
  check(
    "catalogNeedsSync considers gcatSyncedAt",
    /isStale\(freshness\.gcatSyncedAt/.test(policySrc),
  );
  check(
    "catalogNeedsSync considers spacetrackSyncedAt",
    /isStale\(freshness\.spacetrackSyncedAt/.test(policySrc),
  );
  check(
    "getFreshness exposes spacetrackLastError from the latest spacetrack log row",
    storeSrc.includes("spacetrackLastError: formatSpacetrackLastError(latestStAny[0])"),
  );
  check(
    "doSync no longer Promise.all's the two GCAT TSVs",
    !/Promise\.all\(\[\s*fetchGcatSatcatTsv\(\),\s*fetchGcatLaunchTsv\(\)\s*\]\)/.test(syncSrc),
  );
  check(
    "doSync uses fetchGcatCatalog",
    syncSrc.includes("fetchGcatCatalog()"),
  );
  check(
    "getFreshness exposes gcatLastError from the latest gcat log row",
    storeSrc.includes("gcatLastError: formatGcatLastError(latestGcatAny[0])"),
  );
}

async function main(): Promise<void> {
  console.log("=== gcat sync recovery tests ===");
  testCatalogNeedsSync();
  await testSequentialFetch();
  await testFetchHardening();
  testGcatLastError();
  testSourceContracts();

  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected test runner error:", err);
  process.exit(1);
});
