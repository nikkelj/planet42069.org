import { currentPoolClient, db, poolDb, runWithDbClient } from "@workspace/db";
import { rpodEvents, rpodEventMembers, obcSyncLog } from "@workspace/db/schema";
import { sql, eq, and, inArray, lt, desc } from "drizzle-orm";
import { logger } from "../logger";
import { getLatestElsetsOrSkip, formatDbError, withAdvisoryLock, LOCK_RPOD_SCAN, ELSET_FUTURE_SLACK_MS, retryOnceOnTransient, retryTransientConnection, isTransientConnectionError, ensureAdvisoryLockClient, DB_CONNECT_RETRY_ATTEMPTS, DB_CONNECT_RETRY_DELAYS_MS, type LatestElset } from "../obc/tleArchive";
import { getSatcatFromStore } from "../obc/store";
import { MAX_RPOD_SCAN_MS, RPOD_ALERT_TIMEOUT_MS, withDeadline, cancelScanAttempt, markScanLogged, sgp4ShouldStop } from "./scanPolicy";
import {
  screenCandidatePairs, screenCoAlignedPairs, closeApproach, clusterPairs,
  DEFAULT_SCREEN, DEFAULT_COALIGNED, RPOD_MAX_RANGE_KM, RPOD_MAX_RELVEL_KM_S,
  COALIGNED_MAX_RANGE_KM, COALIGNED_MAX_RELVEL_KM_S, semiMajorAxisKm, minPhaseDiffDeg,
  hasUsableTleLines, tleEpochIsCurrent, yieldToEventLoop, SCREEN_YIELD_EVERY,
  alongTrackRulesOutRange,
  type ScreenElset, type FlaggedPair, type ScreenOptions,
} from "./screen";
import { selectEndedCoplanarIds, selectReopenCandidate, selectUnseenConjunctionIds, COPLANAR_REOPEN_WINDOW_MS, CONJUNCTION_REOPEN_WINDOW_MS } from "./retire";
import { isEscalation, type NewRpodEvent, type EscalatedRpodEvent } from "./alert";
import { deliverPolicyAlerts, type TrackedRpodEvent } from "./alertDispatch";
import { designatorFromTleLine1 } from "../obc/designator";
import { forceOf, type Force } from "./force";
import { mayLabelDocked } from "./alertPolicy";
import { isSuspectedCrossTag, type ElsetSnap } from "./maneuver";
import {
  DOCKED_MAX_RANGE_KM, DOCKED_MAX_RELVEL_KM_S, isDockedGeometry,
  isProvenSamePair, prioritizeSgp4Pairs, selectInterestingEvents,
  type InterestCatalogMeta,
} from "./interest";

export {
  rpodScanIsDue, RPOD_SCAN_INTERVAL_MS, RPOD_SCAN_CHECK_INTERVAL_MS, RPOD_SCAN_BOOT_DELAY_MS,
  MAX_RPOD_SCAN_MS, RPOD_ALERT_TIMEOUT_MS, RPOD_POST_SGP4_RESERVE_MS, sgp4ShouldStop,
  withDeadline, cancelScanAttempt, markScanLogged,
} from "./scanPolicy";
export { DOCKED_MAX_RANGE_KM, DOCKED_MAX_RELVEL_KM_S, isDockedGeometry };

/**
 * RPOD scan orchestrator: pulls the latest archived elsets, runs the
 * screen → SGP4-diff → cluster pipeline, and upserts flagged events.
 *
 * Guardrails for catalog-scale runs:
 *  - only elsets fresher than ELSET_MAX_AGE feed the scan
 *  - same-launch pairs younger than DEPLOY_QUIET_DAYS are skipped
 *    (deployment dispersion is not proximity OPERATIONS)
 *  - SGP4 differencing is capped at MAX_SGP4_PAIRS per run; mixed-force
 *    pairs take the budget first, then tightest same-operator planes
 *  - same-plane pairs whose along-track phase cannot enter the range
 *    bubble are dropped before that budget (a Starlink plane otherwise
 *    fills it with approaches that are still thousands of km apart)
 *  - stage-2 stops RPOD_POST_SGP4_RESERVE_MS before the hard cap so a
 *    long hour still persists what it found instead of logging a timeout
 *  - persist only interesting events (red paired with blue or neutral,
 *    exercise-flagged blue-on-blue, messy clusters, ultra-close
 *    near-misses) — see interest.ts
 */

const ELSET_MAX_AGE_MS = 3 * 86400_000;
const DEPLOY_QUIET_DAYS = 60;
const MAX_SGP4_PAIRS = 1200;
/** Separate SGP4 budget for the co-aligned (coplanar shadowing) screen. */
const MAX_COALIGNED_SGP4_PAIRS = 1200;
/** Coplanar events merge on a wider window — they evolve over days, not hours. */
const COALIGNED_MERGE_WINDOW_MS = 24 * 3600_000;
const MEMBER_CAP = 5;
/** Events whose window ended this long ago get marked stale. */
const STALE_AFTER_MS = 3 * 86400_000;

let scanInFlight: Promise<void> | null = null;

export function runRpodScan(): Promise<void> {
  if (scanInFlight) return scanInFlight;
  const started = new Date();
  const abort: ScanAbort = { cancelled: false, logged: false };
  scanInFlight = (async () => {
    try {
      await withAdvisoryLock(LOCK_RPOD_SCAN, "rpod-scan", async (client) => {
        // Persist used to dial a new pool client after SGP4. Idle clients
        // are gone by then (60s idle timeout), and that handshake is what
        // pg-pool aborts as "Connection terminated due to connection timeout".
        await runWithDbClient(client, async () => {
          const deadlineMs = Date.now() + MAX_RPOD_SCAN_MS;
          try {
            await withDeadline(doScan(deadlineMs, abort), MAX_RPOD_SCAN_MS, "rpod-scan");
          } catch (err) {
            // withDeadline does not cancel doScan. Set cancelled so a late inner
            // return cannot insert a second row after the lock is released — but
            // still write one row here, or lastScanAt stays on the previous success.
            if (cancelScanAttempt(abort)) {
              await logScanRow("error", started, null, formatDbError(err), abort, true).catch((logErr) => {
                logger.error({ err: logErr }, "rpod-scan: failed to write sync log");
              });
            }
            throw err;
          }
        });
      });
    } catch (err) {
      // Lock checkout can fail before doScan (pool connect). That attempt
      // started; leave a row so lastScanAt cannot sit on the previous success.
      if (cancelScanAttempt(abort)) {
        await logScanRow("error", started, null, formatDbError(err), abort, true).catch((logErr) => {
          logger.error({ err: logErr }, "rpod-scan: failed to write sync log");
        });
      }
      throw err;
    }
  })().finally(() => { scanInFlight = null; });
  return scanInFlight;
}

