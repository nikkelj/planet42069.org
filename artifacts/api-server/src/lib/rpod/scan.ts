import { db } from "@workspace/db";
import { rpodEvents, rpodEventMembers, obcSyncLog } from "@workspace/db/schema";
import { sql, eq, and, inArray, lt } from "drizzle-orm";
import { logger } from "../logger";
import { getLatestElsets, withAdvisoryLock, LOCK_RPOD_SCAN, type LatestElset } from "../obc/tleArchive";
import { getSatcatFromStore } from "../obc/store";
import {
  screenCandidatePairs, closeApproach, clusterPairs,
  DEFAULT_SCREEN, RPOD_MAX_RANGE_KM, RPOD_MAX_RELVEL_KM_S,
  type ScreenElset, type FlaggedPair, type ScreenOptions,
} from "./screen";

/**
 * RPOD scan orchestrator: pulls the latest archived elsets, runs the
 * screen → SGP4-diff → cluster pipeline, and upserts flagged events.
 *
 * Guardrails for catalog-scale runs:
 *  - only elsets fresher than ELSET_MAX_AGE feed the scan
 *  - same-launch pairs younger than DEPLOY_QUIET_DAYS are skipped
 *    (deployment dispersion is not proximity OPERATIONS)
 *  - SGP4 differencing is capped at MAX_SGP4_PAIRS per run, tightest
 *    screening margins first
 */

const ELSET_MAX_AGE_MS = 3 * 86400_000;
const DEPLOY_QUIET_DAYS = 60;
const MAX_SGP4_PAIRS = 1200;
const MEMBER_CAP = 5;
/** Events whose window ended this long ago get marked stale. */
const STALE_AFTER_MS = 3 * 86400_000;

let scanInFlight: Promise<void> | null = null;

export function runRpodScan(): Promise<void> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = withAdvisoryLock(LOCK_RPOD_SCAN, "rpod-scan", doScan).finally(() => { scanInFlight = null; });
  return scanInFlight;
}

interface CatalogMeta {
  launchTag: string | null;
  ldate: string | null;
}

