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

/**
 * Co-aligned (coplanar shadowing) screen: objects sharing a plane AND a
 * radial shell, drifting slowly in phase. These encounters last weeks or
 * months and the 30 km bubble may close only rarely — so they are flagged
 * on geometry, with a loose range/velocity sanity cap applied by the caller.
 *
 * Calibrated on a known long-running shadowing demo (Δinc 0.073°,
 * ΔRAAN 0.061°, Δa 5.4 km, in-track ~175 km) and then widened a little.
 */
export interface CoAlignedOptions {
  maxIncDiffDeg: number;
  maxRaanDiffDeg: number;
  /** Extra margin (km) added to each object's radial shell [perigee, apogee]. */
  radialMarginKm: number;
  /**
   * Max along-track phase separation (deg of mean argument of latitude) at
   * the closest point inside the window. This is THE discriminator: a
   * shadower rides a few hundred km ahead/behind, while random co-planar
   * catalog objects are spread around the whole orbit. 6° ≈ 720 km in LEO.
   */
  maxPhaseDiffDeg: number;
  /** Window (ms) over which the phase gate looks for the minimum. */
  windowMs: number;
}

export const DEFAULT_COALIGNED: CoAlignedOptions = {
  maxIncDiffDeg: 0.15,
  maxRaanDiffDeg: 0.15,
  radialMarginKm: 3,
  maxPhaseDiffDeg: 6,
  windowMs: 48 * 3600_000,
};

/** Loose caps for co-aligned pairs (applied after SGP4 differencing). */
export const COALIGNED_MAX_RANGE_KM = 250;
export const COALIGNED_MAX_RELVEL_KM_S = 0.6;

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
 *
 * `rateA` / `rateB` are `raanRateDegPerDay` for the two elsets. Callers that
 * screen a whole shell precompute those once; doing it per pair is four
 * cbrt/trig evaluations and dominated the hourly scan.
 */
export function minRaanDiffDeg(
  a: Pick<ScreenElset, "raanDeg" | "incDeg" | "eccentricity" | "meanMotionRevPerDay">,
  b: Pick<ScreenElset, "raanDeg" | "incDeg" | "eccentricity" | "meanMotionRevPerDay">,
  windowMs: number,
  rateA: number = raanRateDegPerDay(a),
  rateB: number = raanRateDegPerDay(b),
): number {
  const d0 = angDiffDeg(a.raanDeg, b.raanDeg);
  const rateDiff = rateA - rateB; // deg/day
  const days = windowMs / 86400_000;
  const d1 = angDiffDeg(a.raanDeg + rateA * days, b.raanDeg + rateB * days);
  // If the signed difference crosses zero inside the window the true min is 0-ish.
  const s0 = ((a.raanDeg - b.raanDeg + 540) % 360) - 180;
  const s1 = s0 + rateDiff * days;
  if (Math.sign(s0) !== Math.sign(s1) && Math.abs(s0) < 30 && Math.abs(s1) < 30) return 0;
  return Math.min(d0, d1);
}

/** RAAN in [0, 360). Screening windows are circular; catalog values sometimes aren't. */
function normRaanDeg(deg: number): number {
  const x = deg % 360;
  return x < 0 ? x + 360 : x;
}

/**
 * Extra degrees added to a RAAN search window so float error cannot drop a
 * pair that sits exactly on the drift bound. The numeric gates still run
 * after the window, so a slightly wide window never creates a false hit.
 */
const RAAN_WINDOW_SLACK_DEG = 1e-3;

function usableScreenElset(e: ScreenElset): boolean {
  return Number.isFinite(e.incDeg)
    && Number.isFinite(e.raanDeg)
    && Number.isFinite(e.eccentricity)
    && Number.isFinite(e.meanMotionRevPerDay)
    && e.meanMotionRevPerDay >= 0.5
    && e.meanMotionRevPerDay <= 20;
}

