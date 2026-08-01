import { db } from "@workspace/db";
import { rpodEvents, rpodEventMembers, obcSyncLog } from "@workspace/db/schema";
import { sql, eq, and, inArray, lt } from "drizzle-orm";
import { logger } from "../logger";
import { getLatestElsets, withAdvisoryLock, LOCK_RPOD_SCAN, type LatestElset } from "../obc/tleArchive";
import { getSatcatFromStore } from "../obc/store";
import {
  screenCandidatePairs, screenCoAlignedPairs, closeApproach, clusterPairs,
  DEFAULT_SCREEN, DEFAULT_COALIGNED, RPOD_MAX_RANGE_KM, RPOD_MAX_RELVEL_KM_S,
  COALIGNED_MAX_RANGE_KM, COALIGNED_MAX_RELVEL_KM_S, semiMajorAxisKm, minPhaseDiffDeg,
  type ScreenElset, type FlaggedPair, type ScreenOptions,
} from "./screen";
import { selectEndedCoplanarIds, selectReopenCandidate, COPLANAR_REOPEN_WINDOW_MS } from "./retire";

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

interface CatalogMeta {
  launchTag: string | null;
  ldate: string | null;
  name: string | null;
  objectClass: string | null;
}

/**
 * Mega-constellation families whose sibling pairs are routine station-keeping
 * neighbors, not proximity operations. Deliberately NOT a generic name-prefix
 * rule: catch-all names like "Kosmos-NNNN" cover genuinely interesting
 * inspector pairs and must never be filtered.
 */
const CONSTELLATION_PATTERNS: [string, RegExp][] = [
  ["starlink", /^starlink\b/],
  ["oneweb", /^oneweb\b/],
  ["iridium", /^iridium\b/],
  ["globalstar", /^globalstar\b/],
  ["orbcomm", /^orbcomm\b/],
  ["flock", /^flock\b/],
  ["lemur", /^lemur\b/],
  ["spacebee", /^spacebee\b/],
  ["kuiper", /^kuiper\b/],
  ["qianfan", /^(qianfan|g60)\b/],
  ["guowang", /^(guowang|gw[- ])/],
];

function constellationTag(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  for (const [tag, re] of CONSTELLATION_PATTERNS) if (re.test(n)) return tag;
  return null;
}

/** Both objects belong to the same mega-constellation family. */
function isSameConstellation(a: number, b: number, meta: Map<number, CatalogMeta>): boolean {
  const ta = constellationTag(meta.get(a)?.name);
  return ta != null && ta === constellationTag(meta.get(b)?.name);
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
      if (e.satno != null) map.set(e.satno, { launchTag: e.launchTag ?? null, ldate: e.ldate, name: e.name ?? e.plName ?? null, objectClass: e.objectClass ?? null });
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

    // Co-aligned (coplanar shadowing) screen: same plane + same radial shell,
    // slowly drifting in phase. The 30 km bubble rarely closes for these, so
    // they're flagged on geometry with loose range/velocity caps instead.
    const flaggedKeys = new Set(flagged.map((f) => pairKey(f.a, f.b)));
    let coCandidates = screenCoAlignedPairs(elsets, DEFAULT_COALIGNED, nowMs)
      .filter((p) => isPayloadPair(p.a.norad, p.b.norad, meta))
      .filter((p) => !isSameLaunch(p.a.norad, p.b.norad, meta))
      .filter((p) => !isSameConstellation(p.a.norad, p.b.norad, meta))
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
    const coFlagged: FlaggedPair[] = [];
    for (const { a, b } of coCandidates) {
      const ca = closeApproach(a, b, nowMs, DEFAULT_SCREEN.windowMs);
      if (!ca) continue;
      if (ca.minRangeKm <= COALIGNED_MAX_RANGE_KM && ca.relVelKmS <= COALIGNED_MAX_RELVEL_KM_S) {
        coFlagged.push({ a: a.norad, b: b.norad, minRangeKm: ca.minRangeKm, relVelKmS: ca.relVelKmS, tcaMs: ca.tcaMs });
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

    const coEvents = clusterPairs(coFlagged, MEMBER_CAP, COALIGNED_MERGE_WINDOW_MS);

    await persistEvents(events, "conjunction");
    await persistEvents(coEvents, "coplanar");
    await markStaleEvents();
    await retireDriftedCoplanarEvents();
    await logScanRow("success", started, events.length + coEvents.length);
    logger.info(
      {
        elsets: elsets.length,
        candidates: candidates.length,
        flaggedPairs: flagged.length,
        events: events.length,
        coCandidates: coCandidates.length,
        coplanarEvents: coEvents.length,
      },
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
 */
async function persistEvents(events: ReturnType<typeof clusterPairs>, kind: "conjunction" | "coplanar"): Promise<void> {
  if (events.length === 0) return;
  const active = await db.select().from(rpodEvents).where(and(eq(rpodEvents.status, "active"), eq(rpodEvents.kind, kind)));
  const activeMembers = active.length
    ? await db.select().from(rpodEventMembers).where(inArray(rpodEventMembers.eventId, active.map((e) => e.id)))
    : [];
  const membersByEvent = new Map<number, Set<number>>();
  for (const m of activeMembers) {
    const s = membersByEvent.get(m.eventId) ?? new Set<number>();
    s.add(m.norad);
    membersByEvent.set(m.eventId, s);
  }

  // Recently-ended coplanar cases stay eligible for reopening.
  let endedWithMembers: { id: number; endedAt: Date | null; members: number[] }[] = [];
  if (kind === "coplanar") {
    const ended = await db
      .select({ id: rpodEvents.id, endedAt: rpodEvents.endedAt, reopenCount: rpodEvents.reopenCount })
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
    endedWithMembers = ended.map((e) => ({ id: e.id, endedAt: e.endedAt, members: byId.get(e.id) ?? [] }));
  }

  for (const ev of events) {
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
      kind,
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

    let eventId: number;
    if (match) {
      await db.update(rpodEvents).set({ ...base, updatedAt: sql`now()` }).where(eq(rpodEvents.id, match.id));
      eventId = match.id;
      await db.delete(rpodEventMembers).where(eq(rpodEventMembers.eventId, eventId));
    } else {
      const reopenId = kind === "coplanar" ? selectReopenCandidate(endedWithMembers, ev.members, Date.now()) : null;
      if (reopenId != null) {
        // Same pair closed ranks again — reactivate the old case file.
        await db
          .update(rpodEvents)
          .set({
            ...base,
            endedAt: null,
            reopenCount: sql`${rpodEvents.reopenCount} + 1`,
            lastReopenedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(rpodEvents.id, reopenId));
        eventId = reopenId;
        await db.delete(rpodEventMembers).where(eq(rpodEventMembers.eventId, eventId));
        endedWithMembers = endedWithMembers.filter((e) => e.id !== reopenId);
        logger.info({ eventId }, "rpod-scan: reopened ended coplanar case (pair closed ranks again)");
      } else {
        const [row] = await db.insert(rpodEvents).values(base).returning({ id: rpodEvents.id });
        eventId = row.id;
      }
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