export interface RpodScanSyncLogRow {
  status: "success" | "error";
  startedAt: Date;
  rowCount: number | null;
  error: string | null;
}

/**
 * Insert one rpod-scan sync-log row, retrying the live handshake-abort class.
 * The final failure throws — a brief flap must not look like a successful write,
 * or lastScanAt stays on the previous row for hours. A commit whose response
 * was lost can leave a second adjacent row; status reads the newest finishedAt.
 */
export async function insertRpodScanSyncLog(
  row: RpodScanSyncLogRow,
  insert: (values: RpodScanSyncLogRow & { source: "rpod-scan" }) => Promise<unknown> = async (values) => {
    try {
      await db.insert(obcSyncLog).values(values);
    } catch (err) {
      // The scan client can be dead after a socket destroy. Record the row
      // on the shared pool so lastScanAt still moves.
      if (currentPoolClient() == null || !isTransientConnectionError(err)) throw err;
      await poolDb.insert(obcSyncLog).values(values);
    }
  },
  delaysMs: readonly number[] = DB_CONNECT_RETRY_DELAYS_MS,
): Promise<void> {
  const error = row.error == null ? null : row.error.slice(0, 2000);
  await retryTransientConnection(
    "rpod-scan sync log",
    () => insert({ ...row, source: "rpod-scan", error }),
    DB_CONNECT_RETRY_ATTEMPTS,
    delaysMs,
  );
}

/**
 * Latest rpod-scan sync-log finishedAt, or null if none. Cheap LIMIT 1.
 * Transient connect errors are retried; a hard failure after that still throws
 * so the scheduler tick can log it and try again next interval.
 */
export async function latestRpodScanFinishedAtMs(
  read: () => Promise<Array<{ finishedAt: Date | null }>> = async () =>
    db
      .select({ finishedAt: obcSyncLog.finishedAt })
      .from(obcSyncLog)
      .where(eq(obcSyncLog.source, "rpod-scan"))
      .orderBy(desc(obcSyncLog.finishedAt))
      .limit(1),
  delaysMs: readonly number[] = DB_CONNECT_RETRY_DELAYS_MS,
): Promise<number | null> {
  const [row] = await retryTransientConnection(
    "rpod-scan freshness",
    read,
    DB_CONNECT_RETRY_ATTEMPTS,
    delaysMs,
  );
  const t = row?.finishedAt?.getTime();
  return t != null && Number.isFinite(t) ? t : null;
}

function throwIfScanDeadline(deadlineMs: number, where: string, abort?: ScanAbort): void {
  if (abort?.cancelled) throw new Error(`rpod-scan cancelled ${where}`);
  if (Date.now() > deadlineMs) throw new Error(`rpod-scan timed out ${where}`);
}

type ScanAbort = { cancelled: boolean; logged: boolean };

interface CatalogMeta extends InterestCatalogMeta {
  launchTag: string | null;
  ldate: string | null;
  opOrbit: string | null;
}

/** Both objects are active payloads (shadowing needs two spacecraft, not debris/stages). */
function isPayloadPair(a: number, b: number, meta: Map<number, CatalogMeta>): boolean {
  return meta.get(a)?.objectClass === "P" && meta.get(b)?.objectClass === "P";
}

/** Same launch, any age — co-launched formations are routine, not RPOD. */
function isSameLaunch(a: number, b: number, meta: Map<number, CatalogMeta>): boolean {
  const la = meta.get(a)?.launchTag;
  const lb = meta.get(b)?.launchTag;
  return la != null && lb != null && la === lb;
}