/**
 * Visit index pairs whose normalized RAAN separation along the short arc
 * might be <= `windowDeg`. `windowDeg` >= 180 visits every pair.
 *
 * The visitor is synchronous. `onTick` runs every `yieldEvery` comparisons
 * so HTTP can flush, without allocating a promise per pair. A full walk of
 * one Starlink shell is tens of millions of visits; an async visitor per
 * visit is the GC pattern that blew the 25-minute scan cap.
 *
 * `seeds`, when set, only visits pairs that include one of those indexes
 * (widened rescreen around an event). Otherwise each unordered pair is
 * visited once.
 */
async function visitRaanPairs(
  raanDeg: number[],
  idxs: number[],
  windowDeg: number,
  visit: (i: number, j: number) => void,
  yieldEvery: number,
  onTick: () => void | Promise<void>,
  seeds?: number[],
): Promise<void> {
  const n = idxs.length;
  if (n < 2) return;
  const order = idxs.slice().sort((i, j) => raanDeg[i] - raanDeg[j] || i - j);
  const pos = new Map<number, number>();
  for (let p = 0; p < n; p++) pos.set(order[p], p);

  let compared = 0;
  // Sync hit + await only on the yield stride. An async wrapper here would
  // allocate a promise per comparison.
  const hit = (i: number, j: number): boolean => {
    if (i === j) return false;
    visit(i, j);
    compared++;
    return yieldEvery > 0 && compared % yieldEvery === 0;
  };

  if (seeds) {
    if (seeds.length === 0) return;
    const seedSet = new Set(seeds);
    if (!(windowDeg < 180)) {
      for (const i of seeds) {
        if (!pos.has(i)) continue;
        for (const j of idxs) {
          if (j === i) continue;
          if (seedSet.has(j) && j < i) continue;
          if (hit(i, j)) await onTick();
        }
      }
      return;
    }
    for (const i of seeds) {
      const p = pos.get(i);
      if (p == null) continue;
      const ra = raanDeg[i];
      for (let k = p + 1; k < n; k++) {
        if (raanDeg[order[k]] - ra > windowDeg) break;
        if (hit(i, order[k])) await onTick();
      }
      for (let k = p - 1; k >= 0; k--) {
        if (ra - raanDeg[order[k]] > windowDeg) break;
        if (hit(i, order[k])) await onTick();
      }
      const wrapHi = ra + windowDeg - 360;
      if (wrapHi >= 0) {
        for (let k = 0; k < p; k++) {
          if (raanDeg[order[k]] > wrapHi) break;
          if (hit(i, order[k])) await onTick();
        }
      }
      if (ra - windowDeg < 0) {
        const wrapLo = ra - windowDeg + 360;
        for (let k = n - 1; k > p; k--) {
          if (raanDeg[order[k]] < wrapLo) break;
          if (hit(i, order[k])) await onTick();
        }
      }
    }
    return;
  }

  if (!(windowDeg < 180)) {
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        if (hit(order[a], order[b])) await onTick();
      }
    }
    return;
  }
  for (let left = 0; left < n; left++) {
    const ra = raanDeg[order[left]];
    for (let k = left + 1; k < n; k++) {
      if (raanDeg[order[k]] - ra > windowDeg) break;
      if (hit(order[left], order[k])) await onTick();
    }
    const wrapLimit = ra + windowDeg - 360;
    if (wrapLimit < 0) continue;
    for (let k = 0; k < left; k++) {
      if (raanDeg[order[k]] > wrapLimit) break;
      if (hit(order[left], order[k])) await onTick();
    }
  }
}

