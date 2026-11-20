/**
 * Regression tests for the 2026-09-08 RPOD scanner stall:
 * lastScanStatus stayed "success" with lastScanAt frozen at 12:34Z while
 * TLE archive.recentWatermark kept moving and Space-Track backoff cleared.
 *
 * Failure mode:
 *  - RPOD was a fire-and-forget 5-min boot delay + 60-min setInterval.
 *    Autoscale cold boots and a hung in-flight scan (advisory lock +
 *    heartbeat) meant the next hour never completed a sync-log row.
 *  - Early "not enough elsets" returns wrote no log row, so lastScanAt
 *    looked stuck on the previous success.
 *
 * Locks in: staleness-gated checks (like catalogNeedsSync), a scan
 * wall-clock cap, skip paths that write lastScanAt, and a statement
 * timeout on the latest-elset fetch.
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rpodScanIsDue, withDeadline, RPOD_SCAN_INTERVAL_MS, RPOD_SCAN_ERROR_RETRY_MS, RPOD_SCAN_CHECK_INTERVAL_MS,
  RPOD_SCAN_BOOT_DELAY_MS, MAX_RPOD_SCAN_MS, RPOD_ALERT_TIMEOUT_MS,
  RPOD_POST_SGP4_RESERVE_MS, RPOD_POST_SCREEN_TAIL_MS, RPOD_POST_SCREEN_STOP_WAIT_MS,
  sgp4ShouldStop, screenStopDeadlineMs,
  cancelScanAttempt, markScanLogged,
  catalogScreenCountsAsScreened, syncLogForHardCap, isRpodScanHardCapError,
  dispositionAfterHardCap,
} from "../lib/rpod/scanPolicy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-09-08T15:30:00.000Z");
const at = (iso: string) => Date.parse(iso);

console.log("rpodScanIsDue: overdue lastScanAt must not wait for the next hourly wall clock");
{
  check("null lastScanAt is due", rpodScanIsDue(null, NOW) === true);
  check("undefined lastScanAt is due", rpodScanIsDue(undefined, NOW) === true);
  check("NaN lastScanAt is due", rpodScanIsDue(Number.NaN, NOW) === true);
  check("live stall (12:34Z vs 15:30Z) is due",
    rpodScanIsDue(at("2026-09-08T12:34:28.691Z"), NOW) === true);
  check("59 min ago is still fresh",
    rpodScanIsDue(NOW - 59 * 60_000, NOW) === false);
  check("a success 5 min ago is not due",
    rpodScanIsDue(NOW - RPOD_SCAN_ERROR_RETRY_MS, NOW, RPOD_SCAN_INTERVAL_MS, "success") === false);
  check("an error younger than the retry wait is not due",
    rpodScanIsDue(NOW - RPOD_SCAN_ERROR_RETRY_MS + 1, NOW, RPOD_SCAN_INTERVAL_MS, "error") === false);
  check("an error at the retry wait is due on any instance",
    rpodScanIsDue(NOW - RPOD_SCAN_ERROR_RETRY_MS, NOW, RPOD_SCAN_INTERVAL_MS, "error") === true);
  check("exactly 60 min ago is due",
    rpodScanIsDue(NOW - RPOD_SCAN_INTERVAL_MS, NOW) === true);
  check("cadence is hourly", RPOD_SCAN_INTERVAL_MS === 60 * 60 * 1000);
  check("check interval is minutes, not another hour",
    RPOD_SCAN_CHECK_INTERVAL_MS <= 5 * 60_000
    && RPOD_SCAN_CHECK_INTERVAL_MS < RPOD_SCAN_INTERVAL_MS,
    String(RPOD_SCAN_CHECK_INTERVAL_MS));
  check("boot delay is well under 5 minutes so autoscale can catch up",
    RPOD_SCAN_BOOT_DELAY_MS <= 60_000, String(RPOD_SCAN_BOOT_DELAY_MS));
  check("scan wall-clock cap sits inside a 15–30 min ops window",
    MAX_RPOD_SCAN_MS >= 10 * 60_000 && MAX_RPOD_SCAN_MS <= 30 * 60_000,
    String(MAX_RPOD_SCAN_MS));
  check("alert timeout is far below the scan cap",
    RPOD_ALERT_TIMEOUT_MS < MAX_RPOD_SCAN_MS && RPOD_ALERT_TIMEOUT_MS <= 60_000,
    String(RPOD_ALERT_TIMEOUT_MS));
  check("SGP4 reserve leaves room for alerts and persist inside the hard cap",
    RPOD_POST_SGP4_RESERVE_MS > RPOD_ALERT_TIMEOUT_MS
    && RPOD_POST_SGP4_RESERVE_MS < MAX_RPOD_SCAN_MS / 2,
    String(RPOD_POST_SGP4_RESERVE_MS));
  check("post-SGP4 reserve stays 3 minutes so the screen cut does not get deeper",
    RPOD_POST_SGP4_RESERVE_MS === 3 * 60_000);
  check("screened tail budget starts at the hard cap and outlasts the reserve",
    RPOD_POST_SCREEN_TAIL_MS > RPOD_POST_SGP4_RESERVE_MS
    && RPOD_POST_SCREEN_TAIL_MS <= 10 * 60_000,
    String(RPOD_POST_SCREEN_TAIL_MS));
  check("stop-wait outlasts alert posting so cancellation is noticed",
    RPOD_POST_SCREEN_STOP_WAIT_MS >= RPOD_ALERT_TIMEOUT_MS
    && RPOD_POST_SCREEN_STOP_WAIT_MS < RPOD_POST_SCREEN_TAIL_MS,
    String(RPOD_POST_SCREEN_STOP_WAIT_MS));
  check("SGP4 stops once only the reserve remains",
    sgp4ShouldStop(1_000, 1_000 + RPOD_POST_SGP4_RESERVE_MS - 1) === true
    && sgp4ShouldStop(1_000, 1_000 + RPOD_POST_SGP4_RESERVE_MS + 60_000) === false);
  check("catalog screens stop at the persist reserve, not the hard cap",
    screenStopDeadlineMs(1_500_000) === 1_500_000 - RPOD_POST_SGP4_RESERVE_MS
    && screenStopDeadlineMs(1_500_000) > 1_500_000 - MAX_RPOD_SCAN_MS);
  check("a stage inside the reserve is the same stop SGP4 already uses",
    sgp4ShouldStop(screenStopDeadlineMs(5_000) + 1, 5_000) === true
    && sgp4ShouldStop(screenStopDeadlineMs(5_000), 5_000) === false);
}

console.log("withDeadline rejects hung work so lastScanAt can move");
{
  const hung = new Promise<void>(() => { /* never settles */ });
  const t0 = Date.now();
  let threw = false;
  let msg = "";
  try {
    await withDeadline(hung, 40, "rpod-scan");
  } catch (err) {
    threw = true;
    msg = String(err);
  }
  check("withDeadline throws on timeout", threw);
  check("timeout error names the worker", msg.includes("rpod-scan") && msg.includes("timed out"), msg);
  check("timeout fires in well under a second", Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);

  const value = await withDeadline(Promise.resolve(7), 200, "ok");
  check("withDeadline returns the inner value when it wins", value === 7);
}

