import * as satellite from "satellite.js";
import {
  hasUsableTleLines, tleEpochIsCurrent, semiMajorAxisKm, yieldToEventLoop,
  RPOD_MAX_RANGE_KM, RPOD_MAX_RELVEL_KM_S, type ScreenElset, type FlaggedPair,
} from "./screen";

/**
 * Crossing-track watch screen.
 *
 * Stage 1 of the hourly scan only pairs objects in matching PLANES
 * (Δinc ≤ 0.6°, ΔRAAN ≤ 1.2°), and stage 2 drops anything closing faster
 * than 1.5 km/s. That is right for slow co-orbital RPOD, but it can never
 * see a watched inspector (e.g. the Kosmos 2610–2614 pack) sweeping
 * through another operator's satellite on a crossing plane — Kosmos-2610 vs
 * ICEYE-X6 has ΔRAAN ≈ 220° and closes at ~14 km/s. Those passes never
 * became candidates, so the board showed nothing while independent SGP4
 * screens found 0.3 km and 1.3 km approaches.
 *
 * Here every WATCHED object is screened against every other fresh elset
 * whose perigee/apogee band overlaps it, with no plane or relative-velocity
 * gate, over a longer look-ahead. Sampling is fine enough for 15 km/s
 * crossings: a coarse grid finds every local minimum, then a golden-section
 * search refines each candidate to milliseconds. The 60 s grid + 1 s refine
 * used by closeApproach misses or mis-ranges these passes (at 14 km/s one
 * second is 14 km, and the global coarse minimum is often a different orbit).
 */

/** Default watch list: the Kosmos 2610–2614 inspector pack. Extend with RPOD_WATCH_NORADS. */
export const DEFAULT_WATCH_NORADS: readonly number[] = [68758, 68759, 68762, 68763, 68764];

export const CROSSING_WINDOW_MS = 72 * 3600_000;
export const CROSSING_STEP_MS = 20_000;
/** Max relative speed considered when deciding which sampled minima to refine (km/s). */
const MAX_REL_SPEED_KM_S = 16;
/** Extra radial slack on the perigee/apogee overlap test (drag, SGP4 vs mean elements). */
const RADIAL_SLACK_KM = 25;

export function parseWatchNorads(env: string | undefined): number[] {
  const out = new Set<number>(DEFAULT_WATCH_NORADS);
  for (const tok of (env ?? "").split(/[\s,]+/)) {
    const n = parseInt(tok, 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return [...out];
}

type Rec = { e: ScreenElset; rec: satellite.SatRec; lo: number; hi: number };

function prepare(e: ScreenElset, nowMs: number): Rec | null {
  if (!hasUsableTleLines(e) || !tleEpochIsCurrent(e.line1, nowMs)) return null;
  if (!Number.isFinite(e.meanMotionRevPerDay) || e.meanMotionRevPerDay < 0.5 || e.meanMotionRevPerDay > 20) return null;
  try {
    const rec = satellite.twoline2satrec(e.line1, e.line2);
    const a = semiMajorAxisKm(e.meanMotionRevPerDay);
    const ecc = Number.isFinite(e.eccentricity) ? e.eccentricity : 0;
    return { e, rec, lo: a * (1 - ecc), hi: a * (1 + ecc) };
  } catch {
    return null;
  }
}

function pv(rec: satellite.SatRec, ms: number): { p: satellite.EciVec3<number>; v: satellite.EciVec3<number> } | null {
  const r = satellite.propagate(rec, new Date(ms));
  if (!r || typeof r.position === "boolean" || typeof r.velocity === "boolean" || !r.position || !r.velocity) return null;
  const { x, y, z } = r.position;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { p: r.position, v: r.velocity };
}

function grid(rec: satellite.SatRec, startMs: number, steps: number, stepMs: number): Float64Array {
  const out = new Float64Array(steps * 3).fill(NaN);
  for (let k = 0; k < steps; k++) {
    const s = pv(rec, startMs + k * stepMs);
    if (!s) continue;
    out[3 * k] = s.p.x; out[3 * k + 1] = s.p.y; out[3 * k + 2] = s.p.z;
  }
  return out;
}

function rangeAt(a: satellite.SatRec, b: satellite.SatRec, ms: number): number {
  const pa = pv(a, ms), pb = pv(b, ms);
  if (!pa || !pb) return Infinity;
  return Math.hypot(pa.p.x - pb.p.x, pa.p.y - pb.p.y, pa.p.z - pb.p.z);
}

/** Golden-section minimum of range on [lo, hi] (ms), to ~1 ms. */
export function refineMinimum(a: satellite.SatRec, b: satellite.SatRec, lo: number, hi: number): { t: number; d: number } {
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
  let f1 = rangeAt(a, b, x1), f2 = rangeAt(a, b, x2);
  while (hi - lo > 1) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = rangeAt(a, b, x1); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = rangeAt(a, b, x2); }
  }
  return f1 < f2 ? { t: x1, d: f1 } : { t: x2, d: f2 };
}