function medianNumber(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface CandidatePair {
  a: ScreenElset;
  b: ScreenElset;
}

/** Let HTTP (e.g. GET /rpod/status) run during CPU-bound screening / SGP4. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Comparisons between event-loop yields in stage-1 screening.
 * Neighbor windows cut the Starlink shell down a lot, but a slow autoscale
 * box still needs to yield so GET /api/rpod/status can flush.
 */
export const SCREEN_YIELD_EVERY = 4_000;

/**
 * Objects whose nodal rates over the screen window stay inside this many
 * degrees of the bin median are one family and use a thin RAAN window.
 * A single high-eccentricity elset in an otherwise tight mean-motion bin
 * used to set the window from the whole bin's rate span (tens to hundreds
 * of degrees) and reopen the full Starlink pair walk.
 */
export const MAX_CORE_RATE_SPAN_DEG = 2;

/** Wall-clock cap for one closeApproach (coarse + refine). Pathological
 *  deep-space dspace steps from a shifted TLE epoch used to run for tens of
 *  seconds on a single pair. */
export const MAX_SGP4_PAIR_MS = 2_000;

/**
 * Stage 1: cheap plane-matching screen over the whole catalog.
 * Buckets by inclination, then by mean motion, then only walks RAAN
 * neighbors that J2 drift could still bring inside the gate.
 *
 * A full pair walk of one Starlink shell (~5k sats at 53.2°, all inside
 * one 0.6° inclination band and one 0.35 rev/day mean-motion bin) is
 * ~1.3e7 pairs, and each object is also copied into the adjacent band.
 * On the live catalog that was ~5.2e7 pair-key allocations before the
 * RAAN test. That fits in a few seconds on a roomy box and blows the
 * 25-minute scan cap on the autoscale instance (GC of the pair keys plus
 * four raan-rate evaluations per pair). Relative nodal drift inside a
 * healthy mean-motion bin is well under a degree over the 48h window, so
 * the RAAN window drops the shell to a thin neighbor strip without
 * changing which pairs pass the numeric gates. The window is the core
 * family's rate span, not the whole bin: one high-eccentricity elset
 * (e≈0.9 at Starlink mean motion is ~60°+ of drift) would otherwise
 * reopen that full walk for the hour.
 *
 * Pass yieldEvery > 0 (SCREEN_YIELD_EVERY in the worker) so HTTP can run.
 *
 * `anchorNorads`, when set, only visits pairs that include one of those
 * catalog numbers. The widened cluster rescreen uses this so a 5-member
 * event does not all-pairs the surrounding shell.
 */
export async function screenCandidatePairs(
  elsets: ScreenElset[],
  opts: ScreenOptions = DEFAULT_SCREEN,
  yieldEvery: number = 0,
  deadlineMs?: number,
  anchorNorads?: ReadonlySet<number>,
): Promise<CandidatePair[]> {
  const bandSize = Math.max(opts.maxIncDiffDeg, 0.1);
  const bands = new Map<number, ScreenElset[]>();
  for (const e of elsets) {
    if (!usableScreenElset(e)) continue;
    const band = Math.floor(e.incDeg / bandSize);
    for (const bIdx of [band, band + 1]) {
      const arr = bands.get(bIdx) ?? [];
      arr.push(e);
      bands.set(bIdx, arr);
    }
  }
  const pairs: CandidatePair[] = [];
  const seen = new Set<string>();
  const onTick = async (): Promise<void> => {
    if (deadlineMs != null && Date.now() > deadlineMs) throw new Error("rpod-scan timed out during screening");
    await yieldToEventLoop();
  };
  const accept = (arr: ScreenElset[], rates: number[], i: number, j: number): void => {
    const a = arr[i];
    const b = arr[j];
    if (a.norad === b.norad) return;
    if (Math.abs(a.incDeg - b.incDeg) > opts.maxIncDiffDeg) return;
    if (Math.abs(a.meanMotionRevPerDay - b.meanMotionRevPerDay) > opts.maxMeanMotionDiff) return;
    if (minRaanDiffDeg(a, b, opts.windowMs, rates[i], rates[j]) > opts.maxRaanDiffDeg) return;
    const key = a.norad < b.norad ? `${a.norad}:${b.norad}` : `${b.norad}:${a.norad}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ a, b });
  };

  const days = opts.windowMs / 86400_000;
  const mmBin = opts.maxMeanMotionDiff;
  const halfCore = MAX_CORE_RATE_SPAN_DEG / 2;
  for (const arr of bands.values()) {
    const n = arr.length;
    if (n < 2) continue;
    const rates = new Array<number>(n);
    const raan = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      rates[i] = raanRateDegPerDay(arr[i]);
      raan[i] = normRaanDeg(arr[i].raanDeg);
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const b = mmBin > 0 ? Math.floor(arr[i].meanMotionRevPerDay / mmBin) : 0;
      const slots = mmBin > 0 ? [b, b + 1] : [0];
      for (const id of slots) {
        const g = groups.get(id);
        if (g) g.push(i);
        else groups.set(id, [i]);
      }
    }
    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue;
      let rMin = Infinity;
      let rMax = -Infinity;
      for (const i of idxs) {
        const r = rates[i];
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
      }
      const rateDriftDeg = (rate: number): number => {
        if (!Number.isFinite(rMin) || !Number.isFinite(rMax) || !Number.isFinite(rate)) return 180;
        return Math.max(Math.abs(rate - rMin), Math.abs(rate - rMax)) * days;
      };
      // Linear drift of at most `drift` degrees cannot close a larger gap
      // than maxRaan + drift (the 30° zero-cross rule is inside that, because
      // a crossing needs |drift| >= |ΔRAAN|). Slack covers float error.
      const windowFor = (drift: number) => opts.maxRaanDiffDeg + drift + RAAN_WINDOW_SLACK_DEG;
      const visit = (i: number, j: number) => accept(arr, rates, i, j);

      if (anchorNorads) {
        const seeds = idxs.filter((i) => anchorNorads.has(arr[i].norad));
        if (seeds.length === 0) continue;
        let drift = 0;
        for (const i of seeds) {
          const d = rateDriftDeg(rates[i]);
          if (d > drift) drift = d;
        }
        await visitRaanPairs(raan, idxs, windowFor(drift), visit, yieldEvery, onTick, seeds);
        continue;
      }

      const med = medianNumber(idxs.map((i) => rates[i]));
      const core: number[] = [];
      const outliers: number[] = [];
      for (const i of idxs) {
        const span = Math.abs(rates[i] - med) * days;
        if (Number.isFinite(span) && span <= halfCore) core.push(i);
        else outliers.push(i);
      }
      if (core.length >= 2) {
        let cMin = Infinity;
        let cMax = -Infinity;
        for (const i of core) {
          const r = rates[i];
          if (r < cMin) cMin = r;
          if (r > cMax) cMax = r;
        }
        const coreDrift = Number.isFinite(cMin) && Number.isFinite(cMax) ? (cMax - cMin) * days : 0;
        await visitRaanPairs(raan, core, windowFor(coreDrift), visit, yieldEvery, onTick);
      }
      for (const i of outliers) {
        await visitRaanPairs(raan, idxs, windowFor(rateDriftDeg(rates[i])), visit, yieldEvery, onTick, [i]);
      }
    }
  }
  return pairs;
}

/** Semi-major axis (km) from mean motion (rev/day). */
export function semiMajorAxisKm(meanMotionRevPerDay: number): number {
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86400; // rad/s
  return Math.cbrt(MU / (n * n));
}

/** Fixed-width TLE lines are 69 chars; satellite.js reads through column 63. */
export function hasUsableTleLines(e: Pick<ScreenElset, "line1" | "line2">): boolean {
  return typeof e.line1 === "string" && typeof e.line2 === "string"
    && e.line1.length >= 68 && e.line2.length >= 68
    && e.line1.startsWith("1") && e.line2.startsWith("2");
}

/**
 * How far the TLE-line epoch may sit from the propagate start time.
 * JSON EPOCH and TLE columns can disagree (6-digit catalog numbers shift
 * the fixed-width fields). satellite.js deep-space resonance then integrates
 * in 720-minute steps from the *line* epoch — decades of steps hang the
 * Node event loop and starve HTTP (live /api/rpod/status 20s / 0 bytes).
 */
export const MAX_SGP4_EPOCH_AGE_MS = 10 * 86400_000;

/** Epoch encoded in TLE line 1 columns 19–32 (YY + day-of-year). */
export function tleEpochMs(line1: string): number | null {
  if (typeof line1 !== "string" || line1.length < 32) return null;
  const yr = parseInt(line1.substring(18, 20), 10);
  const days = parseFloat(line1.substring(20, 32));
  if (!Number.isFinite(yr) || yr < 0 || yr > 99) return null;
  if (!Number.isFinite(days) || days < 1 || days >= 367) return null;
  const year = yr < 57 ? 2000 + yr : 1900 + yr;
  const ms = Date.UTC(year, 0, 1) + (days - 1) * 86400_000;
  return Number.isFinite(ms) ? ms : null;
}

export function tleEpochIsCurrent(line1: string, nowMs: number, maxAgeMs: number = MAX_SGP4_EPOCH_AGE_MS): boolean {
  const epoch = tleEpochMs(line1);
  return epoch != null && Math.abs(epoch - nowMs) <= maxAgeMs;
}

/** Mean argument of latitude (argp + mean anomaly, deg) parsed from TLE line 2. */
function meanArgLatDeg(e: ScreenElset): number | null {
  if (typeof e.line2 !== "string" || e.line2.length < 51) return null;
  const argp = parseFloat(e.line2.slice(34, 42));
  const ma = parseFloat(e.line2.slice(43, 51));
  if (!Number.isFinite(argp) || !Number.isFinite(ma)) return null;
  return (argp + ma) % 360;
}

/**
 * Minimum along-track phase separation (deg) between two objects at any
 * point in [now, now+windowMs], propagating each mean argument of latitude
 * at its own mean motion (linear drift model, J2 argp precession cancels
 * for near-identical planes).
 */
export function minPhaseDiffDeg(a: ScreenElset, b: ScreenElset, nowMs: number, windowMs: number): number {
  const ua0 = meanArgLatDeg(a);
  const ub0 = meanArgLatDeg(b);
  if (ua0 == null || ub0 == null) return Infinity;
  const degPerMs = (mm: number) => (mm * 360) / 86400_000;
  const ua = ua0 + degPerMs(a.meanMotionRevPerDay) * (nowMs - a.epochMs);
  const ub = ub0 + degPerMs(b.meanMotionRevPerDay) * (nowMs - b.epochMs);
  const rate = degPerMs(a.meanMotionRevPerDay) - degPerMs(b.meanMotionRevPerDay); // deg/ms
  const d0 = ((ua - ub) % 360 + 540) % 360 - 180; // signed, [-180, 180)
  // Signed drift over the window; if it crosses zero, the min is ~0.
  const d1 = d0 + rate * windowMs;
  if (Math.sign(d0) !== Math.sign(d1) && Math.abs(rate * windowMs) < 360) return 0;
  return Math.min(Math.abs(d0), Math.abs(((d1 % 360) + 540) % 360 - 180));
}

/**
 * Extra degrees of mean-argument slack for differential apsidal drift and
 * the gap between argument-of-latitude and inertial along-track. Kept
 * loose on purpose: a wrong skip drops a real close approach, a loose
 * gate only sends a few more pairs to SGP4.
 */
export const PHASE_MODEL_SLACK_DEG = 2;

/**
 * True when along-track phase stays too wide for the pair to enter
 * `maxRangeKm` during the window, so stage-2 SGP4 can skip it.
 *
 * Stage-1 matches planes only. Every pair inside a Starlink plane survives
 * it (RAAN is shared), and the 1,200-pair SGP4 cap then propagates objects
 * that are still thousands of km apart. Range is at least the along-track
 * separation, so a pair whose mean arguments never get close cannot be a
 * conjunction, a near-miss, or a cluster.
 *
 * Fail open (return false → keep the pair) when the linear phase model is
 * not trustworthy: unparsable mean argument, equatorial orbits (the node
 * is ill-conditioned), or a non-finite semi-major axis. `planeSlackDeg`
 * is the screened plane gate (ΔRAAN + Δinc); planes that still differ by
 * that much can be inside the bubble at a slightly larger phase offset.
 */
export function alongTrackRulesOutRange(
  a: ScreenElset,
  b: ScreenElset,
  nowMs: number,
  windowMs: number,
  maxRangeKm: number,
  planeSlackDeg: number,
): boolean {
  if (a.incDeg < 5 || b.incDeg < 5 || a.incDeg > 175 || b.incDeg > 175) return false;
  const phase = minPhaseDiffDeg(a, b, nowMs, windowMs);
  if (!Number.isFinite(phase)) return false;
  const aKm = Math.min(
    semiMajorAxisKm(a.meanMotionRevPerDay),
    semiMajorAxisKm(b.meanMotionRevPerDay),
  );
  if (!Number.isFinite(aKm) || aKm < 100) return false;
  const rangeDeg = (maxRangeKm / aKm) * (180 / Math.PI);
  const eccDeg = 2 * (Math.abs(a.eccentricity) + Math.abs(b.eccentricity)) * (180 / Math.PI);
  const limit = rangeDeg + eccDeg + Math.max(0, planeSlackDeg) + PHASE_MODEL_SLACK_DEG;
  return phase > limit;
}

/**
 * Cheap co-aligned screen: Δinc and current ΔRAAN within tight plane bounds,
 * radial shells [a(1-e), a(1+e)] ± margin overlapping, AND along-track phase
 * within a few degrees at some point in the window. No convergence
 * logic — shadowers are already co-planar, not drifting in.
 */
export async function screenCoAlignedPairs(
  elsets: ScreenElset[],
  opts: CoAlignedOptions = DEFAULT_COALIGNED,
  nowMs: number = Date.now(),
  yieldEvery: number = 0,
  deadlineMs?: number,
): Promise<CandidatePair[]> {
  const bandSize = Math.max(opts.maxIncDiffDeg, 0.1);
  const bands = new Map<number, ScreenElset[]>();
  for (const e of elsets) {
    if (!usableScreenElset(e)) continue;
    const band = Math.floor(e.incDeg / bandSize);
    for (const bIdx of [band, band + 1]) {
      const arr = bands.get(bIdx) ?? [];
      arr.push(e);
      bands.set(bIdx, arr);
    }
  }
  const pairs: CandidatePair[] = [];
  const seen = new Set<string>();
  const onTick = async (): Promise<void> => {
    if (deadlineMs != null && Date.now() > deadlineMs) throw new Error("rpod-scan timed out during co-aligned screen");
    await yieldToEventLoop();
  };
  // No convergence term: shadowers are already co-planar. The RAAN gate is
  // the current separation, so the neighbor window is that gate plus slack.
  const window = opts.maxRaanDiffDeg + RAAN_WINDOW_SLACK_DEG;
  for (const arr of bands.values()) {
    const n = arr.length;
    if (n < 2) continue;
    const raan = new Array<number>(n);
    const idxs = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      raan[i] = normRaanDeg(arr[i].raanDeg);
      idxs[i] = i;
    }
    await visitRaanPairs(raan, idxs, window, (i, j) => {
      const a = arr[i];
      const b = arr[j];
      if (a.norad === b.norad) return;
      if (Math.abs(a.incDeg - b.incDeg) > opts.maxIncDiffDeg) return;
      if (angDiffDeg(a.raanDeg, b.raanDeg) > opts.maxRaanDiffDeg) return;
      const aa = semiMajorAxisKm(a.meanMotionRevPerDay);
      const ab = semiMajorAxisKm(b.meanMotionRevPerDay);
      const loA = aa * (1 - a.eccentricity) - opts.radialMarginKm;
      const hiA = aa * (1 + a.eccentricity) + opts.radialMarginKm;
      const loB = ab * (1 - b.eccentricity) - opts.radialMarginKm;
      const hiB = ab * (1 + b.eccentricity) + opts.radialMarginKm;
      if (loA > hiB || loB > hiA) return;
      if (minPhaseDiffDeg(a, b, nowMs, opts.windowMs) > opts.maxPhaseDiffDeg) return;
      const key = a.norad < b.norad ? `${a.norad}:${b.norad}` : `${b.norad}:${a.norad}`;
      if (seen.has(key)) return;
      seen.add(key);
      pairs.push({ a, b });
    }, yieldEvery, onTick);
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

function isFiniteVec3(v: unknown): v is Vec3 {
  if (!v || typeof v !== "object") return false;
  const o = v as Vec3;
  return Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);
}

/**
 * Stage 2: SGP4-difference a candidate pair over [startMs, startMs+windowMs].
 * Coarse 60s scan, then 1s refinement around the coarse minimum.
 * Returns null when either elset fails to propagate.
 *
 * Must never throw: twoline2satrec throws TypeError on null/undefined lines,
 * and satellite.js 7 can return {x:null,y:null,z:null} for unusable TLEs
 * (null coerces to 0 in Math.hypot → fake 0 km "docked" hits). One bad
 * catalog row must skip the pair, not fail the hourly scan.
 */
export function closeApproach(
  a: Pick<ScreenElset, "line1" | "line2">,
  b: Pick<ScreenElset, "line1" | "line2">,
  startMs: number,
  windowMs: number,
): CloseApproach | null {
  try {
    if (!hasUsableTleLines(a) || !hasUsableTleLines(b)) return null;
    if (!tleEpochIsCurrent(a.line1, startMs) || !tleEpochIsCurrent(b.line1, startMs)) return null;
    const recA = satellite.twoline2satrec(a.line1, a.line2);
    const recB = satellite.twoline2satrec(b.line1, b.line2);
    const posAt = (rec: satellite.SatRec, ms: number): { p: Vec3; v: Vec3 } | null => {
      const pv = satellite.propagate(rec, new Date(ms));
      if (!pv || typeof pv.position === "boolean" || typeof pv.velocity === "boolean") return null;
      if (!isFiniteVec3(pv.position) || !isFiniteVec3(pv.velocity)) return null;
      return { p: pv.position, v: pv.velocity };
    };

    const COARSE_MS = 60_000;
    const t0 = Date.now();
    let bestT = -1;
    let bestD = Infinity;
    for (let t = startMs; t <= startMs + windowMs; t += COARSE_MS) {
      if (Date.now() - t0 > MAX_SGP4_PAIR_MS) return null;
      const pa = posAt(recA, t);
      const pb = posAt(recB, t);
      // Skip unpropagable samples (decayed, bad TLE) rather than aborting the
      // whole pair — a single failed 60s step used to discard real approaches.
      if (!pa || !pb) continue;
      const d = dist(pa.p, pb.p);
      if (d < bestD) { bestD = d; bestT = t; }
    }
    if (bestT < 0 || !Number.isFinite(bestD)) return null;

    // 1s refinement around the coarse minimum
    let refT = bestT;
    let refD = bestD;
    for (let t = bestT - COARSE_MS; t <= bestT + COARSE_MS; t += 1000) {
      if (Date.now() - t0 > MAX_SGP4_PAIR_MS) break;
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
    if (!Number.isFinite(relVel) || !Number.isFinite(refD) || !Number.isFinite(refT)) return null;
    return { minRangeKm: refD, relVelKmS: relVel, tcaMs: refT };
  } catch {
    return null;
  }
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
