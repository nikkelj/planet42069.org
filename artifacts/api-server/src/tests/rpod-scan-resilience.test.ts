/**
 * Regression tests for the 2026-08-25 RPOD scan/status outage and the
 * 2026-08-26 follow-on: the hourly scan itself still failed after status
 * was made fast.
 *  - GET /api/rpod/status must not seq-scan obc_tle_history (live timed out
 *    at 25s / 0 bytes; a retry took 59s while /rpod/events was 0.26s)
 *  - lastScanError is returned so ops can see why lastScanStatus=error
 *    without logs (obc_sync_log.error was stored but never selected)
 *  - persistEvents continues after one event's transaction fails, instead
 *    of marking the whole hourly scan as error
 *  - getLatestElsets must not DISTINCT ON the full TLE payload over a 3-day
 *    window of ~5.1M-row obc_tle_history (live 2026-08-26 ~13:45Z Failed
 *    query; String(err) hid the PG cause; doScan stamped status=error)
 *  - the Aug MAX(epoch)+join follow-up is also not cheap at ~19M rows
 *    (live 2026-09-28 connection timeout). A per-norad LATERAL seek of the
 *    archive still heap-fetches ~30k TLE rows and timed out handshakes
 *    next to thinning. The scan reads obc_latest_elset. History is sought
 *    only for pointer rows whose epoch is already past the window, and an
 *    unfinished backfill must not fall back to the catalog-wide probe
 *    (live 2026-10-22 handshake timeout).
 *  - a failed latest-elset fetch skips/logs instead of aborting doScan
 *  - a pg-pool handshake abort ("Connection terminated due to connection
 *    timeout <- Connection terminated unexpectedly", live 2026-10-14) is
 *    retried once on lock checkout and on idempotent reads, and is not a
 *    statement-timeout retry
 *  - the rpod-scan sync-log insert and the freshness read retry that same
 *    class (and SQLSTATE 57P01) enough times to ride out a brief flap, then
 *    throw the original error once those attempts are exhausted
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, pool } from "@workspace/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { rpodEvents, rpodEventMembers } from "@workspace/db/schema";
import { inArray, eq } from "drizzle-orm";
import type { Server } from "node:http";
import app from "../app";
import { persistEvents, formatRpodScanStatus, insertRpodScanSyncLog, latestRpodScanFinishedAtMs, elsetFetchFailureShouldRetryScan, rethrowIfConnectionLost } from "../lib/rpod/scan";
import { MAX_RPOD_SCAN_MS, RPOD_SCAN_CHECK_INTERVAL_MS } from "../lib/rpod/scanPolicy";
import {
  getArchiveStatus, clearArchiveStatusCache,
  getLatestElsetsOrSkip, formatDbError, latestElsetsSqlIsCheap,
  historyLateralIsCatalogWide, latestElsetsInWindowSql, latestElsetsFutureSql,
  latestElsetsArchiveSql, futureElsetSeekPinsCompositeIndex, futureElsetCorrectionFailureAbortsFetch,
  sqlTemplateText, mapLatestElsetRow,
  archiveEpochBoundsSql, oldestArchiveProbeCutoff, ARCHIVE_OLDEST_PROBE_SLACK_MS, backfillHorizonMs,
  attachLatestElsetClientDeadline, latestElsetClientIsDead,
  LATEST_ELSETS_STATEMENT_TIMEOUT_MS, LATEST_ELSETS_CLIENT_TIMEOUT_MS,
  isTransientConnectionError, retryOnceOnTransient, retryTransientConnection, DB_CONNECT_RETRY_DELAY_MS,
  DB_CONNECT_RETRY_ATTEMPTS, DB_CONNECT_RETRY_DELAYS_MS,
} from "../lib/obc/tleArchive";
import type { ClusteredEvent } from "../lib/rpod/screen";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const GOOD_PAIR = [99999401, 99999402];
/** Beyond PostgreSQL integer (32-bit); member insert must fail the transaction. */
const OVERFLOW_PAIR = [3_000_000_000, 3_000_000_001];

function makeCluster(members: number[], nowMs: number): ClusteredEvent {
  const [a, b] = members;
  return {
    members,
    pairs: [{ a, b, minRangeKm: 8.5, relVelKmS: 0.04, tcaMs: nowMs }],
    minRangeKm: 8.5, relVelKmS: 0.04, tcaMs: nowMs,
    windowStartMs: nowMs - 3600_000,
    windowEndMs: nowMs + 3600_000,
    hitCap: false,
  };
}

