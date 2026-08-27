import { db } from "@workspace/db";
import { rpodEvents, rpodEventMembers, obcSyncLog } from "@workspace/db/schema";
import { sql, eq, and, inArray, lt } from "drizzle-orm";
import { logger } from "../logger";
import { getLatestElsetsOrSkip, formatDbError, withAdvisoryLock, LOCK_RPOD_SCAN, ELSET_FUTURE_SLACK_MS, type LatestElset } from "../obc/tleArchive";
import { getSatcatFromStore } from "../obc/store";
import {
  screenCandidatePairs, screenCoAlignedPairs, closeApproach, clusterPairs,
  DEFAULT_SCREEN, DEFAULT_COALIGNED, RPOD_MAX_RANGE_KM, RPOD_MAX_RELVEL_KM_S,
  COALIGNED_MAX_RANGE_KM, COALIGNED_MAX_RELVEL_KM_S, semiMajorAxisKm, minPhaseDiffDeg,
  hasUsableTleLines, tleEpochIsCurrent, yieldToEventLoop, SCREEN_YIELD_EVERY,
  type ScreenElset, type FlaggedPair, type ScreenOptions,
} from "./screen";
import { selectEndedCoplanarIds, selectReopenCandidate, COPLANAR_REOPEN_WINDOW_MS, CONJUNCTION_REOPEN_WINDOW_MS } from "./retire";
import { postNewRpodEventAlerts, postEscalationAlerts, isEscalation, type NewRpodEvent, type EscalatedRpodEvent } from "./alert";
import {
  DOCKED_MAX_RANGE_KM, DOCKED_MAX_RELVEL_KM_S, isDockedGeometry,
  isProvenSamePair, prioritizeSgp4Pairs, selectInterestingEvents,
  type InterestCatalogMeta,
} from "./interest";

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
 *  - persist only "interesting" events (mixed-operator, non-docked
 *    clusters, ultra-close same-operator near-misses) — see interest.ts
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
  scanInFlight = withAdvisoryLock(LOCK_RPOD_SCAN, "rpod-scan", doScan).finally(() => { scanInFlight = null; });
  return scanInFlight;
}

