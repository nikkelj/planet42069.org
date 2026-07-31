import * as satellite from "satellite.js";

/**
 * RPOD screening — deliberately rough, catalog-scale proximity detection.
 *
 * Stage 1 (cheap): pair candidates on matching orbital PLANES — inclination
 * close AND RAAN close (or converging within the look-ahead window, using
 * J2 nodal-precession rates) AND similar orbit size (mean motion).
 *
 * Stage 2 (expensive, survivors only): SGP4-propagate both objects over the
 * window, sample relative distance, refine the minimum → predicted
 * close-approach range, relative velocity, and TCA.
 *
 * Stage 3: cluster overlapping flagged pairs into multi-spacecraft events.
 */

export interface ScreenElset {
  norad: number;
  epochMs: number;
  line1: string;
  line2: string;
  incDeg: number;
  raanDeg: number;
  eccentricity: number;
  meanMotionRevPerDay: number;
}

export interface ScreenOptions {
  /** Max |Δinc| in degrees for a candidate pair. */
  maxIncDiffDeg: number;
  /** Max effective |ΔRAAN| (deg) at the closest point inside the window. */
  maxRaanDiffDeg: number;
  /** Max |Δ mean motion| in rev/day (orbit-size proximity). */
  maxMeanMotionDiff: number;
  /** Look-ahead window (ms) for RAAN convergence + SGP4 differencing. */
  windowMs: number;
}

export const DEFAULT_SCREEN: ScreenOptions = {
  maxIncDiffDeg: 0.6,
  maxRaanDiffDeg: 1.2,
  maxMeanMotionDiff: 0.35,
  windowMs: 48 * 3600_000,
};

/** Flag thresholds: proximity ops, not statistical conjunction screening. */
export const RPOD_MAX_RANGE_KM = 30;
export const RPOD_MAX_RELVEL_KM_S = 1.5;

const EARTH_R_KM = 6378.137;
const J2 = 1.08262668e-3;
const MU = 398600.4418; // km^3/s^2
const D2R = Math.PI / 180;

/** J2 secular nodal precession rate, deg/day. */
export function raanRateDegPerDay(e: Pick<ScreenElset, "incDeg" | "eccentricity" | "meanMotionRevPerDay">): number {
  const n = (e.meanMotionRevPerDay * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU / (n * n)); // km
  const p = a * (1 - e.eccentricity * e.eccentricity);
  if (p <= 0) return 0;
  const rate = -1.5 * n * J2 * (EARTH_R_KM / p) ** 2 * Math.cos(e.incDeg * D2R); // rad/s
  return (rate / D2R) * 86400;
}

function angDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Minimum |ΔRAAN| between two objects at any point in [0, windowMs],
 * assuming linear J2 drift. Captures both "already coplanar" and
 * "planes converging within the window".
 */
export function minRaanDiffDeg(a: ScreenElset, b: ScreenElset, windowMs: number): number {
  const d0 = angDiffDeg(a.raanDeg, b.raanDeg);
  const rateDiff = raanRateDegPerDay(a) - raanRateDegPerDay(b); // deg/day
  const days = windowMs / 86400_000;
  const d1 = angDiffDeg(a.raanDeg + raanRateDegPerDay(a) * days, b.raanDeg + raanRateDegPerDay(b) * days);
  // If the signed difference crosses zero inside the window the true min is 0-ish.
  const s0 = ((a.raanDeg - b.raanDeg + 540) % 360) - 180;
  const s1 = s0 + rateDiff * days;
  if (Math.sign(s0) !== Math.sign(s1) && Math.abs(s0) < 30 && Math.abs(s1) < 30) return 0;
  return Math.min(d0, d1);
}

export interface CandidatePair {
  a: ScreenElset;
  b: ScreenElset;
}

/**
 * Stage 1: cheap plane-matching screen over the whole catalog.
 * Buckets by inclination band to avoid the full N² comparison.
 */
export function screenCandidatePairs(elsets: ScreenElset[], opts: ScreenOptions = DEFAULT_SCREEN): CandidatePair[] {
  const bandSize = Math.max(opts.maxIncDiffDeg, 0.1);
  const bands = new Map<number, ScreenElset[]>();
  for (const e of elsets) {
    if (!Number.isFinite(e.meanMotionRevPerDay) || e.meanMotionRevPerDay < 0.5 || e.meanMotionRevPerDay > 20) continue;
    const band = Math.floor(e.incDeg / bandSize);
    for (const bIdx of [band, band + 1]) {
      const arr = bands.get(bIdx) ?? [];
      arr.push(e);
      bands.set(bIdx, arr);
    }
  }
  const pairs: CandidatePair[] = [];
  const seen = new Set<string>();
  for (const arr of bands.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        if (a.norad === b.norad) continue;
        const key = a.norad < b.norad ? `${a.norad}:${b.norad}` : `${b.norad}:${a.norad}`;
        if (seen.has(key)) continue;
        if (Math.abs(a.incDeg - b.incDeg) > opts.maxIncDiffDeg) continue;
        if (Math.abs(a.meanMotionRevPerDay - b.meanMotionRevPerDay) > opts.maxMeanMotionDiff) continue;
        if (minRaanDiffDeg(a, b, opts.windowMs) > opts.maxRaanDiffDeg) continue;
        seen.add(key);
        pairs.push({ a, b });
      }
    }
  }
  return pairs;
}