async function dbReachable(): Promise<boolean> {
  if (!process.env["DATABASE_URL"]) return false;
  try {
    const client = await pool.connect();
    client.release();
    return true;
  } catch (err) {
    console.log(`  (database unreachable: ${String(err).slice(0, 120)})`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log("formatRpodScanStatus exposes the stored error reason");
  {
    const errRow = {
      finishedAt: new Date("2026-08-25T14:23:49.275Z"),
      status: "error",
      rowCount: null,
      error: "error: timeout exceeded when trying to connect",
    };
    const mapped = formatRpodScanStatus(errRow);
    check("error status includes lastScanError", mapped.lastScanError === errRow.error);
    check("error status keeps lastScanEvents null", mapped.lastScanEvents === null);
    check("error status timestamp is ISO", mapped.lastScanAt === "2026-08-25T14:23:49.275Z");
    const ok = formatRpodScanStatus({
      finishedAt: new Date("2026-08-25T13:21:27.000Z"),
      status: "success",
      rowCount: 6,
      error: null,
    });
    check("success status has null lastScanError", ok.lastScanError === null);
    check("missing row → all nulls", formatRpodScanStatus(null).lastScanStatus === null);
  }

  console.log("getLatestElsets must not DISTINCT ON the TLE payload (2026-08-26)");
  {
    // Verbatim from live lastScanError on GET /api/rpod/status ~15:04 UTC.
    const liveFailedSql = `
      select distinct on ("obc_tle_history"."norad") "norad", "epoch", "line1", "line2",
      "inc_deg", "raan_deg", "eccentricity", "arg_perigee_deg", "mean_anomaly_deg",
      "mean_motion_rev_per_day" from "obc_tle_history"
      where ("obc_tle_history"."epoch" > $1 and "obc_tle_history"."epoch" <= $2)
      order by "obc_tle_history"."norad", "obc_tle_history"."epoch" desc
    `;
    check(
      "live DISTINCT ON (norad) selecting line1/line2 is NOT a cheap plan",
      latestElsetsSqlIsCheap(liveFailedSql) === false,
    );

    // Verbatim shape from live lastScanError on 2026-09-28 ~15:16Z. The
    // MAX(epoch) aggregate over the epoch index heap-fetches the whole window.
    const liveMaxJoinSql = `
      SELECT h.norad, h.epoch, h.line1, h.line2
      FROM obc_tle_history AS h
      INNER JOIN (
        SELECT norad, MAX(epoch) AS epoch
        FROM obc_tle_history
        WHERE epoch > $1 AND epoch <= $2
        GROUP BY norad
      ) AS latest
        ON latest.norad = h.norad AND latest.epoch = h.epoch
    `;
    check(
      "live MAX(epoch)+join over obc_tle_history is NOT a cheap plan",
      latestElsetsSqlIsCheap(liveMaxJoinSql) === false,
    );

    const since = new Date("2026-08-23T13:44:31.178Z");
    const until = new Date("2026-08-26T19:44:31.178Z");
    const sqlText = sqlTemplateText(latestElsetsInWindowSql(since, until));
    check("in-window latest-elset SQL is a pointer read", latestElsetsSqlIsCheap(sqlText), sqlText.slice(0, 500));
    check("in-window SQL does not DISTINCT ON", !/distinct\s+on/i.test(sqlText), sqlText.slice(0, 160));
    check("in-window SQL does not aggregate MAX(epoch) over the archive", !/max\s*\(\s*epoch\s*\)/i.test(sqlText), sqlText.slice(0, 240));
    check("in-window SQL does not read obc_tle_history", !/obc_tle_history/i.test(sqlText), sqlText.slice(0, 400));
    check("in-window SQL filters catalog membership without DISTINCT norad",
      /obc_objects/i.test(sqlText) && !/distinct\s+norad/i.test(sqlText), sqlText.slice(0, 400));
    check("in-window SQL reads obc_latest_elset", /from\s+obc_latest_elset/i.test(sqlText), sqlText.slice(0, 400));
    check("in-window SQL keeps the epoch window", /epoch\s*>/i.test(sqlText) && /epoch\s*<=/i.test(sqlText));
    check("in-window SQL still selects TLE lines", /h\.line1/.test(sqlText) && /h\.line2/.test(sqlText));
    const futureText = sqlTemplateText(latestElsetsFutureSql(since, until));
    check("future-dated correction is not a catalog-wide history probe",
      historyLateralIsCatalogWide(futureText) === false, futureText.slice(0, 500));
    check("future-dated correction filters the pointer before the lateral",
      /obc_latest_elset/i.test(futureText) && /epoch\s*>/i.test(futureText.split(/lateral/i)[0] ?? ""),
      futureText.slice(0, 500));
    check("future-dated correction seeks one history row",
      /obc_tle_history/i.test(futureText) && /limit\s+1/i.test(futureText));
    check("future-dated correction pins the (norad, epoch) index",
      futureElsetSeekPinsCompositeIndex(futureText), futureText.slice(0, 500));
    check("future-dated correction casts bounds to timestamp",
      /::timestamp/i.test(futureText) && /::timestamp/i.test(sqlText));
    const epochIndexSeek = `
      select line1 from obc_tle_history
      where norad = $1 and epoch > $2 and epoch <= $3
      order by epoch desc
      limit 1
    `;
    check("bare epoch window ORDER BY epoch DESC is not a pinned seek",
      futureElsetSeekPinsCompositeIndex(epochIndexSeek) === false);
    // The pre-fix union put WHERE h.epoch > until AFTER the lateral, and the
    // lateral was driven by every distinct catalog norad. That is the plan
    // that still produced the 2026-10-22 handshake timeout.
    const previousUnion = `
      select h.line1 from (select distinct norad from obc_objects) ids
      join obc_latest_elset h on h.norad = ids.norad
      where h.epoch > $1 and h.epoch <= $2
      union all
      select p.line1 from (select distinct norad from obc_objects) ids
      join obc_latest_elset h on h.norad = ids.norad
      cross join lateral (
        select line1 from obc_tle_history where norad = h.norad
        order by epoch desc limit 1
      ) p
      where h.epoch > $2
    `;
    check("pre-fix union is a catalog-wide history probe", historyLateralIsCatalogWide(previousUnion) === true);
    check("pre-fix union is not the cheap plan", latestElsetsSqlIsCheap(previousUnion) === false);
    const archiveText = sqlTemplateText(latestElsetsArchiveSql(since, until));
    check("full-catalog archive lateral is not the cheap plan", latestElsetsSqlIsCheap(archiveText) === false, archiveText.slice(0, 200));
    check("full-catalog archive lateral is catalog-wide", historyLateralIsCatalogWide(archiveText) === true, archiveText.slice(0, 200));
    const tleSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/obc/tleArchive.ts"), "utf8");
    const latestSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/obc/latestElset.ts"), "utf8");
    check("getLatestElsets waits for the pointer table and reads it",
      /ensureLatestElsetReady\(/.test(tleSrc) && /latestElsetsInWindowSql\(/.test(tleSrc));
    check("getLatestElsets does not fall back to the archive seek",
      !/latestElsetsArchiveSql\(/.test(tleSrc));
    check("a missing pointer table is an error, not an archive probe",
      /refusing full-catalog history probe/.test(tleSrc));
    check("backfill batches cannot hash or seq-scan history",
      /SET LOCAL enable_seqscan = off/.test(latestSrc)
      && /SET LOCAL enable_hashjoin = off/.test(latestSrc)
      && /SET LOCAL enable_mergejoin = off/.test(latestSrc));
    check("in-window pointer read is a sequential scan, not an epoch index range",
      /SET LOCAL enable_indexscan = off/.test(tleSrc)
      && /SET LOCAL enable_bitmapscan = off/.test(tleSrc)
      && /SET LOCAL max_parallel_workers_per_gather = 0/.test(tleSrc));
    check("future-dated correction cannot bitmap-scan the history epoch index",
      /SET LOCAL enable_bitmapscan = off/.test(tleSrc));
    check("pointer index is (epoch, norad), not epoch alone",
      /obc_latest_elset_epoch_norad_idx/.test(latestSrc)
      && /DROP INDEX IF EXISTS obc_latest_elset_epoch_idx/.test(latestSrc));
    check("a failed backfill batch stops instead of throwing into the archive probe",
      /latest-elset backfill batch stopped/.test(latestSrc));
    check("statement timeout on the future-dated correction keeps the in-window rows",
      futureElsetCorrectionFailureAbortsFetch(new Error("canceling statement due to statement timeout")) === false);
    check("handshake abort on the future-dated correction still retries the fetch",
      futureElsetCorrectionFailureAbortsFetch(new Error(
        "Connection terminated due to connection timeout",
        { cause: new Error("Connection terminated unexpectedly") },
      )) === true);

    const cutoff = oldestArchiveProbeCutoff(Date.parse("2026-10-21T15:16:12Z"));
    const boundsSql = sqlTemplateText(archiveEpochBoundsSql(cutoff));
    check("status oldest epoch starts a week before the horizon",
      cutoff.getTime() === backfillHorizonMs(Date.parse("2026-10-21T15:16:12Z")) - ARCHIVE_OLDEST_PROBE_SLACK_MS);
    check("status bounds SQL seeks oldest epoch from a cutoff",
      /where epoch >=/i.test(boundsSql) && /order by epoch asc/i.test(boundsSql) && /limit 1/i.test(boundsSql),
      boundsSql.slice(0, 300));
    check("status bounds SQL does not seq-scan with count or distinct",
      !/count\s*\(/i.test(boundsSql) && !/distinct/i.test(boundsSql), boundsSql.slice(0, 200));
    check("status bounds SQL still reads the newest epoch",
      /order by epoch desc/i.test(boundsSql) && /newest_epoch/i.test(boundsSql), boundsSql.slice(0, 400));

    const mapped = mapLatestElsetRow({
      norad: 25544,
      epoch: since,
      line1: "1 25544U",
      line2: "2 25544",
      inc_deg: 51.6,
      raan_deg: 10,
      eccentricity: 0.0001,
      arg_perigee_deg: 90,
      mean_anomaly_deg: 0,
      mean_motion_rev_per_day: 15.5,
    });
    check("mapLatestElsetRow promotes snake_case heap columns", mapped.incDeg === 51.6 && mapped.norad === 25544);
  }

  console.log("Failed query cause is preserved; fetch skip does not abort doScan");
  {
    const liveQuery =
      `Failed query: select distinct on ("obc_tle_history"."norad") "norad", "epoch", "line1", "line2" from "obc_tle_history" where ("obc_tle_history"."epoch" > $1 and "obc_tle_history"."epoch" <= $2) order by "obc_tle_history"."norad", "obc_tle_history"."epoch" desc\nparams: 2026-08-23T13:44:31.178Z,2026-08-26T19:44:31.178Z`;
    const drizzleErr = new Error(liveQuery);
    const timeout = new Error("canceling statement due to statement timeout");
    (timeout as Error & { code: string }).code = "57014";
    drizzleErr.cause = timeout;
    const formatted = formatDbError(drizzleErr);
    check("String(err) is only the Failed query wrapper (what live lastScanError stored)", !String(drizzleErr).includes("statement timeout"));
    check("formatDbError includes the PG cause", formatted.includes("statement timeout"), formatted);
    check("formatDbError includes SQLSTATE 57014", formatted.includes("57014"), formatted);

    let threw = false;
    let loaded: Awaited<ReturnType<typeof getLatestElsetsOrSkip>> | null = null;
    let statementCalls = 0;
    try {
      loaded = await getLatestElsetsOrSkip(0, 1, async () => {
        statementCalls++;
        throw drizzleErr;
      });
    } catch (err) {
      threw = true;
      check("getLatestElsetsOrSkip did not throw", false, String(err));
    }
    check("getLatestElsetsOrSkip did not throw", !threw);
    check("statement timeout is not retried before the skip", statementCalls === 1, String(statementCalls));
    check("failed fetch returns no rows", loaded?.rows.length === 0);
    check("failed fetch returns a skip warning", typeof loaded?.warning === "string" && (loaded?.warning ?? "").includes("latest-elset fetch skipped"));
    check("skip warning includes the PG cause", (loaded?.warning ?? "").includes("statement timeout"));

    // doScan writes this shape instead of status=error / rowCount=null.
    const skipStatus = formatRpodScanStatus({
      finishedAt: new Date("2026-08-26T13:45:02.964Z"),
      status: "success",
      rowCount: 0,
      error: loaded?.warning ?? "missing",
    });
    check("elset-fetch skip is lastScanStatus=success, not error", skipStatus.lastScanStatus === "success");
    check("elset-fetch skip keeps lastScanError for ops", typeof skipStatus.lastScanError === "string" && skipStatus.lastScanError.includes("fetch skipped"));
    check("live 13:45Z error row would still map as error (old path)", formatRpodScanStatus({
      finishedAt: new Date("2026-08-26T13:45:02.964Z"),
      status: "error",
      rowCount: null,
      error: liveQuery,
    }).lastScanStatus === "error");

    const scanSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/rpod/scan.ts"), "utf8");
    check("doScan loads elsets via getLatestElsetsOrSkip", scanSrc.includes("getLatestElsetsOrSkip("));
    check("doScan does not call throwing getLatestElsets(", !/\bgetLatestElsets\(/.test(scanSrc));
    const liveFetchWarning =
      "latest-elset fetch skipped: Failed query: select ... from rpod_events <- Connection terminated due to connection timeout <- Connection terminated unexpectedly";
    check("connection timeout on the elset fetch must retry the scan", elsetFetchFailureShouldRetryScan(liveFetchWarning));
    check("statement timeout on the elset fetch must retry the scan",
      elsetFetchFailureShouldRetryScan("latest-elset fetch skipped: canceling statement due to statement timeout"));
    check("query read timeout on the elset fetch must retry the scan",
      elsetFetchFailureShouldRetryScan("Query read timeout"));
    check("a non-timeout skip warning does not fail the scan",
      elsetFetchFailureShouldRetryScan("latest-elset fetch skipped: relation missing") === false);
    // Live GET /api/rpod/status 2026-10-23 02:35Z. The fetch hit the 30s
    // socket deadline and the hour was stored success / 0 events because
    // "client deadline" matched neither isTransientConnectionError nor the
    // statement-timeout regex.
    const liveDeadline =
      "latest-elset fetch skipped: latest-elset fetch exceeded 30000ms client deadline";
    check("02:35Z client-deadline skip must not be a 0-event success",
      elsetFetchFailureShouldRetryScan(liveDeadline) === true);
    check("client deadline is not an immediate same-socket retry",
      isTransientConnectionError(new Error("latest-elset fetch exceeded 30000ms client deadline")) === false);
    check("refusing the catalog-wide probe fails the hour instead of a 0-event success",
      elsetFetchFailureShouldRetryScan(
        "latest-elset fetch skipped: obc_latest_elset is missing; refusing full-catalog history probe",
      ) === true);
    // Live 2026-10-21 21:02Z: the elset fetch was skipped on a dead client and
    // the hour was logged success with 0 events. The classifier did not match
    // pg's "not queryable" text (the retry of a client that had already errored).
    const notQueryable =
      "Client has encountered a connection error and is not queryable";
    const liveNotQueryable =
      `Failed query: select id, status, kind, window_start, window_end, tca from rpod_events where rpod_events.status = $1 params: active <- ${notQueryable}`;
    check("live 22:56Z not-queryable persist error is a dead socket",
      isTransientConnectionError(new Error(liveNotQueryable)), liveNotQueryable);
    check("21:02Z elset skip on a not-queryable client must retry the scan",
      elsetFetchFailureShouldRetryScan(`latest-elset fetch skipped: ${liveNotQueryable}`));
    check("a failed lock reacquire must retry the scan",
      elsetFetchFailureShouldRetryScan("advisory lock lost after connection error and could not be reacquired"));
    let aborted = false;
    try {
      rethrowIfConnectionLost(new Error(notQueryable));
    } catch (err) {
      aborted = err instanceof Error && err.message === notQueryable;
    }
    check("a not-queryable persist error aborts the scan", aborted);
    let soft = false;
    try {
      rethrowIfConnectionLost(new Error('value "3000000000" is out of range for type integer'));
      soft = true;
    } catch {
      soft = false;
    }
    check("a bad event row stays a soft persist error", soft);
    check("doScan throws on a retryable elset fetch so the hour is not a 0-event success",
      /elsetFetchFailureShouldRetryScan\(loaded\.warning\)\)[\s\S]{0,300}throw new Error\(loaded\.warning\)/.test(scanSrc));
    check("doScan still logs success for a non-timeout elset skip",
      /if \(loaded\.warning\)[\s\S]{0,700}logScanRow\(\s*"success"/.test(scanSrc));
  }

  console.log("pg-pool handshake abort is retried once (live 2026-10-14)");
  {
    // Verbatim lastScanError from GET /api/rpod/status ~15:10Z. pg-pool 3.13
    // Pool.newClient wraps the socket-end error only when connectionTimeoutMillis
    // destroys a handshake that never became a query — so Drizzle never prefixes
    // "Failed query:".
    const cause = new Error("Connection terminated unexpectedly");
    const live = new Error("Connection terminated due to connection timeout", { cause });
    const formatted = formatDbError(live);
    check(
      "formatDbError reproduces the live lastScanError string",
      formatted === "Connection terminated due to connection timeout <- Connection terminated unexpectedly",
      formatted,
    );
    check("live handshake abort is a transient connection error", isTransientConnectionError(live));
    check(
      "pool-full checkout timeout is transient",
      isTransientConnectionError(new Error("timeout exceeded when trying to connect")),
    );
    const statement = new Error("canceling statement due to statement timeout");
    (statement as Error & { code: string }).code = "57014";
    check("statement timeout is not a transient connection error", isTransientConnectionError(statement) === false);
    check(
      "scan deadline is not a transient connection error",
      isTransientConnectionError(new Error("rpod-scan timed out after 1500000ms")) === false,
    );
    check(
      "retry delay is one second (one extra handshake, not another hour)",
      DB_CONNECT_RETRY_DELAY_MS === 1_000,
    );

    let calls = 0;
    const recovered = await retryOnceOnTransient("test", async () => {
      calls++;
      if (calls === 1) throw live;
      return "ok";
    }, 0);
    check("one transient failure then success returns the value", recovered === "ok" && calls === 2, String(calls));

    let hardCalls = 0;
    let hardThrew = false;
    try {
      await retryOnceOnTransient("test", async () => {
        hardCalls++;
        throw statement;
      }, 0);
    } catch (err) {
      hardThrew = err === statement;
    }
    check("statement timeout is not retried", hardThrew && hardCalls === 1, String(hardCalls));

    let bothCalls = 0;
    let bothThrew = false;
    try {
      await retryOnceOnTransient("test", async () => {
        bothCalls++;
        throw live;
      }, 0);
    } catch (err) {
      bothThrew = err === live;
    }
    check("a second handshake abort still throws", bothThrew && bothCalls === 2, String(bothCalls));

    let fetchCalls = 0;
    const retried = await getLatestElsetsOrSkip(0, 1, async () => {
      fetchCalls++;
      if (fetchCalls === 1) throw live;
      return [];
    });
    check("latest-elset fetch retries a handshake abort once", fetchCalls === 2, String(fetchCalls));
    check("recovered latest-elset fetch is not a skip warning", retried.warning === null && retried.rows.length === 0);

    const tleSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/obc/tleArchive.ts"), "utf8");
    const scanSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/rpod/scan.ts"), "utf8");
    const storeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/obc/store.ts"), "utf8");
    check(
      "advisory-lock checkout retries pool.connect once",
      /retryOnceOnTransient\(`\$\{label\} connect`, \(\) => pool\.connect\(\)\)/.test(tleSrc),
    );
    check(
      "scan queries reuse the advisory-lock client",
      /runWithDbClient\(client/.test(scanSrc),
    );
    check(
      "a dead lock socket is replaced before the next query",
      /connectReplacementClient\(label\)/.test(tleSrc)
        && /ensureAdvisoryLockClient\(/.test(tleSrc)
        && /rebindDbClient\(/.test(tleSrc),
    );
    check(
      "latest-elset read does not release a borrowed scan client",
      /const borrowed = currentPoolClient\(\)/.test(tleSrc) && /if \(!borrowed\)/.test(tleSrc),
    );
    const livePersist = new Error(
      'Failed query: select "id", "status", "kind" from "rpod_events" where "rpod_events"."status" = $1\nparams: active',
    );
    livePersist.cause = live;
    check(
      "2026-10-21 drizzle-wrapped persist handshake abort is transient",
      isTransientConnectionError(livePersist),
      formatDbError(livePersist),
    );
    check(
      "latest-elset loader retries the fetch once before skipping",
      /retryOnceOnTransient\("latest-elset fetch"/.test(tleSrc),
    );
    check(
      "persist retries the active-events read",
      scanSrc.includes('retryOnceOnTransient("rpod active events"'),
    );
    check(
      "persist does not retry the per-event write transaction",
      !/retryOnceOnTransient\([\s\S]{0,80}db\.transaction/.test(scanSrc),
    );
    check(
      "satcat metadata load retries the catalog read",
      storeSrc.includes('retryOnceOnTransient("satcat metadata"'),
    );
  }

  console.log("sync-log insert and freshness read survive a connect flap, then surface a hard error");
  {
    const NO_DELAY = [0, 0, 0, 0] as const;
    const startedAt = new Date("2026-10-14T16:40:00.000Z");
    // Verbatim lastScanError class. Drizzle wraps the driver error, so the
    // insert/select path must follow `cause` — err.message alone is "Failed query".
    const cause = new Error("Connection terminated unexpectedly");
    const live = new Error("Connection terminated due to connection timeout", { cause });
    const wrapped = new Error(
      'Failed query: insert into "obc_sync_log" ("source", "status", "row_count", "error", "started_at") values ($1, $2, $3, $4, $5)',
    );
    wrapped.cause = live;
    check(
      "drizzle-wrapped handshake abort still formats as the live lastScanError class",
      formatDbError(wrapped).includes("Connection terminated due to connection timeout <- Connection terminated unexpectedly"),
      formatDbError(wrapped),
    );
    check("drizzle-wrapped handshake abort is transient", isTransientConnectionError(wrapped));

    const admin = new Error("terminating connection due to administrator command");
    (admin as Error & { code: string }).code = "57P01";
    const wrappedAdmin = new Error('Failed query: select "finished_at" from "obc_sync_log"');
    wrappedAdmin.cause = admin;
    check("SQLSTATE 57P01 admin shutdown is a transient connection error", isTransientConnectionError(admin));
    check("drizzle-wrapped 57P01 is a transient connection error", isTransientConnectionError(wrappedAdmin));
    const statement = new Error("canceling statement due to statement timeout");
    (statement as Error & { code: string }).code = "57014";
    check("statement timeout stays non-transient under the multi-attempt helper", isTransientConnectionError(statement) === false);

    const backoffMs = DB_CONNECT_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    const worstCaseMs = DB_CONNECT_RETRY_ATTEMPTS * 10_000 + backoffMs;
    check(
      "sync-log retries are more than the one-shot 1s gap",
      DB_CONNECT_RETRY_ATTEMPTS >= 4 && backoffMs > DB_CONNECT_RETRY_DELAY_MS,
      `attempts=${DB_CONNECT_RETRY_ATTEMPTS} backoff=${backoffMs}`,
    );
    check(
      "exhausted connect retries still finish inside one freshness check",
      DB_CONNECT_RETRY_ATTEMPTS <= 6 && worstCaseMs < RPOD_SCAN_CHECK_INTERVAL_MS,
      `worst=${worstCaseMs} check=${RPOD_SCAN_CHECK_INTERVAL_MS}`,
    );
    check(
      "one delay slot per retry after the first attempt",
      DB_CONNECT_RETRY_DELAYS_MS.length === DB_CONNECT_RETRY_ATTEMPTS - 1,
    );

    let insertCalls = 0;
    let stored: { source?: string; status?: string; error?: string | null; rowCount?: number | null } | undefined;
    await insertRpodScanSyncLog(
      { status: "error", startedAt, rowCount: null, error: formatDbError(live) },
      async (values) => {
        insertCalls++;
        stored = values;
        if (insertCalls < DB_CONNECT_RETRY_ATTEMPTS) throw wrapped;
      },
      NO_DELAY,
    );
    check(
      "error sync-log insert retries the live handshake abort then writes",
      insertCalls === DB_CONNECT_RETRY_ATTEMPTS && stored?.source === "rpod-scan" && stored?.status === "error",
      `calls=${insertCalls} row=${JSON.stringify(stored)}`,
    );
    check(
      "sync-log insert keeps the live error string",
      stored?.error === "Connection terminated due to connection timeout <- Connection terminated unexpectedly",
      stored?.error ?? "",
    );

    const longError = "e".repeat(2500);
    let sliced: string | null = "unset";
    await insertRpodScanSyncLog(
      { status: "success", startedAt, rowCount: 4, error: longError },
      async (values) => { sliced = values.error; },
      NO_DELAY,
    );
    check("success sync-log insert still caps error at 2000 chars", sliced?.length === 2000, String(sliced?.length));

    let exhaustCalls = 0;
    let exhausted: unknown;
    try {
      await insertRpodScanSyncLog(
        { status: "success", startedAt, rowCount: 4, error: null },
        async () => {
          exhaustCalls++;
          throw wrapped;
        },
        NO_DELAY,
      );
    } catch (err) {
      exhausted = err;
    }
    check(
      "success sync-log insert throws the live handshake abort after retries are exhausted",
      exhausted === wrapped && exhaustCalls === DB_CONNECT_RETRY_ATTEMPTS,
      `calls=${exhaustCalls} err=${String(exhausted)}`,
    );

    let hardCalls = 0;
    let hardErr: unknown;
    try {
      await insertRpodScanSyncLog(
        { status: "error", startedAt, rowCount: null, error: "plan" },
        async () => {
          hardCalls++;
          throw statement;
        },
        NO_DELAY,
      );
    } catch (err) {
      hardErr = err;
    }
    check("sync-log insert does not retry a statement timeout", hardErr === statement && hardCalls === 1, String(hardCalls));

    const finished = new Date("2026-10-14T16:41:02.000Z");
    let readCalls = 0;
    const recoveredMs = await latestRpodScanFinishedAtMs(async () => {
      readCalls++;
      if (readCalls < 3) throw wrapped;
      return [{ finishedAt: finished }];
    }, NO_DELAY);
    check(
      "freshness read retries the live handshake abort then returns finishedAt",
      recoveredMs === finished.getTime() && readCalls === 3,
      `calls=${readCalls} ms=${recoveredMs}`,
    );

    let adminCalls = 0;
    const adminMs = await latestRpodScanFinishedAtMs(async () => {
      adminCalls++;
      if (adminCalls === 1) throw wrappedAdmin;
      return [{ finishedAt: finished }];
    }, NO_DELAY);
    check(
      "freshness read retries SQLSTATE 57P01 once the socket is dropped",
      adminMs === finished.getTime() && adminCalls === 2,
      `calls=${adminCalls}`,
    );

    let freshExhaust = 0;
    let freshErr: unknown;
    try {
      await latestRpodScanFinishedAtMs(async () => {
        freshExhaust++;
        throw wrapped;
      }, NO_DELAY);
    } catch (err) {
      freshErr = err;
    }
    check(
      "freshness read throws the live handshake abort after retries are exhausted",
      freshErr === wrapped && freshExhaust === DB_CONNECT_RETRY_ATTEMPTS,
      `calls=${freshExhaust}`,
    );

    let emptyCalls = 0;
    const missing = await latestRpodScanFinishedAtMs(async () => {
      emptyCalls++;
      return [];
    }, NO_DELAY);
    check("freshness read treats no row as null without retrying", missing === null && emptyCalls === 1, String(emptyCalls));

    let stmtCalls = 0;
    let stmtErr: unknown;
    try {
      await latestRpodScanFinishedAtMs(async () => {
        stmtCalls++;
        throw statement;
      }, NO_DELAY);
    } catch (err) {
      stmtErr = err;
    }
    check("freshness read does not retry a statement timeout", stmtErr === statement && stmtCalls === 1, String(stmtCalls));

    let backoffCalls = 0;
    const backoffStarted = Date.now();
    await retryTransientConnection("backoff", async () => {
      backoffCalls++;
      if (backoffCalls < 3) throw live;
      return "ok";
    }, 3, [25, 25]);
    check(
      "transient retries actually wait out the backoff",
      backoffCalls === 3 && Date.now() - backoffStarted >= 40,
      `calls=${backoffCalls} elapsed=${Date.now() - backoffStarted}`,
    );

    const here = dirname(fileURLToPath(import.meta.url));
    const scanSrc = readFileSync(join(here, "../lib/rpod/scan.ts"), "utf8");
    const schedSrc = readFileSync(join(here, "../lib/obc/scheduler.ts"), "utf8");
    const statusSrc = readFileSync(join(here, "../routes/rpod.ts"), "utf8");
    const dbSrc = readFileSync(join(here, "../../../../lib/db/src/index.ts"), "utf8");
    const logStart = scanSrc.indexOf("async function logScanRow");
    const logEnd = scanSrc.indexOf("export interface PersistResult");
    const logBody = logStart >= 0 && logEnd > logStart ? scanSrc.slice(logStart, logEnd) : "";
    check("logScanRow writes through the retrying sync-log insert", logBody.includes("insertRpodScanSyncLog("));
    check("logScanRow does not swallow the insert error", !/\bcatch\b/.test(logBody), logBody.slice(0, 240));
    check(
      "logScanRow keeps the production backoff (no zero-delay override)",
      /insertRpodScanSyncLog\(\{ status, startedAt, rowCount, error: error \?\? null \}\)/.test(logBody),
    );
    const dueStart = schedSrc.indexOf("async function runRpodScanIfDue");
    const dueEnd = schedSrc.indexOf("async function runRpodScanWithRetry");
    const dueBody = dueStart >= 0 && dueEnd > dueStart ? schedSrc.slice(dueStart, dueEnd) : "";
    check(
      "runRpodScanIfDue reads freshness without swallowing a hard error",
      /const last = await latestRpodScanFinishedAtMs\(\);/.test(dueBody)
        && !/latestRpodScanFinishedAtMs\(\)\.catch/.test(dueBody)
        && !/try\s*\{[^}]*latestRpodScanFinishedAtMs/.test(dueBody),
    );
    check(
      "GET /rpod/status retries the scan-log read",
      /retryTransientConnection\(\s*"rpod status"/.test(statusSrc),
    );
    check(
      "pool connectionTimeoutMillis stays a 10s handshake cap",
      /connectionTimeoutMillis:\s*10_000/.test(dbSrc),
    );
  }

  console.log("latest-elset client deadline destroys a hung socket");
  {
    check(
      "statement_timeout cancels a bad plan before it wedges the host",
      LATEST_ELSETS_STATEMENT_TIMEOUT_MS >= 10_000 && LATEST_ELSETS_STATEMENT_TIMEOUT_MS <= 30_000,
      String(LATEST_ELSETS_STATEMENT_TIMEOUT_MS),
    );
    check(
      "client deadline is after statement_timeout so a live server can cancel cleanly",
      LATEST_ELSETS_CLIENT_TIMEOUT_MS > LATEST_ELSETS_STATEMENT_TIMEOUT_MS,
      String(LATEST_ELSETS_CLIENT_TIMEOUT_MS),
    );
    check(
      "client deadline is well under the 25m scan cap",
      LATEST_ELSETS_CLIENT_TIMEOUT_MS * 5 < MAX_RPOD_SCAN_MS,
      `client ${LATEST_ELSETS_CLIENT_TIMEOUT_MS} scan ${MAX_RPOD_SCAN_MS}`,
    );
    check(
      "connect-timeout and socket-death errors discard the pooled client",
      latestElsetClientIsDead(new Error("Connection terminated due to connection timeout"))
        && latestElsetClientIsDead(new Error("Connection terminated unexpectedly"))
        && latestElsetClientIsDead(new Error("latest-elset fetch exceeded 150000ms client deadline"))
        && latestElsetClientIsDead(new Error("Client has encountered a connection error and is not queryable")),
    );
    check(
      "a clean statement timeout keeps the pooled client",
      latestElsetClientIsDead(new Error("canceling statement due to statement timeout")) === false,
    );

    let destroyed: Error | undefined;
    const hung = attachLatestElsetClientDeadline({
      connection: { stream: { destroy: (err?: Error) => { destroyed = err; } } },
    }, 40);
    await new Promise((r) => setTimeout(r, 80));
    check("deadline destroys the socket", destroyed instanceof Error && /client deadline/.test(destroyed.message), String(destroyed));
    check("deadline promise rejects", await hung.promise.then(() => false, () => true));

    let destroyedLate = false;
    const armed = attachLatestElsetClientDeadline({
      connection: { stream: { destroy: () => { destroyedLate = true; } } },
    }, 40);
    armed.cancel();
    await new Promise((r) => setTimeout(r, 80));
    check("cancel disarms the socket destroy", destroyedLate === false);
  }

  if (!(await dbReachable())) {
    console.log("Skipping persist/status DB checks (DATABASE_URL not reachable)");
    if (failures > 0) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nAll RPOD scan-resilience checks passed");
    return;
  }

  console.log("future-dated history seek plan does not walk the epoch index");
  {
    const client = await pool.connect();
    try {
      const present = await client.query(
        "SELECT to_regclass('obc_tle_history') AS history, to_regclass('obc_latest_elset') AS pointer",
      );
      const row = present.rows[0] as { history: string | null; pointer: string | null };
      if (!row?.history || !row?.pointer) {
        console.log("  (skipping plan check; obc_tle_history or obc_latest_elset is absent)");
      } else {
        const since = new Date("2026-10-20T02:35:00.000Z");
        const until = new Date("2026-10-23T08:35:00.000Z");
        const dialect = new PgDialect();
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        await client.query("SET LOCAL enable_hashjoin = off");
        await client.query("SET LOCAL enable_mergejoin = off");
        await client.query("SET LOCAL enable_bitmapscan = off");
        await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
        const future = dialect.sqlToQuery(latestElsetsFutureSql(since, until));
        const futurePlan = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN ${future.sql}`,
          future.params,
        );
        const futureText = futurePlan.rows.map((r) => r["QUERY PLAN"]).join("\n");
        check(
          "future seek plan uses a norad-leading history index",
          /obc_tle_history_norad/.test(futureText) && !/obc_tle_history_epoch_idx/.test(futureText),
          futureText.slice(0, 700),
        );
        // The future statement turned seq/hash/merge scans off. The in-window
        // read is a different statement: index and bitmap scans off, sequential
        // scan left on (see queryLatestElsetRows).
        await client.query("SET LOCAL enable_seqscan = on");
        await client.query("SET LOCAL enable_hashjoin = on");
        await client.query("SET LOCAL enable_mergejoin = on");
        await client.query("SET LOCAL enable_indexscan = off");
        await client.query("SET LOCAL enable_bitmapscan = off");
        const inWindow = dialect.sqlToQuery(latestElsetsInWindowSql(since, until));
        const windowPlan = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN ${inWindow.sql}`,
          inWindow.params,
        );
        const windowText = windowPlan.rows.map((r) => r["QUERY PLAN"]).join("\n");
        check(
          "in-window plan sequential-scans the pointer",
          /Seq Scan on obc_latest_elset/.test(windowText) && !/Index Scan[^\n]*obc_latest_elset/.test(windowText),
          windowText.slice(0, 500),
        );
        await client.query("ROLLBACK");
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      check("latest-elset plan check ran", false, String(err).slice(0, 300));
    } finally {
      client.release();
    }
  }

  const nowMs = Date.now();
  const cleanupIds: number[] = [];
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("no ephemeral port");
  const base = `http://127.0.0.1:${addr.port}/api`;

  try {
    console.log("persistEvents: one bad event must not abort the rest");
    {
      let threw = false;
      let result: Awaited<ReturnType<typeof persistEvents>> | null = null;
      try {
        result = await persistEvents(
          [makeCluster(OVERFLOW_PAIR, nowMs), makeCluster(GOOD_PAIR, nowMs)],
          "conjunction",
        );
      } catch (err) {
        threw = true;
        check("persistEvents did not throw on one bad event", false, String(err));
      }
      check("persistEvents did not throw on one bad event", !threw);
      check("bad event is recorded in errors (not silent)", (result?.errors.length ?? 0) >= 1,
        JSON.stringify(result?.errors));
      check("good event still inserted", result?.inserted.length === 1,
        JSON.stringify(result?.inserted));
      if (result?.inserted[0]) cleanupIds.push(result.inserted[0].eventId);
      if (result?.inserted[0]) {
        const members = await db.select().from(rpodEventMembers)
          .where(eq(rpodEventMembers.eventId, result.inserted[0].eventId));
        check("good event kept both members", members.length === 2, JSON.stringify(members.map((m) => m.norad)));
      }
    }

    console.log("GET /rpod/status is fast and returns lastScanError");
    {
      clearArchiveStatusCache();
      const t0 = Date.now();
      const archive = await getArchiveStatus();
      const archiveMs = Date.now() - t0;
      check("getArchiveStatus returns in <8s (no 5M-row seq scan)", archiveMs < 8_000, `took ${archiveMs}ms`);
      check("archive status has numeric counts", Number.isFinite(archive.totalRows) && Number.isFinite(archive.objects));
      check("newestEpoch is ISO or null", archive.newestEpoch == null || !Number.isNaN(Date.parse(archive.newestEpoch)));

      const t1 = Date.now();
      const res = await fetch(`${base}/rpod/status`);
      const statusMs = Date.now() - t1;
      check("GET /rpod/status responds 200", res.ok, String(res.status));
      check("GET /rpod/status returns in <8s", statusMs < 8_000, `took ${statusMs}ms`);
      const body = (await res.json()) as {
        archive: { totalRows: number; newestEpoch: string | null };
        activeEvents: number;
        lastScanAt: string | null;
        lastScanStatus: string | null;
        lastScanEvents: number | null;
        lastScanError: string | null;
      };
      check("status payload includes lastScanError key", "lastScanError" in body);
      check("lastScanError is string or null", body.lastScanError === null || typeof body.lastScanError === "string");
      check("activeEvents is a number", Number.isFinite(body.activeEvents));
    }
  } finally {
    if (cleanupIds.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, cleanupIds));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll RPOD scan-resilience checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
