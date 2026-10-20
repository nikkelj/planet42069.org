import { semiMajorAxisKm } from "./screen";

/**
 * A burn is an element change too large for drag between two archived elsets
 * of the same object: semi-major axis, or inclination (the plane). RAAN is
 * not used — it precesses degrees per day in LEO without a burn.
 *
 * "match" means the burn moved SMA or inclination toward the other object.
 * "depart" means it moved away. Either one is cited; a match scores higher.
 */

export interface ElsetSnap {
  epochMs: number;
  incDeg: number;
  raanDeg: number;
  eccentricity: number;
  meanMotionRevPerDay: number;
  argPerigeeDeg?: number | null;
  meanAnomalyDeg?: number | null;
  bstar?: number | null;
}

export interface ManeuverMark {
  dSmaKm: number;
  dIncDeg: number;
  beyondDrag: boolean;
  relation: "match" | "depart" | "burn";
}

const SMA_FLOOR_KM = 0.08;
const SMA_PER_DAY_KM = 0.12;
const INC_BURN_DEG = 0.015;

function absAng(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

export function detectManeuver(prev: ElsetSnap, curr: ElsetSnap, target?: ElsetSnap | null): ManeuverMark | null {
  const dtDays = Math.abs(curr.epochMs - prev.epochMs) / 86_400_000;
  if (!Number.isFinite(dtDays) || dtDays <= 0 || dtDays > 14) return null;
  const smaPrev = semiMajorAxisKm(prev.meanMotionRevPerDay);
  const smaCurr = semiMajorAxisKm(curr.meanMotionRevPerDay);
  if (!Number.isFinite(smaPrev) || !Number.isFinite(smaCurr)) return null;
  const dSmaKm = smaCurr - smaPrev;
  const dIncDeg = curr.incDeg - prev.incDeg;
  // bstar drag can take a bit more SMA; the floor still ignores meter-scale noise.
  const bstarBoost = Math.min(0.3, Math.abs(prev.bstar ?? 0) * 80);
  const dragBudget = SMA_FLOOR_KM + SMA_PER_DAY_KM * dtDays + bstarBoost;
  const energy = Math.abs(dSmaKm) > dragBudget;
  const plane = Math.abs(dIncDeg) > INC_BURN_DEG;
  if (!energy && !plane) return null;

  let relation: ManeuverMark["relation"] = "burn";
  if (target && Number.isFinite(target.meanMotionRevPerDay)) {
    const smaTarget = semiMajorAxisKm(target.meanMotionRevPerDay);
    const before = Math.abs(smaPrev - smaTarget) + Math.abs(prev.incDeg - target.incDeg) * 20;
    const after = Math.abs(smaCurr - smaTarget) + Math.abs(curr.incDeg - target.incDeg) * 20;
    if (after + 0.02 < before) relation = "match";
    else if (after > before + 0.02) relation = "depart";
  }
  return { dSmaKm, dIncDeg, beyondDrag: true, relation };
}

/** Two different objects carrying effectively the same elset (a cross-tag). */
export function isSuspectedCrossTag(a: ElsetSnap, b: ElsetSnap): boolean {
  if (!Number.isFinite(a.epochMs) || !Number.isFinite(b.epochMs)) return false;
  if (Math.abs(a.epochMs - b.epochMs) > 6 * 3600_000) return false;
  const dInc = Math.abs(a.incDeg - b.incDeg);
  const dRaan = absAng(a.raanDeg, b.raanDeg);
  const dMm = Math.abs(a.meanMotionRevPerDay - b.meanMotionRevPerDay);
  const dEcc = Math.abs(a.eccentricity - b.eccentricity);
  const dArg = a.argPerigeeDeg != null && b.argPerigeeDeg != null ? absAng(a.argPerigeeDeg, b.argPerigeeDeg) : 0;
  const dMa = a.meanAnomalyDeg != null && b.meanAnomalyDeg != null ? absAng(a.meanAnomalyDeg, b.meanAnomalyDeg) : 0;
  return dInc < 0.001 && dRaan < 0.01 && dMm < 1e-5 && dEcc < 1e-7 && dArg < 0.02 && dMa < 0.05;
}