interface CatalogMeta extends InterestCatalogMeta {
  launchTag: string | null;
  ldate: string | null;
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
    for (const e of entries) {
      if (e.satno != null) {
        map.set(e.satno, {
          launchTag: e.launchTag ?? null,
          ldate: e.ldate,
          name: e.name ?? e.plName ?? null,
          objectClass: e.objectClass ?? null,
          owner: e.owner ?? null,
          state: e.state ?? null,
          gunterOperator: e.gunterOperator ?? null,
          gunterNation: e.gunterNation ?? null,
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
): Promise<FlaggedPair[]> {
  const flagged: FlaggedPair[] = [];
  for (let i = 0; i < pairs.length; i++) {
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

async function doScan(): Promise<void> {
  const started = new Date();
  const nowMs = Date.now();
  try {
    const [loaded, meta] = await Promise.all([
      getLatestElsetsOrSkip(nowMs - ELSET_MAX_AGE_MS, nowMs + ELSET_FUTURE_SLACK_MS),
      loadCatalogMeta(),
    ]);
    if (loaded.warning) {
      // Do not stamp lastScanStatus=error — a bad TLE fetch must not abort
      // the hour (same idea as persist skipping one bad event). Record a
      // success row with the reason so lastScanError is visible.
      await logScanRow("success", started, 0, loaded.warning);
      logger.warn({ warning: loaded.warning }, "rpod-scan: skipping hour after elset fetch failure");
      return;
    }
    const latest = loaded.rows;
    if (latest.length < 2) {
      logger.info({ elsets: latest.length }, "rpod-scan: not enough archived elsets yet, skipping");
      return;
    }
    const elsets = latest.map(toScreenElset).filter((e) =>
      hasUsableTleLines(e)
      && Number.isFinite(e.epochMs) && e.epochMs <= nowMs + ELSET_FUTURE_SLACK_MS
      && tleEpochIsCurrent(e.line1, nowMs),
    );
    if (elsets.length < 2) {
      logger.info({ fetched: latest.length, usable: elsets.length }, "rpod-scan: not enough usable elsets, skipping");
      return;
    }
    const byNorad = new Map(elsets.map((e) => [e.norad, e]));

    // Stage 1
    const planeScore = (p: { a: ScreenElset; b: ScreenElset }) =>
      Math.abs(p.a.incDeg - p.b.incDeg) + Math.abs(p.a.meanMotionRevPerDay - p.b.meanMotionRevPerDay) * 4;
    let candidates = (await screenCandidatePairs(elsets, DEFAULT_SCREEN, SCREEN_YIELD_EVERY))
      .filter((p) => !isSameFreshLaunch(p.a.norad, p.b.norad, meta, nowMs));
    // Mixed-force pairs take the SGP4 budget first so Starlink housekeeping
    // cannot crowd red-vs-blue approaches off the hour.
    if (candidates.length > MAX_SGP4_PAIRS) {
      candidates = prioritizeSgp4Pairs(candidates, meta, MAX_SGP4_PAIRS, planeScore);
    }

    // Stage 2 — yield between pairs so GET /api/rpod/status can still flush.
    const flagged = await sgp4FlagPairs(candidates, nowMs, RPOD_MAX_RANGE_KM, RPOD_MAX_RELVEL_KM_S);

    // Co-aligned (coplanar shadowing) screen: same plane + same radial shell,
    // slowly drifting in phase. The 30 km bubble rarely closes for these, so
    // they're flagged on geometry with loose range/velocity caps instead.
    const flaggedKeys = new Set(flagged.map((f) => pairKey(f.a, f.b)));
    let coCandidates = (await screenCoAlignedPairs(elsets, DEFAULT_COALIGNED, nowMs, SCREEN_YIELD_EVERY))
      .filter((p) => isPayloadPair(p.a.norad, p.b.norad, meta))
      .filter((p) => !isSameLaunch(p.a.norad, p.b.norad, meta))
      .filter((p) => !isProvenSamePair(p.a.norad, p.b.norad, meta))
      .filter((p) => !flaggedKeys.has(pairKey(p.a.norad, p.b.norad)));
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
    const coFlagged = await sgp4FlagPairs(coCandidates, nowMs, COALIGNED_MAX_RANGE_KM, COALIGNED_MAX_RELVEL_KM_S);

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
      const widePairs = (await screenCandidatePairs(neighborhood, relaxed, SCREEN_YIELD_EVERY))
        .filter((p) => memberSet.has(p.a.norad) || memberSet.has(p.b.norad))
        .filter((p) => !isSameFreshLaunch(p.a.norad, p.b.norad, meta, nowMs))
        .filter((p) => !flaggedKeys.has(pairKey(p.a.norad, p.b.norad)))
        .slice(0, 400);
      flagged.push(...await sgp4FlagPairs(widePairs, nowMs, RPOD_MAX_RANGE_KM, RPOD_MAX_RELVEL_KM_S));
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

    const conjResult = await persistEvents(conjKept.kept, "conjunction");
    const coResult = await persistEvents(coKept.kept, "coplanar");
    const warnings = [...conjResult.errors, ...coResult.errors];
    // Alert on genuinely NEW cases (never routine updates/reopens), plus
    // one follow-up when an ACTIVE case escalates (min range tightening
    // sharply). Failures are swallowed inside — posting must never fail
    // the scan.
    const metaFor = (norad: number) => {
      const m = meta.get(norad);
      return m ? { name: m.name, launchTag: m.launchTag } : undefined;
    };
    try {
      await postNewRpodEventAlerts([...conjResult.inserted, ...coResult.inserted], metaFor);
      await postEscalationAlerts([...conjResult.escalated, ...coResult.escalated], metaFor);
    } catch (err) {
      warnings.push(`alerts: ${String(err)}`.slice(0, 300));
      logger.warn({ err }, "rpod-scan: alert posting failed");
    }
    for (const [label, fn] of [
      ["reclassify", reclassifyDockedEvents],
      ["markStale", markStaleEvents],
      ["retireCoplanar", retireDriftedCoplanarEvents],
    ] as const) {
      try {
        await fn();
      } catch (err) {
        warnings.push(`${label}: ${String(err)}`.slice(0, 300));
        logger.warn({ err }, `rpod-scan: ${label} failed (scan otherwise ok)`);
      }
    }
    await logScanRow(
      "success",
      started,
      conjKept.kept.length + coKept.kept.length,
      warnings.length ? warnings.join("; ").slice(0, 2000) : undefined,
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
    await logScanRow("error", started, null, formatDbError(err));
    logger.error({ err }, "rpod-scan: failed");
    throw err; // propagate so the scheduler can schedule a short retry
  }
}

async function logScanRow(status: "success" | "error", startedAt: Date, rowCount: number | null, error?: string) {
  try {
    await db.insert(obcSyncLog).values({ source: "rpod-scan", status, rowCount, error: error?.slice(0, 2000) ?? null, startedAt });
  } catch (err) {
    logger.error({ err }, "rpod-scan: failed to write sync log");
  }
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
export interface PersistResult {
  /** Freshly INSERTED cases (candidates for the new-case citation). */
  inserted: NewRpodEvent[];
  /** ACTIVE cases whose min range tightened sharply on this update. */
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

export async function persistEvents(events: ReturnType<typeof clusterPairs>, kind: "conjunction" | "coplanar"): Promise<PersistResult> {
  const newlyInserted: NewRpodEvent[] = [];
  const escalated: EscalatedRpodEvent[] = [];
  const errors: string[] = [];
  if (events.length === 0) return { inserted: newlyInserted, escalated, errors };
  // Conjunction-track events may be stored as "conjunction" OR "docked" —
  // match across both so a stack flipping labels never spawns a duplicate case.
  const kinds = kind === "conjunction" ? ["conjunction", "docked"] : [kind];
  const active = await db.select().from(rpodEvents).where(and(eq(rpodEvents.status, "active"), inArray(rpodEvents.kind, kinds)));
  const activeMembers = active.length
    ? await db.select().from(rpodEventMembers).where(inArray(rpodEventMembers.eventId, active.map((e) => e.id)))
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
    const ended = await db
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
      ));
    const endedMembers = ended.length
      ? await db.select().from(rpodEventMembers).where(inArray(rpodEventMembers.eventId, ended.map((e) => e.id)))
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
    const stale = await db
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
      ));
    const staleMembers = stale.length
      ? await db.select().from(rpodEventMembers).where(inArray(rpodEventMembers.eventId, stale.map((e) => e.id)))
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
    const evSet = new Set(ev.members);
    const match = active.find((ex) => {
      const exSet = membersByEvent.get(ex.id);
      if (!exSet) return false;
      let shared = 0;
      for (const n of evSet) if (exSet.has(n)) shared++;
      if (shared < 2) return false;
      return kind === "coplanar" || Math.abs(new Date(ex.tca).getTime() - ev.tcaMs) < 24 * 3600_000;
    });

    const base = {
      kind: kind === "conjunction" && isDockedGeometry(ev.minRangeKm, ev.relVelKmS) ? "docked" : kind,
      windowStart: new Date(ev.windowStartMs),
      windowEnd: new Date(ev.windowEndMs),
      tca: new Date(ev.tcaMs),
      minRangeKm: Math.round(ev.minRangeKm * 1000) / 1000,
      relVelKmS: Math.round(ev.relVelKmS * 10000) / 10000,
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
        await tx.update(rpodEvents).set({ ...base, updatedAt: sql`now()` }).where(eq(rpodEvents.id, match.id));
        eventId = match.id;
        if (base.kind !== "docked" && isEscalation(match.minRangeKm, base.minRangeKm)) {
          escalation = {
            eventId,
            kind: base.kind,
            members: ev.members,
            minRangeKm: base.minRangeKm,
            relVelKmS: base.relVelKmS,
            tcaMs: ev.tcaMs,
            prevMinRangeKm: match.minRangeKm,
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
              updatedAt: sql`now()`,
            })
            .where(eq(rpodEvents.id, reopenId));
          eventId = reopenId;
          reopened = true;
          await tx.delete(rpodEventMembers).where(eq(rpodEventMembers.eventId, eventId));
        } else {
          const [row] = await tx.insert(rpodEvents).values(base).returning({ id: rpodEvents.id });
          eventId = row.id;
          inserted = true;
        }
      }
      await tx.insert(rpodEventMembers).values(memberStats.map((m) => ({ eventId, ...m }))).onConflictDoNothing();
      return { eventId, inserted, reopened, escalation };
    });

    if (persisted.inserted) {
      newlyInserted.push({
        eventId: persisted.eventId,
        kind: base.kind,
        members: ev.members,
        minRangeKm: base.minRangeKm,
        relVelKmS: base.relVelKmS,
        tcaMs: ev.tcaMs,
      });
    }
    if (persisted.escalation) escalated.push(persisted.escalation);
    if (persisted.reopened) {
      endedWithMembers = endedWithMembers.filter((e) => e.id !== persisted.eventId);
      logger.info({ eventId: persisted.eventId, kind }, "rpod-scan: reopened lapsed case (same pair re-detected)");
    }
    } catch (err) {
      const msg = `members ${ev.members.join("+")}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg.slice(0, 300));
      logger.warn({ err, members: ev.members, kind }, "rpod-scan: persist skipped one event");
    }
  }
  return { inserted: newlyInserted, escalated, errors };
}

/**
 * Sweep existing conjunction-track rows so historical cases (including ones
 * created before docked labeling existed, or no longer re-detected) carry the
 * right label: near-zero range + near-zero relative velocity ⇒ "docked",
 * and back to "conjunction" if the stats no longer qualify.
 */
export async function reclassifyDockedEvents(): Promise<void> {
  const toDocked = await db
    .update(rpodEvents)
    .set({ kind: "docked", updatedAt: sql`now()` })
    .where(and(
      eq(rpodEvents.kind, "conjunction"),
      sql`${rpodEvents.minRangeKm} <= ${DOCKED_MAX_RANGE_KM}`,
      sql`${rpodEvents.relVelKmS} <= ${DOCKED_MAX_RELVEL_KM_S}`,
    ))
    .returning({ id: rpodEvents.id });
  const toConjunction = await db
    .update(rpodEvents)
    .set({ kind: "conjunction", updatedAt: sql`now()` })
    .where(and(
      eq(rpodEvents.kind, "docked"),
      sql`(${rpodEvents.minRangeKm} > ${DOCKED_MAX_RANGE_KM} or ${rpodEvents.relVelKmS} > ${DOCKED_MAX_RELVEL_KM_S})`,
    ))
    .returning({ id: rpodEvents.id });
  if (toDocked.length || toConjunction.length) {
    logger.info({ toDocked: toDocked.length, toConjunction: toConjunction.length }, "rpod-scan: reclassified docked stacks");
  }
}

/** Active events whose window has long passed become stale (kept for history). */
async function markStaleEvents(): Promise<void> {
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