async function loadCatalogMeta(): Promise<Map<number, CatalogMeta>> {
  const map = new Map<number, CatalogMeta>();
  try {
    const entries = await getSatcatFromStore();
    for (const e of entries) {
      if (e.satno != null) map.set(e.satno, { launchTag: e.launchTag ?? null, ldate: e.ldate });
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

function isSameFreshLaunch(a: number, b: number, meta: Map<number, CatalogMeta>, nowMs: number): boolean {
  const ma = meta.get(a);
  const mb = meta.get(b);
  if (!ma?.launchTag || !mb?.launchTag || ma.launchTag !== mb.launchTag) return false;
  const t = ma.ldate ? Date.parse(ma.ldate) : NaN;
  return Number.isFinite(t) && nowMs - t < DEPLOY_QUIET_DAYS * 86400_000;
}

async function doScan(): Promise<void> {
  const started = new Date();
  const nowMs = Date.now();
  try {
    const [latest, meta] = await Promise.all([
      getLatestElsets(nowMs - ELSET_MAX_AGE_MS),
      loadCatalogMeta(),
    ]);
    if (latest.length < 2) {
      logger.info({ elsets: latest.length }, "rpod-scan: not enough archived elsets yet, skipping");
      return;
    }
    const elsets = latest.map(toScreenElset);
    const byNorad = new Map(elsets.map((e) => [e.norad, e]));

    // Stage 1
    let candidates = screenCandidatePairs(elsets, DEFAULT_SCREEN)
      .filter((p) => !isSameFreshLaunch(p.a.norad, p.b.norad, meta, nowMs));
    // Tightest planes first when over budget
    if (candidates.length > MAX_SGP4_PAIRS) {
      candidates = candidates
        .map((p) => ({ p, score: Math.abs(p.a.incDeg - p.b.incDeg) + Math.abs(p.a.meanMotionRevPerDay - p.b.meanMotionRevPerDay) * 4 }))
        .sort((x, y) => x.score - y.score)
        .slice(0, MAX_SGP4_PAIRS)
        .map((x) => x.p);
    }

    // Stage 2
    const flagged: FlaggedPair[] = [];
    for (const { a, b } of candidates) {
      const ca = closeApproach(a, b, nowMs, DEFAULT_SCREEN.windowMs);
      if (!ca) continue;
      if (ca.minRangeKm <= RPOD_MAX_RANGE_KM && ca.relVelKmS <= RPOD_MAX_RELVEL_KM_S) {
        flagged.push({ a: a.norad, b: b.norad, minRangeKm: ca.minRangeKm, relVelKmS: ca.relVelKmS, tcaMs: ca.tcaMs });
      }
    }

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
      const widePairs = screenCandidatePairs(neighborhood, relaxed)
        .filter((p) => memberSet.has(p.a.norad) || memberSet.has(p.b.norad))
        .filter((p) => !isSameFreshLaunch(p.a.norad, p.b.norad, meta, nowMs))
        .slice(0, 400);
      for (const { a, b } of widePairs) {
        if (flagged.some((f) => (f.a === a.norad && f.b === b.norad) || (f.a === b.norad && f.b === a.norad))) continue;
        const ca = closeApproach(a, b, nowMs, DEFAULT_SCREEN.windowMs);
        if (ca && ca.minRangeKm <= RPOD_MAX_RANGE_KM && ca.relVelKmS <= RPOD_MAX_RELVEL_KM_S) {
          flagged.push({ a: a.norad, b: b.norad, minRangeKm: ca.minRangeKm, relVelKmS: ca.relVelKmS, tcaMs: ca.tcaMs });
        }
      }
      // Re-cluster once after all widened pairs are in.
      events = clusterPairs(flagged, MEMBER_CAP);
      break;
    }

    await persistEvents(events);
    await markStaleEvents();
    await logScanRow("success", started, events.length);
    logger.info(
      { elsets: elsets.length, candidates: candidates.length, flaggedPairs: flagged.length, events: events.length },
      "rpod-scan: complete",
    );
  } catch (err) {
    await logScanRow("error", started, null, String(err));
    logger.error({ err }, "rpod-scan: failed");
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
 * Upsert: an incoming event matches an existing ACTIVE event when they share
 * ≥2 members and their TCAs are within 24h — then update in place (ranges
 * and membership evolve as fresher elsets arrive). Otherwise insert.
 */
async function persistEvents(events: ReturnType<typeof clusterPairs>): Promise<void> {
  if (events.length === 0) return;
  const active = await db.select().from(rpodEvents).where(eq(rpodEvents.status, "active"));
  const activeMembers = active.length
    ? await db.select().from(rpodEventMembers).where(inArray(rpodEventMembers.eventId, active.map((e) => e.id)))
    : [];
  const membersByEvent = new Map<number, Set<number>>();
  for (const m of activeMembers) {
    const s = membersByEvent.get(m.eventId) ?? new Set<number>();
    s.add(m.norad);
    membersByEvent.set(m.eventId, s);
  }

  for (const ev of events) {
    const evSet = new Set(ev.members);
    const match = active.find((ex) => {
      const exSet = membersByEvent.get(ex.id);
      if (!exSet) return false;
      let shared = 0;
      for (const n of evSet) if (exSet.has(n)) shared++;
      return shared >= 2 && Math.abs(new Date(ex.tca).getTime() - ev.tcaMs) < 24 * 3600_000;
    });

    const base = {
      windowStart: new Date(ev.windowStartMs),
      windowEnd: new Date(ev.windowEndMs),
      tca: new Date(ev.tcaMs),
      minRangeKm: Math.round(ev.minRangeKm * 1000) / 1000,
      relVelKmS: Math.round(ev.relVelKmS * 10000) / 10000,
      memberCount: ev.members.length,
      widenedScan: ev.hitCap,
      screeningMeta: { pairs: ev.pairs.length },
      status: "active",
    };

    let eventId: number;
    if (match) {
      await db.update(rpodEvents).set({ ...base, updatedAt: sql`now()` }).where(eq(rpodEvents.id, match.id));
      eventId = match.id;
      await db.delete(rpodEventMembers).where(eq(rpodEventMembers.eventId, eventId));
    } else {
      const [row] = await db.insert(rpodEvents).values(base).returning({ id: rpodEvents.id });
      eventId = row.id;
    }

    // Per-member tightest pair stats
    const memberRows = ev.members.map((norad) => {
      const mine = ev.pairs.filter((p) => p.a === norad || p.b === norad);
      const tight = mine.reduce((m, p) => (p.minRangeKm < m.minRangeKm ? p : m), mine[0]);
      return {
        eventId,
        norad,
        minRangeKm: tight ? Math.round(tight.minRangeKm * 1000) / 1000 : null,
        relVelKmS: tight ? Math.round(tight.relVelKmS * 10000) / 10000 : null,
      };
    });
    await db.insert(rpodEventMembers).values(memberRows).onConflictDoNothing();
  }
}

/** Active events whose window has long passed become stale (kept for history). */
async function markStaleEvents(): Promise<void> {
  await db
    .update(rpodEvents)
    .set({ status: "stale", updatedAt: sql`now()` })
    .where(and(eq(rpodEvents.status, "active"), lt(rpodEvents.windowEnd, new Date(Date.now() - STALE_AFTER_MS))));
}