export interface CloseApproach {
  minRangeKm: number;
  relVelKmS: number;
  tcaMs: number;
}

type Vec3 = { x: number; y: number; z: number };

function dist(p: Vec3, q: Vec3): number {
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

/**
 * Stage 2: SGP4-difference a candidate pair over [startMs, startMs+windowMs].
 * Coarse 60s scan, then 1s refinement around the coarse minimum.
 * Returns null when either elset fails to propagate.
 */
export function closeApproach(
  a: Pick<ScreenElset, "line1" | "line2">,
  b: Pick<ScreenElset, "line1" | "line2">,
  startMs: number,
  windowMs: number,
): CloseApproach | null {
  const recA = satellite.twoline2satrec(a.line1, a.line2);
  const recB = satellite.twoline2satrec(b.line1, b.line2);
  const posAt = (rec: satellite.SatRec, ms: number): { p: Vec3; v: Vec3 } | null => {
    const pv = satellite.propagate(rec, new Date(ms));
    if (!pv || !pv.position || typeof pv.position === "boolean" || !pv.velocity || typeof pv.velocity === "boolean") return null;
    return { p: pv.position as Vec3, v: pv.velocity as Vec3 };
  };

  const COARSE_MS = 60_000;
  let bestT = -1;
  let bestD = Infinity;
  for (let t = startMs; t <= startMs + windowMs; t += COARSE_MS) {
    const pa = posAt(recA, t);
    const pb = posAt(recB, t);
    if (!pa || !pb) return null;
    const d = dist(pa.p, pb.p);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  if (bestT < 0) return null;

  // 1s refinement around the coarse minimum
  let refT = bestT;
  let refD = bestD;
  for (let t = bestT - COARSE_MS; t <= bestT + COARSE_MS; t += 1000) {
    const pa = posAt(recA, t);
    const pb = posAt(recB, t);
    if (!pa || !pb) continue;
    const d = dist(pa.p, pb.p);
    if (d < refD) { refD = d; refT = t; }
  }

  const pa = posAt(recA, refT);
  const pb = posAt(recB, refT);
  if (!pa || !pb) return null;
  const relVel = Math.hypot(pa.v.x - pb.v.x, pa.v.y - pb.v.y, pa.v.z - pb.v.z);
  return { minRangeKm: refD, relVelKmS: relVel, tcaMs: refT };
}

export interface FlaggedPair {
  a: number; // norad
  b: number;
  minRangeKm: number;
  relVelKmS: number;
  tcaMs: number;
}

export interface ClusteredEvent {
  members: number[]; // norads
  pairs: FlaggedPair[];
  minRangeKm: number;
  relVelKmS: number; // rel velocity at the tightest pair
  tcaMs: number;     // TCA of the tightest pair
  windowStartMs: number;
  windowEndMs: number;
  hitCap: boolean;
}

/**
 * Stage 3: merge flagged pairs into events. Pairs join the same event when
 * they share a participant AND their TCAs fall within `mergeWindowMs`.
 * Union-find with a member cap: clusters that grow past `memberCap`
 * are marked hitCap so the caller can run a widened neighborhood scan.
 */
export function clusterPairs(pairs: FlaggedPair[], memberCap = 5, mergeWindowMs = 6 * 3600_000): ClusteredEvent[] {
  // Union-find over PAIRS (not members): two flagged pairs belong to the same
  // event only when they share a participant AND their TCAs are within the
  // merge window. Unioning members directly would fuse temporally separate
  // operations involving the same craft into one bogus mega-event.
  const sorted = [...pairs].sort((p, q) => p.tcaMs - q.tcaMs);
  const parent = sorted.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    parent[x] = r;
    return r;
  };
  const union = (x: number, y: number) => { parent[find(x)] = find(y); };

  // Index pairs by participant so the join is O(pairs·pairsPerMember).
  const byMember = new Map<number, number[]>();
  sorted.forEach((p, i) => {
    for (const n of [p.a, p.b]) {
      const arr = byMember.get(n) ?? [];
      arr.push(i);
      byMember.set(n, arr);
    }
  });
  for (const idxs of byMember.values()) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const i = idxs[x], j = idxs[y];
        if (Math.abs(sorted[i].tcaMs - sorted[j].tcaMs) <= mergeWindowMs) union(i, j);
      }
    }
  }

  const groups = new Map<number, FlaggedPair[]>();
  sorted.forEach((p, i) => {
    const root = find(i);
    const arr = groups.get(root) ?? [];
    arr.push(p);
    groups.set(root, arr);
  });

  const events: ClusteredEvent[] = [];
  for (const ps of groups.values()) {
    const members = Array.from(new Set(ps.flatMap((p) => [p.a, p.b]))).sort((x, y) => x - y);
    const tightest = ps.reduce((m, p) => (p.minRangeKm < m.minRangeKm ? p : m), ps[0]);
    events.push({
      members,
      pairs: ps,
      minRangeKm: tightest.minRangeKm,
      relVelKmS: tightest.relVelKmS,
      tcaMs: tightest.tcaMs,
      windowStartMs: Math.min(...ps.map((p) => p.tcaMs)) - 30 * 60_000,
      windowEndMs: Math.max(...ps.map((p) => p.tcaMs)) + 30 * 60_000,
      hitCap: members.length >= memberCap,
    });
  }
  return events.sort((a, b) => a.minRangeKm - b.minRangeKm);
}