console.log("a scan deadline still leaves a sync-log row");
{
  const fresh = { cancelled: false, logged: false };
  check("deadline before any log must write a row", cancelScanAttempt(fresh) === true);
  check("deadline marks the attempt cancelled", fresh.cancelled === true);
  check("deadline does not pretend a row was written", fresh.logged === false);

  const already = { cancelled: false, logged: false };
  markScanLogged(already);
  check("deadline after doScan started its insert must not write a second row",
    cancelScanAttempt(already) === false && already.cancelled === true && already.logged === true);

  const late = { cancelled: false, logged: true };
  check("a row already flagged logged is not written again", cancelScanAttempt(late) === false);
}

console.log("scheduler + scan source: staleness checks, skip logging, timeouts");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const schedSrc = readFileSync(join(here, "../lib/obc/scheduler.ts"), "utf8");
  check("scheduler ticks runRpodScanIfDue, not a bare hourly runRpodScan",
    schedSrc.includes("runRpodScanIfDue")
    && /setInterval\(\(\) => safeTick\("rpod-scan", runRpodScanIfDue\)/.test(schedSrc));
  check("scheduler uses the short check interval, not the 60-min cadence as setInterval",
    schedSrc.includes("RPOD_SCAN_CHECK_INTERVAL_MS")
    && !/setInterval\(\(\) => safeTick\("rpod-scan".*RPOD_SCAN_INTERVAL_MS/.test(schedSrc));
  check("boot delay uses RPOD_SCAN_BOOT_DELAY_MS (not a hardcoded 5 min)",
    schedSrc.includes("RPOD_SCAN_BOOT_DELAY_MS")
    && !/safeTick\("rpod-scan".*5 \* 60_000/.test(schedSrc));
  check("due-check defers while the catalog cache is still loading",
    schedSrc.includes("CatalogLoadingError") && schedSrc.includes("catalog still loading"));
  check("due-check does not gate on Space-Track backoff", (() => {
    const start = schedSrc.indexOf("async function runRpodScanIfDue");
    const end = schedSrc.indexOf("async function runRpodScanWithRetry");
    const body = start >= 0 && end > start ? schedSrc.slice(start, end) : "backoffActive";
    return !/backoffActive|backoffUntil/.test(body);
  })());

  const scanSrc = readFileSync(join(here, "../lib/rpod/scan.ts"), "utf8");
  check("doScan takes a deadline and checks it",
    /async function doScan\(deadlineMs: number, abort: ScanAbort\)/.test(scanSrc) && scanSrc.includes("throwIfScanDeadline("));
  check("timed-out scan cancels the attempt and writes a sync-log row when doScan has not",
    /if \(cancelScanAttempt\(abort\)\)[\s\S]{0,180}logScanRow\(\s*"error"/.test(scanSrc));
  check("deadline and lock-checkout failures each write a sync-log row",
    scanSrc.split("cancelScanAttempt(abort)").length >= 3);
  check("doScan does not write a late row after the deadline cancelled it",
    /if \(abort\.cancelled\) return;/.test(scanSrc));
  check("empty-elset skip writes a success sync-log row",
    /if \(latest\.length < 2\)[\s\S]{0,250}logScanRow\("success"/.test(scanSrc));
  check("unusable-elset skip writes a success sync-log row",
    /if \(elsets\.length < 2\)[\s\S]{0,250}logScanRow\("success"/.test(scanSrc));
  check("alerts are wrapped in withDeadline",
    /withDeadline\([\s\S]{0,200}deliverPolicyAlerts/.test(scanSrc));
  check("interesting-only filter is still in front of persist",
    scanSrc.includes("selectInterestingEvents(")
    && /persistEvents\(conjKept\.kept/.test(scanSrc)
    && /persistEvents\(coKept\.kept/.test(scanSrc));
  check("conjunction SGP4 is phase-gated before the pair cap",
    /alongTrackRulesOutRange\(/.test(scanSrc)
    && /alongTrackRulesOutRange\([\s\S]{0,700}prioritizeSgp4Pairs\(/.test(scanSrc));
  check("widened rescreen is anchored on event members",
    /screenCandidatePairs\(neighborhood, relaxed, SCREEN_YIELD_EVERY, screenStopDeadlineMs\(deadlineMs\), memberSet/.test(scanSrc));
  check("SGP4 stops on the reserve instead of running into the hard cap",
    scanSrc.includes("sgp4ShouldStop("));
  check("persist checkpoint does not throw the hour away",
    !/throwIfScanDeadline\(deadlineMs,\s*"before persist"/.test(scanSrc)
    && scanSrc.includes("if (abort.cancelled) return;"));
  check("stage-1 and co-aligned screens use the persist-reserve deadline",
    /const screenDeadlineMs = screenStopDeadlineMs\(deadlineMs\)/.test(scanSrc)
    && /screenCandidatePairs\(elsets, DEFAULT_SCREEN, SCREEN_YIELD_EVERY, screenDeadlineMs/.test(scanSrc)
    && /screenCoAlignedPairs\(elsets, DEFAULT_COALIGNED, nowMs, SCREEN_YIELD_EVERY, screenDeadlineMs/.test(scanSrc));
  check("co-aligned screen and station-keeping wait while the persist reserve is open",
    /if \(!sgp4ShouldStop\(Date\.now\(\), deadlineMs\)\) \{\s*coInvoked = true;\s*coRaw = await screenCoAlignedPairs/.test(scanSrc)
    && /if \(!sgp4ShouldStop\(Date\.now\(\), deadlineMs\)\) \{\s*try \{\s*const samples: ElementSample\[]/.test(scanSrc));
  const tallyAt = scanSrc.indexOf("publishScanTally(abort");
  const skAt = scanSrc.indexOf("screenStationKeeping(");
  const persistAt = scanSrc.indexOf("persistEvents(conjKept.kept");
  check("screen tally is published before station-keeping and persist",
    tallyAt > 0 && skAt > tallyAt && persistAt > skAt);
  check("outer hard cap asks how to record a screened hour before the error row",
    /if \(isRpodScanHardCapError\(err\)\) \{\s*const disposition = await dispositionAfterHardCap\(/.test(scanSrc));
  check("a screened hard cap can write success instead of error/null",
    /disposition\.kind === "write"/.test(scanSrc)
    && /disposition\.row\.status/.test(scanSrc)
    && /via === "pool"/.test(scanSrc));
  check("persist stops between events once the hard-cap tail budget is spent",
    /shouldStop: \(\) => abort\.cancelled/.test(scanSrc)
    && /if \(opts\.shouldStop\?\.\(\)\) break;/.test(scanSrc));
  const skSrc = readFileSync(join(here, "../lib/rpod/stationKeeping.ts"), "utf8");
  check("station-keeping history seek is statement-capped inside the persist reserve",
    /STATION_KEEPING_HISTORY_TIMEOUT_MS = 20_000/.test(skSrc)
    && skSrc.includes("SET LOCAL statement_timeout = ${STATION_KEEPING_HISTORY_TIMEOUT_MS}")
    && /20_000/.test(skSrc));
  check("a finished scan logs a numeric event count",
    /logScanRow\(\s*\n\s*"success",\s*\n\s*started,\s*\n\s*conjKept\.kept\.length \+ coKept\.kept\.length \+ skEvents\.length/.test(scanSrc));
  check("partial SGP4 does not retire coplanar cases",
    scanSrc.includes("skipped coplanar retire after partial sgp4")
    && /else \{[\s\S]{0,180}retireDriftedCoplanarEvents\(/.test(scanSrc));

  const tleSrc = readFileSync(join(here, "../lib/obc/tleArchive.ts"), "utf8");
  check("latest-elset fetch sets a local statement_timeout",
    /SET LOCAL statement_timeout = \$\{LATEST_ELSETS_STATEMENT_TIMEOUT_MS\}/.test(tleSrc)
    && /LATEST_ELSETS_STATEMENT_TIMEOUT_MS = 20_000/.test(tleSrc));
  check("latest-elset fetch arms a client socket deadline under the scan cap",
    tleSrc.includes("attachLatestElsetClientDeadline(client, LATEST_ELSETS_CLIENT_TIMEOUT_MS)")
    && /LATEST_ELSETS_CLIENT_TIMEOUT_MS = 30_000/.test(tleSrc));
  check("client deadline destroys the pg socket",
    /stream\?\.destroy\(err\)/.test(tleSrc));
}

console.log("hard cap after a screened catalog is success with a numeric count");
{
  const cap = "rpod-scan timed out after 1500000ms";
  check("live 2026-11-18 string is the outer cap", isRpodScanHardCapError(new Error(cap)));
  check("an SGP4 stage throw is not the outer cap",
    isRpodScanHardCapError(new Error("rpod-scan timed out during SGP4")) === false);
  check("an elset-fetch failure is not the outer cap",
    isRpodScanHardCapError(new Error("latest-elset fetch exceeded 30000ms client deadline")) === false);

  const none = syncLogForHardCap(null, cap);
  check("no tally stays error with null events", none.status === "error" && none.rowCount === null && none.error === cap);
  const skipped = syncLogForHardCap(
    { catalogScreened: false, rowCount: 0, warnings: [] },
    cap,
  );
  check("a skipped screen is not success with 0", skipped.status === "error" && skipped.rowCount === null);
  const emptyBoard = syncLogForHardCap(
    { catalogScreened: true, rowCount: 0, warnings: ["screen stopped early to leave time for persist"] },
    cap,
  );
  check("a finished screen that kept nothing is success with 0",
    emptyBoard.status === "success" && emptyBoard.rowCount === 0 && emptyBoard.error.includes(cap));
  const live = syncLogForHardCap(
    { catalogScreened: true, rowCount: 117, warnings: ["sgp4 stopped early to stay inside the scan deadline"] },
    cap,
  );
  check("live-sized screened hour keeps the event count",
    live.status === "success" && live.rowCount === 117 && live.error.includes("sgp4 stopped early"));

  const walked = {
    stage1Invoked: true, stage1Pairs: 0, stage1Truncated: false,
    coInvoked: true, coPairs: 0, coTruncated: false,
    skRan: false, rowCount: 0,
  };
  check("a finished walk that accepted no pairs was screened", catalogScreenCountsAsScreened(walked));
  check("a deadline that returned before any pair is not a screened catalog",
    catalogScreenCountsAsScreened({ ...walked, stage1Truncated: true, coInvoked: false, coTruncated: true }) === false);
  check("a partial walk that already accepted pairs was screened",
    catalogScreenCountsAsScreened({ ...walked, stage1Truncated: true, stage1Pairs: 4, coInvoked: false }));
  check("kept events are persistable even if the walk flags say skipped",
    catalogScreenCountsAsScreened({
      stage1Invoked: false, stage1Pairs: 0, stage1Truncated: true,
      coInvoked: false, coPairs: 0, coTruncated: true,
      skRan: false, rowCount: 3,
    }));
  check("neither screen invoked and nothing kept is not screened",
    catalogScreenCountsAsScreened({
      stage1Invoked: false, stage1Pairs: 0, stage1Truncated: true,
      coInvoked: false, coPairs: 0, coTruncated: true,
      skRan: false, rowCount: 0,
    }) === false);
}

console.log("a screened tail that finishes after the cap is not rewritten as error/null");
{
  const cap = "rpod-scan timed out after 1500000ms";
  const tally = {
    catalogScreened: true,
    rowCount: 4,
    warnings: ["sgp4 stopped early to stay inside the scan deadline"],
  };
  // Events were already being written when the 25-minute timer won. doScan
  // logs success a moment later. The waiter must not queue an error row.
  const finished = { cancelled: false, logged: false, loggedStatus: undefined as "success" | "error" | undefined };
  const finishedScan = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    finished.logged = true;
    finished.loggedStatus = "success";
  })();
  const kept = await dispositionAfterHardCap(tally, cap, finishedScan, finished, 500, 200);
  check("late success is kept and the tail is not cancelled",
    kept.kind === "keep" && kept.failed === false && finished.cancelled === false);
  check("a kept success does not allocate another row", kept.kind !== "write");

  const failed = { cancelled: false, logged: false, loggedStatus: undefined as "success" | "error" | undefined };
  const failedScan = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    failed.logged = true;
    failed.loggedStatus = "error";
    throw new Error("connection terminated");
  })();
  const retry = await dispositionAfterHardCap(tally, cap, failedScan, failed, 500, 200);
  check("a real persist failure after the cap still retries",
    retry.kind === "keep" && retry.failed === true);

  const stopped = { cancelled: false, logged: false, loggedStatus: undefined as "success" | "error" | undefined };
  const stoppedScan = (async () => {
    while (!stopped.cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
  })();
  const ready = await dispositionAfterHardCap(tally, cap, stoppedScan, stopped, 30, 500);
  check("a tail that stops when cancelled is ready to log success on the lock client",
    ready.kind === "write" && ready.via === "client" && ready.row.status === "success" && ready.row.rowCount === 4
    && stopped.cancelled === true && stopped.logged === false,
    JSON.stringify(ready));

  const stuckFlag = { cancelled: false, logged: false, loggedStatus: undefined as "success" | "error" | undefined };
  const stuckScan = new Promise<void>(() => {});
  const stuck = await dispositionAfterHardCap(tally, cap, stuckScan, stuckFlag, 20, 20);
  check("a tail that never releases the client logs success on another connection",
    stuck.kind === "write" && stuck.via === "pool" && stuck.row.status === "success"
    && stuck.row.rowCount === 4 && stuckFlag.logged === true && stuckFlag.cancelled === true);

  const unscreened = { cancelled: false, logged: false };
  const hungFetch = new Promise<void>(() => {});
  const started = Date.now();
  const rethrow = await dispositionAfterHardCap(null, cap, hungFetch, unscreened, 2_000, 2_000);
  check("an unscreened cap does not wait out the tail budget",
    rethrow.kind === "rethrow" && Date.now() - started < 500);
  const skippedTally = { catalogScreened: false, rowCount: 0, warnings: [] as string[] };
  const skippedDisposition = await dispositionAfterHardCap(skippedTally, cap, hungFetch, unscreened, 2_000, 2_000);
  check("a skipped screen does not become a quiet success", skippedDisposition.kind === "rethrow");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll RPOD scan-schedule checks passed");