async function loadCatalogMeta(): Promise<Map<number, CatalogMeta>> {
  const map = new Map<number, CatalogMeta>();
  try {
    const entries = await getSatcatFromStore();
    const launchStateByTag = new Map<string, string>();
    for (const e of entries) {
      if (!e.launchTag || !e.state || e.objectClass !== "P") continue;
      if (!launchStateByTag.has(e.launchTag)) launchStateByTag.set(e.launchTag, e.state);
    }
    for (const e of entries) {
      if (e.satno != null) {
        map.set(e.satno, {
          launchTag: e.launchTag ?? null,
          ldate: e.ldate,
          opOrbit: e.opOrbit ?? null,
          name: e.name ?? e.plName ?? null,
          objectClass: e.objectClass ?? null,
          owner: e.owner ?? null,
          state: e.state ?? null,
          gunterOperator: e.gunterOperator ?? null,
          gunterNation: e.gunterNation ?? null,
          launchState: e.launchTag ? launchStateByTag.get(e.launchTag) ?? null : null,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "rpod-scan: catalog meta unavailable, proceeding without launch filtering");
  }
  return map;
}

function toScreenElset(e: LatestElset): ScreenElset {
  return {
    norad: e.norad,
    epochMs: new Date(e.epoch).getTime(),
    line1: e.line1,
    line2: e.line2,
    incDeg: e.incDeg,
    raanDeg: e.raanDeg,
    eccentricity: e.eccentricity,
    meanMotionRevPerDay: e.meanMotionRevPerDay,
  };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function isSameFreshLaunch(a: number, b: number, meta: Map<number, CatalogMeta>, nowMs: number): boolean {
  const ma = meta.get(a);
  const mb = meta.get(b);
  if (!ma?.launchTag || !mb?.launchTag || ma.launchTag !== mb.launchTag) return false;
  const t = ma.ldate ? Date.parse(ma.ldate) : NaN;
  return Number.isFinite(t) && nowMs - t < DEPLOY_QUIET_DAYS * 86400_000;
}

/** Let HTTP (e.g. GET /rpod/status) run between sync SGP4 pair diffs. */
async function sgp4FlagPairs(
  pairs: { a: ScreenElset; b: ScreenElset }[],
  nowMs: number,
  maxRangeKm: number,
  maxRelVelKmS: number,
  deadlineMs: number,
  abort?: ScanAbort,
  truncated?: { current: boolean },
): Promise<FlaggedPair[]> {
  const flagged: FlaggedPair[] = [];
  for (let i = 0; i < pairs.length; i++) {
    throwIfScanDeadline(deadlineMs, "during SGP4", abort);
    // Leave the reserve for cluster / persist / alerts / retire. Stopping
    // here keeps pairs already flagged; the hard cap would discard them.
    if (sgp4ShouldStop(Date.now(), deadlineMs)) {
      if (truncated) truncated.current = true;
      logger.warn({ done: i, total: pairs.length }, "rpod-scan: stopping SGP4 to leave time for persist");
      break;
    }
    const { a, b } = pairs[i];
    try {
      const ca = closeApproach(a, b, nowMs, DEFAULT_SCREEN.windowMs);
      if (ca && ca.minRangeKm <= maxRangeKm && ca.relVelKmS <= maxRelVelKmS) {
        flagged.push({ a: a.norad, b: b.norad, minRangeKm: ca.minRangeKm, relVelKmS: ca.relVelKmS, tcaMs: ca.tcaMs });
      }
    } catch (err) {
      logger.warn({ err: String(err), a: a.norad, b: b.norad }, "rpod-scan: closeApproach skipped pair");
    }
    await yieldToEventLoop();
  }
  return flagged;
}

const CONJ_PHASE_SLACK_DEG = DEFAULT_SCREEN.maxRaanDiffDeg + DEFAULT_SCREEN.maxIncDiffDeg;
const COALIGNED_PHASE_SLACK_DEG = DEFAULT_COALIGNED.maxRaanDiffDeg + DEFAULT_COALIGNED.maxIncDiffDeg;

/**
 * Connection loss and statement/read timeouts mean the hour did not screen.
 * Logging success with 0 events used to consume the hour (live 2026-10-21
 * degraded scans). Those failures should retry. An ordinary skip warning
 * ("not enough elsets") stays a success row.
 */
export function elsetFetchFailureShouldRetryScan(warning: string): boolean {
  // isTransientConnectionError covers the live "not queryable" string. A
  // statement or query-read timeout is not a dead socket, but the hour was
  // still not screened, so the scheduler must retry it too.
  if (isTransientConnectionError(warning)) return true;
  // A missing pointer table used to fall through to the catalog-wide history
  // probe. Refusing that probe must still fail the hour (so it retries)
  // rather than log success with 0 events.
  return /statement timeout|query read timeout|could not be reacquired|refusing full-catalog history probe/i.test(warning);
}

/**
 * A dead lock socket is not a bad event. Soft-skipping it logged the hour
 * as success (or burned it on one not-queryable select). Connection loss
 * and a failed lock reacquire abort the scan so the scheduler retries.
 */
export function rethrowIfConnectionLost(err: unknown): void {
  if (isTransientConnectionError(err)) throw err instanceof Error ? err : new Error(formatDbError(err));
  if (/could not be reacquired/i.test(formatDbError(err))) {
    throw err instanceof Error ? err : new Error(formatDbError(err));
  }
}

async function doScan(deadlineMs: number, abort: ScanAbort): Promise<void> {
  const started = new Date();
  const nowMs = Date.now();
  try {
    throwIfScanDeadline(deadlineMs, "before elset fetch", abort);
    const [loaded, meta] = await Promise.all([
      getLatestElsetsOrSkip(nowMs - ELSET_MAX_AGE_MS, nowMs + ELSET_FUTURE_SLACK_MS),
      loadCatalogMeta(),
    ]);
    if (loaded.warning) {
      if (elsetFetchFailureShouldRetryScan(loaded.warning)) {
        // A connection or statement timeout used to log success with 0
        // events, which consumed the hour. Fail so the scheduler retries.
        throw new Error(loaded.warning);
      }
      await logScanRow("success", started, 0, loaded.warning, abort);
      logger.warn({ warning: loaded.warning }, "rpod-scan: skipping hour after elset fetch failure");
      return;
    }
    const latest = loaded.rows;
    if (latest.length < 2) {
      // Must write a sync-log row: a skip with no row leaves lastScanAt on
      // the previous success, which looks like a stuck scanner.
      await logScanRow("success", started, 0, `not enough archived elsets yet (${latest.length})`, abort);
      logger.info({ elsets: latest.length }, "rpod-scan: not enough archived elsets yet, skipping");
      return;
    }
    const elsets = latest.map(toScreenElset).filter((e) =>
      hasUsableTleLines(e)
      && Number.isFinite(e.epochMs) && e.epochMs <= nowMs + ELSET_FUTURE_SLACK_MS
      && tleEpochIsCurrent(e.line1, nowMs),
    );
    if (elsets.length < 2) {
      await logScanRow("success", started, 0, `not enough usable elsets (${elsets.length} of ${latest.length} fetched)`, abort);
      logger.info({ fetched: latest.length, usable: elsets.length }, "rpod-scan: not enough usable elsets, skipping");
      return;
    }
    const byNorad = new Map(elsets.map((e) => [e.norad, e]));
    // Catalog intl_des is often null until the GCAT piece backfill. The TLE
    // line carries the same designator, which is what co-launch filtering needs.
    for (const e of elsets) {
      const tag = designatorFromTleLine1(e.line1)?.launchTag ?? null;
      if (!tag) continue;
      const m = meta.get(e.norad);
      if (m) { if (!m.launchTag) m.launchTag = tag; }
      else meta.set(e.norad, {
        launchTag: tag, ldate: null, opOrbit: null, name: null, objectClass: null,
        owner: null, state: null, gunterOperator: null, gunterNation: null, launchState: null,
      });
    }

    throwIfScanDeadline(deadlineMs, "before stage-1 screen", abort);
    // Stage 1
    const planeScore = (p: { a: ScreenElset; b: ScreenElset }) =>
      Math.abs(p.a.incDeg - p.b.incDeg) + Math.abs(p.a.meanMotionRevPerDay - p.b.meanMotionRevPerDay) * 4;
    const sgp4Truncated = { current: false };
    let candidates = (await screenCandidatePairs(elsets, DEFAULT_SCREEN, SCREEN_YIELD_EVERY, deadlineMs))
      .filter((p) => !isSameFreshLaunch(p.a.norad, p.b.norad, meta, nowMs))
      // Same-plane housekeeping never enters the 30 km bubble. Drop it
      // before the SGP4 cap so the budget is spent on pairs that can.
      .filter((p) => !alongTrackRulesOutRange(
        p.a, p.b, nowMs, DEFAULT_SCREEN.windowMs, RPOD_MAX_RANGE_KM, CONJ_PHASE_SLACK_DEG,
      ));
    // Mixed-force pairs take the SGP4 budget first so Starlink housekeeping
    // cannot crowd red-vs-blue approaches off the hour.
    if (candidates.length > MAX_SGP4_PAIRS) {
      candidates = prioritizeSgp4Pairs(candidates, meta, MAX_SGP4_PAIRS, planeScore);
    }

    // Stage 2 — yield between pairs so GET /api/rpod/status can still flush.
    const flagged = await sgp4FlagPairs(
      candidates, nowMs, RPOD_MAX_RANGE_KM, RPOD_MAX_RELVEL_KM_S, deadlineMs, abort, sgp4Truncated,
    );

    // Co-aligned (coplanar shadowing) screen: same plane + same radial shell,
    // slowly drifting in phase. The 30 km bubble rarely closes for these, so
    // they're flagged on geometry with loose range/velocity caps instead.
    throwIfScanDeadline(deadlineMs, "before co-aligned screen", abort);
    const flaggedKeys = new Set(flagged.map((f) => pairKey(f.a, f.b)));
    let coCandidates = (await screenCoAlignedPairs(elsets, DEFAULT_COALIGNED, nowMs, SCREEN_YIELD_EVERY, deadlineMs))
      .filter((p) => isPayloadPair(p.a.norad, p.b.norad, meta))
      .filter((p) => !isSameLaunch(p.a.norad, p.b.norad, meta))
      // Slow same-plane neighbor screen only. Same-constellation still
      // goes through the conjunction path for crossing / near-miss / cluster.
      .filter((p) => !isProvenSamePair(p.a.norad, p.b.norad, meta))
      .filter((p) => !flaggedKeys.has(pairKey(p.a.norad, p.b.norad)))
      .filter((p) => !alongTrackRulesOutRange(
        p.a, p.b, nowMs, DEFAULT_COALIGNED.windowMs, COALIGNED_MAX_RANGE_KM, COALIGNED_PHASE_SLACK_DEG,
      ));
    if (coCandidates.length > MAX_COALIGNED_SGP4_PAIRS) {
      // Tightest co-alignment first: plane deltas + shell separation + in-track phase.
      coCandidates = coCandidates
        .map((p) => ({
          p,
          score:
            Math.abs(p.a.incDeg - p.b.incDeg) +
            Math.abs(((p.a.raanDeg - p.b.raanDeg + 540) % 360) - 180) +
            Math.abs(semiMajorAxisKm(p.a.meanMotionRevPerDay) - semiMajorAxisKm(p.b.meanMotionRevPerDay)) / 10 +
            minPhaseDiffDeg(p.a, p.b, nowMs, DEFAULT_COALIGNED.windowMs) / DEFAULT_COALIGNED.maxPhaseDiffDeg,
        }))
        .sort((x, y) => x.score - y.score)
        .slice(0, MAX_COALIGNED_SGP4_PAIRS)
        .map((x) => x.p);
    }
    const coFlagged = await sgp4FlagPairs(
      coCandidates, nowMs, COALIGNED_MAX_RANGE_KM, COALIGNED_MAX_RELVEL_KM_S, deadlineMs, abort, sgp4Truncated,
    );

    // Stage 3 + widened scan for capped clusters
    let events = clusterPairs(flagged, MEMBER_CAP);
    for (const ev of events) {
      if (!ev.hitCap) continue;
      // Big messy event: re-screen every member against the FULL fresh-elset
      // set with relaxed plane margins so no participant is missed.
      const relaxed: ScreenOptions = { ...DEFAULT_SCREEN, maxIncDiffDeg: 1.2, maxRaanDiffDeg: 3, maxMeanMotionDiff: 0.8 };
      const memberSet = new Set(ev.members);
      const neighborhood = elsets.filter((e) => {
        if (memberSet.has(e.norad)) return true;
        return ev.members.some((m) => {
          const me = byNorad.get(m);
          return me != null &&
            Math.abs(me.incDeg - e.incDeg) <= relaxed.maxIncDiffDeg &&
            Math.abs(me.meanMotionRevPerDay - e.meanMotionRevPerDay) <= relaxed.maxMeanMotionDiff;
        });
      });
      const flaggedKeys = new Set(flagged.map((f) => pairKey(f.a, f.b)));
      const wideSlack = relaxed.maxRaanDiffDeg + relaxed.maxIncDiffDeg;
      // Anchor on the event members. Screening the whole neighborhood
      // all-pairs the shell (and any high-e elset in it) for a 5-craft cluster.
      const widePairs = (await screenCandidatePairs(neighborhood, relaxed, SCREEN_YIELD_EVERY, deadlineMs, memberSet))
        .filter((p) => memberSet.has(p.a.norad) || memberSet.has(p.b.norad))
        .filter((p) => !isSameFreshLaunch(p.a.norad, p.b.norad, meta, nowMs))
        .filter((p) => !flaggedKeys.has(pairKey(p.a.norad, p.b.norad)))
        .filter((p) => !alongTrackRulesOutRange(
          p.a, p.b, nowMs, relaxed.windowMs, RPOD_MAX_RANGE_KM, wideSlack,
        ))
        .slice(0, 400);
      flagged.push(...await sgp4FlagPairs(
        widePairs, nowMs, RPOD_MAX_RANGE_KM, RPOD_MAX_RELVEL_KM_S, deadlineMs, abort, sgp4Truncated,
      ));
      // Re-cluster once after all widened pairs are in.
      events = clusterPairs(flagged, MEMBER_CAP);
      break;
    }

    const coEvents = clusterPairs(coFlagged, MEMBER_CAP, COALIGNED_MERGE_WINDOW_MS);

    // Persist only interesting encounters. Boring same-operator routine
    // RPOD must not land in rpod_events or on the public board.
    const conjKept = selectInterestingEvents(events, meta);
    const coKept = selectInterestingEvents(coEvents, meta);
    const interestStats = {
      conjunction: conjKept.stats,
      coplanar: coKept.stats,
    };

    throwIfScanDeadline(deadlineMs, "before persist", abort);
    const crossTagPairs = new Set<string>();
    for (const p of [...flagged, ...coFlagged]) {
      const a = byNorad.get(p.a);
      const b = byNorad.get(p.b);
      if (a && b && isSuspectedCrossTag(a, b)) crossTagPairs.add(pairKey(p.a, p.b));
    }
    const elsetEpochs = new Map<number, number>(elsets.map((e) => [e.norad, e.epochMs]));
    const forceOfNorad = (norad: number): Force => {
      const m = meta.get(norad);
      return forceOf({
        name: m?.name, owner: m?.owner, state: m?.state, gunterNation: m?.gunterNation,
        objectClass: m?.objectClass, launchState: m?.launchState,
      });
    };
    const forceByNorad = new Map<number, Force>();
    for (const norad of meta.keys()) forceByNorad.set(norad, forceOfNorad(norad));
    const persistOpts = { crossTagPairs, elsetEpochs, forceOfNorad };
    const conjResult = await persistEvents(conjKept.kept, "conjunction", persistOpts);
    const coResult = await persistEvents(coKept.kept, "coplanar", persistOpts);
    const warnings = [...conjResult.errors, ...coResult.errors];
    if (sgp4Truncated.current) {
      warnings.push("sgp4 stopped early to stay inside the scan deadline");
    }
    // Alert on genuinely NEW cases (never routine updates/reopens), plus
    // one follow-up when an ACTIVE case escalates (min range tightening
    // sharply). Failures are swallowed inside — posting must never fail
    // the scan.
    const elsetSnaps = new Map<number, ElsetSnap>(elsets.map((e) => [e.norad, e]));
    try {
      await withDeadline(
        deliverPolicyAlerts({
          tracked: [...conjResult.tracked, ...coResult.tracked],
          escalated: [...conjResult.escalated, ...coResult.escalated],
          meta,
          elsets: elsetSnaps,
          nowMs,
        }),
        RPOD_ALERT_TIMEOUT_MS,
        "rpod-alert",
      );
    } catch (err) {
      warnings.push(`alerts: ${String(err)}`.slice(0, 300));
      logger.warn({ err }, "rpod-scan: alert posting failed");
    }
    for (const [label, fn] of [
      ["reclassify", () => reclassifyDockedEvents(forceByNorad)],
      ["markStale", markStaleEvents],
    ] as const) {
      try {
        await fn();
      } catch (err) {
        rethrowIfConnectionLost(err);
        warnings.push(`${label}: ${String(err)}`.slice(0, 300));
        logger.warn({ err }, `rpod-scan: ${label} failed (scan otherwise ok)`);
      }
    }
    // A partial SGP4 pass did not re-see every coplanar pair. Retire uses
    // lastSeenAt, so ending cases off a truncated hour would drop shadowers
    // the scan simply did not get to.
    if (sgp4Truncated.current) {
      warnings.push("skipped coplanar retire after partial sgp4");
    } else {
      try {
        await retireDriftedCoplanarEvents();
      } catch (err) {
        rethrowIfConnectionLost(err);
        warnings.push(`retireCoplanar: ${String(err)}`.slice(0, 300));
        logger.warn({ err }, "rpod-scan: retireCoplanar failed (scan otherwise ok)");
      }
      try {
        await retireUnseenConjunctions();
      } catch (err) {
        rethrowIfConnectionLost(err);
        warnings.push(`retireConjunction: ${String(err)}`.slice(0, 300));
        logger.warn({ err }, "rpod-scan: retireConjunction failed (scan otherwise ok)");
      }
    }
    await logScanRow(
      "success",
      started,
      conjKept.kept.length + coKept.kept.length,
      warnings.length ? warnings.join("; ").slice(0, 2000) : undefined,
      abort,
    );
    logger.info(
      {
        elsets: elsets.length,
        candidates: candidates.length,
        flaggedPairs: flagged.length,
        events: events.length,
        interestingEvents: conjKept.kept.length,
        coCandidates: coCandidates.length,
        coplanarEvents: coEvents.length,
        interestingCoplanar: coKept.kept.length,
        interest: interestStats,
      },
      "rpod-scan: complete",
    );
  } catch (err) {
    // Deadline already logged and released the lock. Returning (instead of
    // rethrowing) keeps the orphaned doScan promise from becoming an
    // unhandled rejection, and skips a second sync-log row.
    if (abort.cancelled) return;
    await logScanRow("error", started, null, formatDbError(err), abort).catch((logErr) => {
      logger.error({ err: logErr }, "rpod-scan: failed to write sync log");
    });
    logger.error({ err }, "rpod-scan: failed");
    throw err; // propagate so the scheduler can schedule a short retry
  }
}

async function logScanRow(
  status: "success" | "error",
  startedAt: Date,
  rowCount: number | null,
  error?: string,
  abort?: ScanAbort,
  force = false,
) {
  // Already claimed: the in-flight insert is retrying, or it already finished.
  // A second insert would duplicate the row or burn another flap's worth of dials.
  if (abort?.logged) return;
  if (abort?.cancelled && !force) return;
  // Set before the insert so a deadline firing mid-write does not add another row.
  if (abort) markScanLogged(abort);
  await insertRpodScanSyncLog({ status, startedAt, rowCount, error: error ?? null });
}

/**
 * Upsert: an incoming event matches an existing ACTIVE event of the same
 * kind when they share ≥2 members — for conjunctions, additionally the TCAs
 * must be within 24h (discrete approaches); coplanar shadowing events match
 * on membership alone since they persist for weeks with a moving "TCA".
 *
 * Coplanar events additionally check recently-ENDED cases: if the same pair
 * (≥2 shared members) closed ranks again within COPLANAR_REOPEN_WINDOW_MS
 * of ending, the old case is REACTIVATED (same RPOD number, reopenCount
 * incremented) instead of opening a fresh case, keeping repeat offenders on
 * a single continuous file.
 *
 * Conjunction-track events get the analogous treatment against STALE cases:
 * a conjunction/docked case whose window lapsed (marked "stale" by
 * markStaleEvents) is reactivated when the same pair is re-flagged within
 * CONJUNCTION_REOPEN_WINDOW_MS of last being seen — same case number,
 * reopenCount incremented, the lapsed spell archived into closedSpells.
 * TCA proximity is deliberately NOT required on this path: a stale case is
 * by definition days past its window, so membership alone identifies the
 * continuing pair.
 */
export interface PersistOptions {
  crossTagPairs?: Set<string>;
  elsetEpochs?: Map<number, number>;
  forceOfNorad?: (norad: number) => Force;
}

export interface PersistResult {
  /** Freshly INSERTED cases (candidates for the new-case citation). */
  inserted: NewRpodEvent[];
  /** Every case written this pass, inserts and updates, for the alert policy. */
  tracked: TrackedRpodEvent[];
  /** ACTIVE cases whose min range tightened sharply against the case's first/max range. */
  escalated: EscalatedRpodEvent[];
  /** Per-event persist failures; the rest of the scan still succeeded. */
  errors: string[];
}

/** Shape GET /api/rpod/status uses for the latest rpod-scan sync-log row. */
export function formatRpodScanStatus(row?: {
  finishedAt: Date;
  status: string;
  rowCount: number | null;
  error: string | null;
} | null): { lastScanAt: string | null; lastScanStatus: string | null; lastScanEvents: number | null; lastScanError: string | null } {
  return {
    lastScanAt: row ? row.finishedAt.toISOString() : null,
    lastScanStatus: row?.status ?? null,
    lastScanEvents: row?.rowCount ?? null,
    lastScanError: row?.error ?? null,
  };
}

export async function persistEvents(
  events: ReturnType<typeof clusterPairs>,
  kind: "conjunction" | "coplanar",
  opts: PersistOptions = {},
): Promise<PersistResult> {
  const newlyInserted: NewRpodEvent[] = [];
  const tracked: TrackedRpodEvent[] = [];
  const escalated: EscalatedRpodEvent[] = [];
  const errors: string[] = [];
  if (events.length === 0) return { inserted: newlyInserted, tracked, escalated, errors };
  // Conjunction-track events may be stored as "conjunction" OR "docked" —
  // match across both so a stack flipping labels never spawns a duplicate case.
  const kinds = kind === "conjunction" ? ["conjunction", "docked"] : [kind];
  // These selects run before any write. A handshake abort here used to
  // escape persistEvents and stamp the whole hour lastScanStatus=error.
  // One case per pair, across conjunction / coplanar / docked. A shadowing
  // file and a later conjunction of the same objects stay on the same id.
  const active = await retryOnceOnTransient("rpod active events", () =>
    db.select().from(rpodEvents).where(eq(rpodEvents.status, "active")),
  );
  const activeMembers = active.length
    ? await retryOnceOnTransient("rpod active members", () =>
        db.select().from(rpodEventMembers).where(inArray(rpodEventMembers.eventId, active.map((e) => e.id))),
      )
    : [];
  const membersByEvent = new Map<number, Set<number>>();
  for (const m of activeMembers) {
    const s = membersByEvent.get(m.eventId) ?? new Set<number>();
    s.add(m.norad);
    membersByEvent.set(m.eventId, s);
  }

  // Recently-ended coplanar cases (and recently-stale conjunction-track
  // cases) stay eligible for reopening.
  const reopenWindowMs = kind === "coplanar" ? COPLANAR_REOPEN_WINDOW_MS : CONJUNCTION_REOPEN_WINDOW_MS;
  let endedWithMembers: {
    id: number; endedAt: Date | null; members: number[];
    firstDetectedAt: Date; lastSeenAt: Date; lastReopenedAt: Date | null;
    closedSpells: { start: string; lastSeenAt: string; endedAt: string }[];
  }[] = [];
  if (kind === "coplanar") {
    const ended = await retryOnceOnTransient("rpod ended coplanar", () =>
      db
        .select({
          id: rpodEvents.id, endedAt: rpodEvents.endedAt, reopenCount: rpodEvents.reopenCount,
          firstDetectedAt: rpodEvents.firstDetectedAt, lastSeenAt: rpodEvents.lastSeenAt,
          lastReopenedAt: rpodEvents.lastReopenedAt, closedSpells: rpodEvents.closedSpells,
        })
        .from(rpodEvents)
        .where(and(
          eq(rpodEvents.status, "ended"),
          eq(rpodEvents.kind, "coplanar"),
          sql`${rpodEvents.endedAt} > now() - make_interval(secs => ${COPLANAR_REOPEN_WINDOW_MS / 1000})`,
        )),
    );
    const endedMembers = ended.length
      ? await retryOnceOnTransient("rpod ended coplanar members", () =>
          db.select().from(rpodEventMembers).where(inArray(rpodEventMembers.eventId, ended.map((e) => e.id))),
        )
      : [];
    const byId = new Map<number, number[]>();
    for (const m of endedMembers) {
      const arr = byId.get(m.eventId) ?? [];
      arr.push(m.norad);
      byId.set(m.eventId, arr);
    }
    endedWithMembers = ended.map((e) => ({
      id: e.id, endedAt: e.endedAt, members: byId.get(e.id) ?? [],
      firstDetectedAt: e.firstDetectedAt, lastSeenAt: e.lastSeenAt,
      lastReopenedAt: e.lastReopenedAt, closedSpells: e.closedSpells ?? [],
    }));
  } else {
    // Stale conjunction-track cases (window lapsed >3d ago). They carry no
    // endedAt, so lastSeenAt — the last scan that re-detected the pair —
    // stands in as the end of the lapsed spell.
    const stale = await retryOnceOnTransient("rpod stale conjunction", () =>
      db
        .select({
          id: rpodEvents.id, reopenCount: rpodEvents.reopenCount,
          firstDetectedAt: rpodEvents.firstDetectedAt, lastSeenAt: rpodEvents.lastSeenAt,
          lastReopenedAt: rpodEvents.lastReopenedAt, closedSpells: rpodEvents.closedSpells,
        })
        .from(rpodEvents)
        .where(and(
          eq(rpodEvents.status, "stale"),
          inArray(rpodEvents.kind, kinds),
          sql`${rpodEvents.lastSeenAt} > now() - make_interval(secs => ${CONJUNCTION_REOPEN_WINDOW_MS / 1000})`,
        )),
    );
    const staleMembers = stale.length
      ? await retryOnceOnTransient("rpod stale conjunction members", () =>
          db.select().from(rpodEventMembers).where(inArray(rpodEventMembers.eventId, stale.map((e) => e.id))),
        )
      : [];
    const byId = new Map<number, number[]>();
    for (const m of staleMembers) {
      const arr = byId.get(m.eventId) ?? [];
      arr.push(m.norad);
      byId.set(m.eventId, arr);
    }
    endedWithMembers = stale.map((e) => ({
      id: e.id, endedAt: e.lastSeenAt, members: byId.get(e.id) ?? [],
      firstDetectedAt: e.firstDetectedAt, lastSeenAt: e.lastSeenAt,
      lastReopenedAt: e.lastReopenedAt, closedSpells: e.closedSpells ?? [],
    }));
  }

  for (const ev of events) {
    if (
      ev.members.length < 2 ||
      !ev.members.every((n) => Number.isFinite(n)) ||
      !Number.isFinite(ev.tcaMs) ||
      !Number.isFinite(ev.minRangeKm) ||
      !Number.isFinite(ev.relVelKmS) ||
      !Number.isFinite(ev.windowStartMs) ||
      !Number.isFinite(ev.windowEndMs)
    ) {
      logger.warn({ members: ev.members }, "rpod-scan: skipping event with non-finite geometry");
      continue;
    }

    try {
    // The lock socket can die during SGP4. Wait for the replacement (and
    // its reacquired advisory lock) before writing; a not-queryable client
    // never sent this transaction.
    await ensureAdvisoryLockClient();
    const evSet = new Set(ev.members);
    let match: (typeof active)[number] | undefined;
    let matchScore = -1;
    for (const ex of active) {
      const exSet = membersByEvent.get(ex.id);
      if (!exSet) continue;
      let shared = 0;
      for (const n of evSet) if (exSet.has(n)) shared++;
      if (shared < 2) continue;
      const exact = shared === evSet.size && exSet.size === evSet.size;
      const score = (exact ? 1000 : 0) + shared;
      if (!match || score > matchScore || (score === matchScore && ex.id < match.id)) {
        match = ex;
        matchScore = score;
      }
    }

    const cross = ev.members.length >= 2 && (opts.crossTagPairs?.has(pairKey(ev.members[0], ev.members[1])) ?? false);
    const forces = ev.members.map((n) => opts.forceOfNorad?.(n) ?? "neutral");
    const geometryDocked = kind === "conjunction" && isDockedGeometry(ev.minRangeKm, ev.relVelKmS);
    const labelDocked = geometryDocked && !cross && mayLabelDocked(ev.members, forces);
    let storedKind: "conjunction" | "coplanar" | "docked" =
      kind === "coplanar" ? "coplanar" : (labelDocked ? "docked" : "conjunction");
    // One file per pair. A coplanar shadow stays coplanar when a later
    // conjunction of the same objects is all this hour re-detected.
    if (match?.kind === "coplanar" && storedKind === "conjunction") storedKind = "coplanar";
    // A cross-tag, or a red-vs-blue "dock" invented from elsets, reports ~0 km.
    // Don't let that overwrite a real range already on the case.
    const keepPriorRange = match != null && match.minRangeKm > 1 && ev.minRangeKm < 1
      && !labelDocked && (cross || geometryDocked);

    const base = {
      kind: storedKind,
      windowStart: new Date(ev.windowStartMs),
      windowEnd: new Date(ev.windowEndMs),
      tca: new Date(ev.tcaMs),
      minRangeKm: Math.round((keepPriorRange ? match!.minRangeKm : ev.minRangeKm) * 1000) / 1000,
      relVelKmS: Math.round((keepPriorRange ? match!.relVelKmS : ev.relVelKmS) * 10000) / 10000,
      memberCount: ev.members.length,
      widenedScan: ev.hitCap,
      screeningMeta: { pairs: ev.pairs.length },
      status: "active",
      lastSeenAt: new Date(),
    };

    const memberStats = ev.members.map((norad) => {
      const mine = ev.pairs.filter((p) => p.a === norad || p.b === norad);
      const tight = mine.reduce((m, p) => (p.minRangeKm < m.minRangeKm ? p : m), mine[0]);
      return {
        norad,
        minRangeKm: tight && Number.isFinite(tight.minRangeKm) ? Math.round(tight.minRangeKm * 1000) / 1000 : null,
        relVelKmS: tight && Number.isFinite(tight.relVelKmS) ? Math.round(tight.relVelKmS * 10000) / 10000 : null,
      };
    });

    // Update + replace members in one transaction so a failed insert cannot
    // leave an active case with an empty member list (prod case 274).
    const persisted = await db.transaction(async (tx) => {
      let eventId: number;
      let inserted = false;
      let reopened = false;
      let escalation: EscalatedRpodEvent | null = null;
      if (match) {
        const reference = Math.max(
          match.firstMinRangeKm ?? match.minRangeKm,
          match.maxRangeKm ?? match.minRangeKm,
        );
        const nextMax = Math.max(reference, base.minRangeKm);
        const epochs = epochRecord(ev.members, opts.elsetEpochs);
        await tx.update(rpodEvents).set({
          ...base,
          scanCount: sql`${rpodEvents.scanCount} + 1`,
          firstMinRangeKm: match.firstMinRangeKm ?? match.minRangeKm,
          maxRangeKm: nextMax,
          lastElsetEpochs: epochs,
          suspectedCrossTag: cross,
          updatedAt: sql`now()`,
        }).where(eq(rpodEvents.id, match.id));
        eventId = match.id;
        if (base.kind !== "docked" && !cross && isEscalation(reference, base.minRangeKm)) {
          escalation = {
            eventId,
            kind: base.kind,
            members: ev.members,
            minRangeKm: base.minRangeKm,
            relVelKmS: base.relVelKmS,
            tcaMs: ev.tcaMs,
            prevMinRangeKm: reference,
          };
        }
        await tx.delete(rpodEventMembers).where(eq(rpodEventMembers.eventId, eventId));
      } else {
        const reopenId = selectReopenCandidate(endedWithMembers, ev.members, Date.now(), reopenWindowMs);
        if (reopenId != null) {
          const prior = endedWithMembers.find((e) => e.id === reopenId)!;
          const spellStart = prior.lastReopenedAt ?? prior.firstDetectedAt;
          const closedSpells = [
            ...prior.closedSpells,
            {
              start: spellStart.toISOString(),
              lastSeenAt: prior.lastSeenAt.toISOString(),
              endedAt: (prior.endedAt ?? prior.lastSeenAt).toISOString(),
            },
          ];
          await tx
            .update(rpodEvents)
            .set({
              ...base,
              endedAt: null,
              reopenCount: sql`${rpodEvents.reopenCount} + 1`,
              lastReopenedAt: sql`now()`,
              closedSpells,
              scanCount: 1,
              firstMinRangeKm: base.minRangeKm,
              maxRangeKm: base.minRangeKm,
              lastElsetEpochs: epochRecord(ev.members, opts.elsetEpochs),
              suspectedCrossTag: cross,
              updatedAt: sql`now()`,
            })
            .where(eq(rpodEvents.id, reopenId));
          eventId = reopenId;
          reopened = true;
          await tx.delete(rpodEventMembers).where(eq(rpodEventMembers.eventId, eventId));
        } else {
          const [row] = await tx.insert(rpodEvents).values({
            ...base,
            scanCount: 1,
            firstMinRangeKm: base.minRangeKm,
            maxRangeKm: base.minRangeKm,
            lastElsetEpochs: epochRecord(ev.members, opts.elsetEpochs),
            suspectedCrossTag: cross,
          }).returning({ id: rpodEvents.id });
          eventId = row.id;
          inserted = true;
        }
      }
      await tx.insert(rpodEventMembers).values(memberStats.map((m) => ({ eventId, ...m }))).onConflictDoNothing();
      return { eventId, inserted, reopened, escalation };
    });

    const trackedEvent: TrackedRpodEvent = {
      eventId: persisted.eventId,
      kind: base.kind,
      members: ev.members,
      minRangeKm: base.minRangeKm,
      relVelKmS: base.relVelKmS,
      tcaMs: ev.tcaMs,
      firstDetectedAtMs: match ? match.firstDetectedAt.getTime() : Date.now(),
      lastSeenAtMs: Date.now(),
      scanCount: match ? (match.scanCount ?? 1) + 1 : 1,
      firstRangeKm: match ? (match.firstMinRangeKm ?? match.minRangeKm) : base.minRangeKm,
      maxRangeKm: match
        ? Math.max(match.firstMinRangeKm ?? match.minRangeKm, match.maxRangeKm ?? match.minRangeKm, base.minRangeKm)
        : base.minRangeKm,
      previousElsetEpochs: match?.lastElsetEpochs ?? null,
      previousMinRangeKm: match ? match.minRangeKm : null,
      suspectedCrossTag: cross,
      pairs: ev.pairs.map((p) => ({ a: p.a, b: p.b, minRangeKm: p.minRangeKm, relVelKmS: p.relVelKmS })),
    };
    tracked.push(trackedEvent);
    if (persisted.inserted) {
      newlyInserted.push(trackedEvent);
    }
    if (persisted.escalation) escalated.push(persisted.escalation);
    if (persisted.reopened) {
      endedWithMembers = endedWithMembers.filter((e) => e.id !== persisted.eventId);
      logger.info({ eventId: persisted.eventId, kind }, "rpod-scan: reopened lapsed case (same pair re-detected)");
    }
    } catch (err) {
      rethrowIfConnectionLost(err);
      const msg = `members ${ev.members.join("+")}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg.slice(0, 300));
      logger.warn({ err, members: ev.members, kind }, "rpod-scan: persist skipped one event");
    }
  }
  return { inserted: newlyInserted, tracked, escalated, errors };
}

function epochRecord(members: number[], epochs: Map<number, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!epochs) return out;
  for (const n of members) {
    const e = epochs.get(n);
    if (e != null && Number.isFinite(e)) out[String(n)] = e;
  }
  return out;
}

/**
 * Sweep conjunction-track rows so the label matches the policy, not just
 * the range reading. Near-zero range and relative velocity is "docked" only
 * for a known station/stack or a same-force pair. A red object next to a
 * blue or neutral one is never docked from elsets (event 1638). Geometry
 * that no longer qualifies flips back to "conjunction".
 *
 * `knownForces` is the scan's catalog map. Omitted, the sweep loads the
 * catalog itself (the flip test, and a manual re-run). A NORAD with no
 * row is neutral, so an uncatalogued pair still follows geometry.
 */
export async function reclassifyDockedEvents(knownForces?: Map<number, Force>): Promise<void> {
  await ensureAdvisoryLockClient();
  const rows = await db
    .select({
      id: rpodEvents.id,
      kind: rpodEvents.kind,
      minRangeKm: rpodEvents.minRangeKm,
      relVelKmS: rpodEvents.relVelKmS,
    })
    .from(rpodEvents)
    .where(inArray(rpodEvents.kind, ["conjunction", "docked"]));
  if (rows.length === 0) return;

  const memberRows = await db
    .select({ eventId: rpodEventMembers.eventId, norad: rpodEventMembers.norad })
    .from(rpodEventMembers)
    .where(inArray(rpodEventMembers.eventId, rows.map((r) => r.id)));
  const membersByEvent = new Map<number, number[]>();
  for (const m of memberRows) {
    const arr = membersByEvent.get(m.eventId) ?? [];
    arr.push(m.norad);
    membersByEvent.set(m.eventId, arr);
  }

  let forces = knownForces;
  if (!forces) {
    const meta = await loadCatalogMeta();
    forces = new Map();
    for (const [norad, m] of meta) {
      forces.set(norad, forceOf({
        name: m.name, owner: m.owner, state: m.state, gunterNation: m.gunterNation,
        objectClass: m.objectClass, launchState: m.launchState,
      }));
    }
  }

  const toDocked: number[] = [];
  const toConjunction: number[] = [];
  for (const row of rows) {
    const norads = membersByEvent.get(row.id) ?? [];
    const geometry = isDockedGeometry(row.minRangeKm, row.relVelKmS);
    const memberForces = norads.map((n) => forces!.get(n) ?? "neutral");
    const dock = geometry && mayLabelDocked(norads, memberForces);
    if (dock && row.kind !== "docked") toDocked.push(row.id);
    else if (!dock && row.kind === "docked") toConjunction.push(row.id);
  }
  if (toDocked.length) {
    await db.update(rpodEvents).set({ kind: "docked", updatedAt: sql`now()` }).where(inArray(rpodEvents.id, toDocked));
  }
  if (toConjunction.length) {
    await db.update(rpodEvents).set({ kind: "conjunction", updatedAt: sql`now()` }).where(inArray(rpodEvents.id, toConjunction));
  }
  if (toDocked.length || toConjunction.length) {
    logger.info({ toDocked: toDocked.length, toConjunction: toConjunction.length }, "rpod-scan: reclassified docked stacks");
  }
}

/** Active events whose window has long passed become stale (kept for history). */
async function markStaleEvents(): Promise<void> {
  await ensureAdvisoryLockClient();
  await db
    .update(rpodEvents)
    .set({ status: "stale", updatedAt: sql`now()` })
    .where(and(eq(rpodEvents.status, "active"), lt(rpodEvents.windowEnd, new Date(Date.now() - STALE_AFTER_MS))));
}

/**
 * Retire coplanar shadowing events whose pair has drifted apart: if no scan
 * has re-detected the event for COPLANAR_END_AFTER_MS, mark it "ended" with
 * an end date. lastSeenAt is left untouched so the UI can show when the pair
 * was last observed together. Only runs after a successful scan, so an outage
 * of the scanner itself can't retire cases.
 */
async function retireDriftedCoplanarEvents(): Promise<void> {
  await ensureAdvisoryLockClient();
  const active = await db
    .select({ id: rpodEvents.id, lastSeenAt: rpodEvents.lastSeenAt })
    .from(rpodEvents)
    .where(and(eq(rpodEvents.status, "active"), eq(rpodEvents.kind, "coplanar")));
  const ids = selectEndedCoplanarIds(active, Date.now());
  if (ids.length === 0) return;
  await db
    .update(rpodEvents)
    .set({ status: "ended", endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(inArray(rpodEvents.id, ids));
  logger.info({ ended: ids.length }, "rpod-scan: retired drifted coplanar events");
}

/**
 * Conjunction and elset-docked cases that no scan has re-seen for 24 h are
 * ended. A discrete approach that is not refreshed is not still happening.
 */
async function retireUnseenConjunctions(): Promise<void> {
  await ensureAdvisoryLockClient();
  const active = await db
    .select({ id: rpodEvents.id, kind: rpodEvents.kind, lastSeenAt: rpodEvents.lastSeenAt })
    .from(rpodEvents)
    .where(and(eq(rpodEvents.status, "active"), inArray(rpodEvents.kind, ["conjunction", "docked"])));
  const ids = selectUnseenConjunctionIds(active, Date.now());
  if (ids.length === 0) return;
  await db
    .update(rpodEvents)
    .set({ status: "ended", endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(inArray(rpodEvents.id, ids));
  logger.info({ ended: ids.length }, "rpod-scan: retired unseen conjunction events");
}