export interface CrossingOptions {
  maxRangeKm: number;
  windowMs: number;
  stepMs: number;
  deadlineMs?: number;
}

export const DEFAULT_CROSSING: CrossingOptions = {
  maxRangeKm: RPOD_MAX_RANGE_KM,
  windowMs: CROSSING_WINDOW_MS,
  stepMs: CROSSING_STEP_MS,
};

/**
 * Tightest approach per (watched, other) pair inside [nowMs, nowMs+windowMs]
 * that comes within maxRangeKm. No plane or relative-velocity gate.
 */
export async function screenWatchCrossings(
  watchNorads: readonly number[],
  elsets: ScreenElset[],
  nowMs: number,
  opts: CrossingOptions = DEFAULT_CROSSING,
): Promise<FlaggedPair[]> {
  const watchSet = new Set(watchNorads);
  const recs: Rec[] = [];
  for (const e of elsets) { const r = prepare(e, nowMs); if (r) recs.push(r); }
  const watched = recs.filter((r) => watchSet.has(r.e.norad));
  if (watched.length === 0) return [];
  const steps = Math.floor(opts.windowMs / opts.stepMs) + 1;
  const gate = opts.maxRangeKm + (MAX_REL_SPEED_KM_S * opts.stepMs) / 2000;
  const wGrid = watched.map((w) => grid(w.rec, nowMs, steps, opts.stepMs));
  const best = new Map<string, FlaggedPair>();
  let n = 0;
  for (const o of recs) {
    const overlaps = watched.map((w) => w.e.norad !== o.e.norad
      && o.lo <= w.hi + opts.maxRangeKm + RADIAL_SLACK_KM
      && w.lo <= o.hi + opts.maxRangeKm + RADIAL_SLACK_KM);
    if (!overlaps.some(Boolean)) continue;
    if (opts.deadlineMs != null && Date.now() > opts.deadlineMs) throw new Error("rpod-scan timed out during crossing screen");
    if (++n % 50 === 0) await yieldToEventLoop();
    const oGrid = grid(o.rec, nowMs, steps, opts.stepMs);
    for (let wi = 0; wi < watched.length; wi++) {
      if (!overlaps[wi]) continue;
      const W = wGrid[wi];
      const d = (k: number) => Math.hypot(W[3 * k] - oGrid[3 * k], W[3 * k + 1] - oGrid[3 * k + 1], W[3 * k + 2] - oGrid[3 * k + 2]);
      let prev = d(0), cur = d(1);
      for (let k = 1; k < steps - 1; k++) {
        const next = d(k + 1);
        if (cur <= gate && cur <= prev && cur <= next) {
          const t0 = nowMs + (k - 1) * opts.stepMs, t1 = nowMs + (k + 1) * opts.stepMs;
          const r = refineMinimum(watched[wi].rec, o.rec, t0, t1);
          if (r.d <= opts.maxRangeKm) {
            const pa = pv(watched[wi].rec, r.t), pb = pv(o.rec, r.t);
            if (pa && pb) {
              const rel = Math.hypot(pa.v.x - pb.v.x, pa.v.y - pb.v.y, pa.v.z - pb.v.z);
              const a = watched[wi].e.norad, b = o.e.norad;
              const key = a < b ? `${a}:${b}` : `${b}:${a}`;
              const prior = best.get(key);
              if (!prior || r.d < prior.minRangeKm) {
                best.set(key, { a: Math.min(a, b), b: Math.max(a, b), minRangeKm: r.d, relVelKmS: rel, tcaMs: Math.round(r.t) });
              }
            }
          }
        }
        prev = cur; cur = next;
      }
    }
  }
  return [...best.values()].sort((x, y) => x.minRangeKm - y.minRangeKm);
}

/**
 * Slow passes (≤ RPOD_MAX_RELVEL_KM_S) are real proximity ops and keep the
 * full 30 km bubble. Fast crossings happen hundreds of times a week inside
 * 30 km for a five-satellite pack, so by default they persist only inside
 * CROSSING_FAST_MAX_KM. Override with RPOD_CROSSING_MAX_KM (e.g. "30").
 */
export const CROSSING_FAST_MAX_KM = 5;

export function crossingPairIsReportable(p: FlaggedPair, envMaxKm?: string): boolean {
  if (p.relVelKmS <= RPOD_MAX_RELVEL_KM_S) return p.minRangeKm <= RPOD_MAX_RANGE_KM;
  const env = envMaxKm != null && envMaxKm !== "" ? Number(envMaxKm) : NaN;
  const cap = Number.isFinite(env) && env > 0 ? Math.min(env, RPOD_MAX_RANGE_KM) : CROSSING_FAST_MAX_KM;
  return p.minRangeKm <= cap;
}
