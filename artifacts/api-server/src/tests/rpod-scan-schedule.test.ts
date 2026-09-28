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
  rpodScanIsDue, withDeadline, RPOD_SCAN_INTERVAL_MS, RPOD_SCAN_CHECK_INTERVAL_MS,
  RPOD_SCAN_BOOT_DELAY_MS, MAX_RPOD_SCAN_MS, RPOD_ALERT_TIMEOUT_MS,
  cancelScanAttempt, markScanLogged,
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
    /withDeadline\([\s\S]{0,200}postNewRpodEventAlerts/.test(scanSrc));
  check("interesting-only filter is still in front of persist",
    scanSrc.includes("selectInterestingEvents(")
    && /persistEvents\(conjKept\.kept/.test(scanSrc)
    && /persistEvents\(coKept\.kept/.test(scanSrc));

  const tleSrc = readFileSync(join(here, "../lib/obc/tleArchive.ts"), "utf8");
  check("latest-elset fetch sets a local statement_timeout",
    /SET LOCAL statement_timeout = \$\{LATEST_ELSETS_STATEMENT_TIMEOUT_MS\}/.test(tleSrc)
    && /LATEST_ELSETS_STATEMENT_TIMEOUT_MS = 120_000/.test(tleSrc));
  check("latest-elset fetch arms a client socket deadline under the scan cap",
    tleSrc.includes("attachLatestElsetClientDeadline(client, LATEST_ELSETS_CLIENT_TIMEOUT_MS)")
    && /LATEST_ELSETS_CLIENT_TIMEOUT_MS = 150_000/.test(tleSrc));
  check("client deadline destroys the pg socket",
    /stream\?\.destroy\(err\)/.test(tleSrc));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll RPOD scan-schedule checks passed");
