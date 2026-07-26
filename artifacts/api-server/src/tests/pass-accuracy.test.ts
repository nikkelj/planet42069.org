/**
 * Regression test for pass-prediction timing accuracy
 * (artifacts/api-server/src/lib/passes.ts).
 *
 * predictPasses bisects horizon crossings to ≤1 s and refines the peak with
 * a parabolic fit + 1 s fine scan. A regression (e.g. reverting to raw 30 s
 * grid samples, or a broken bisection bracket) would silently reintroduce
 * half-minute errors. This test runs a fixed TLE / location / start date and
 * asserts:
 *   - rise/peak/set times match known-good values within ±2 s
 *   - elevation at reported rise/set is ~0°
 *   - peak elevation is a local maximum (higher than ±5 s neighbors)
 *
 * Run with: pnpm --filter @workspace/api-server run test:passes
 */
import * as satellite from "satellite.js";
import { predictPasses } from "../lib/passes";
import type { TleData } from "../lib/tle";

const DEG = Math.PI / 180;

// ISS (ZARYA) elset, epoch 2024-01-01. Fixed forever for this test.
const TLE: TleData = {
  norad: 25544,
  name: "ISS (ZARYA)",
  line1: "1 25544U 98067A   24001.00000000  .00016717  00000-0  30777-3 0  9992",
  line2: "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49512282430000",
  epoch: "2024-01-01T00:00:00.000Z",
  incDeg: 51.6416,
  raanDeg: 247.4627,
  argPerigeeDeg: 130.536,
  meanAnomalyDeg: 325.0288,
  eccentricity: 0.0006703,
  meanMotionRevPerDay: 15.49512282,
  fetchedAt: "2024-01-01T00:00:00.000Z",
};

// Observer: London, UK. One day of passes starting at the elset epoch.
const LAT = 51.5074;
const LON = -0.1278;
const START = new Date("2024-01-01T00:00:00.000Z");

/** Elevation (deg) of the TLE satellite at `date` from the observer. */
function elevationAt(date: Date): number {
  const satrec = satellite.twoline2satrec(TLE.line1, TLE.line2);
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === "boolean") {
    throw new Error(`propagation failed at ${date.toISOString()}`);
  }
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const look = satellite.ecfToLookAngles(
    { latitude: LAT * DEG, longitude: LON * DEG, height: 0 },
    ecf,
  );
  return look.elevation / DEG;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

function checkTime(label: string, actualIso: string, expectedIso: string, tolMs: number) {
  const diff = Math.abs(new Date(actualIso).getTime() - new Date(expectedIso).getTime());
  check(label, diff <= tolMs, `expected ${expectedIso} ±${tolMs / 1000}s, got ${actualIso}, off by ${diff / 1000}s`);
}

// Known-good rise/peak/set times (UTC) for the first passes over London,
// captured from the bisection + parabolic-fit implementation. Tolerance ±2 s.
const EXPECTED: Array<{ start: string; max: string; end: string; maxElev: number }> = [
  { start: "2024-01-01T12:09:19.000Z", max: "2024-01-01T12:14:01.000Z", end: "2024-01-01T12:18:44.000Z", maxElev: 14.8 },
  { start: "2024-01-01T13:44:52.000Z", max: "2024-01-01T13:50:16.000Z", end: "2024-01-01T13:55:39.000Z", maxElev: 52.8 },
  { start: "2024-01-01T15:21:31.000Z", max: "2024-01-01T15:26:59.000Z", end: "2024-01-01T15:32:25.000Z", maxElev: 85.6 },
  { start: "2024-01-01T16:58:19.000Z", max: "2024-01-01T17:03:44.000Z", end: "2024-01-01T17:09:08.000Z", maxElev: 61.8 },
  { start: "2024-01-01T18:35:11.000Z", max: "2024-01-01T18:40:04.000Z", end: "2024-01-01T18:44:56.000Z", maxElev: 18.2 },
  { start: "2024-01-01T20:14:02.000Z", max: "2024-01-01T20:15:42.000Z", end: "2024-01-01T20:17:21.000Z", maxElev: 1.0 },
];

function main() {
  const passes = predictPasses(TLE, LAT, LON, 1, START);
  console.log(`predicted ${passes.length} passes over 1 day`);
  check("at least as many passes as expected", passes.length >= EXPECTED.length, `got ${passes.length}, need ${EXPECTED.length}`);

  EXPECTED.forEach((exp, i) => {
    const p = passes[i];
    if (!p) {
      check(`pass ${i} exists`, false);
      return;
    }
    checkTime(`pass ${i} rise time`, p.startTime, exp.start, 2000);
    checkTime(`pass ${i} peak time`, p.maxTime, exp.max, 2000);
    checkTime(`pass ${i} set time`, p.endTime, exp.end, 2000);
    check(
      `pass ${i} max elevation ≈ ${exp.maxElev}°`,
      Math.abs(p.maxElevationDeg - exp.maxElev) <= 0.3,
      `got ${p.maxElevationDeg}`,
    );
  });

  // Physical consistency checks on every reported pass.
  passes.forEach((p, i) => {
    // Elevation at reported rise/set should be ~0° (within the ~1 s bisection
    // resolution; ISS elevation changes < ~0.07°/s near the horizon).
    const riseElev = elevationAt(new Date(p.startTime));
    const setElev = elevationAt(new Date(p.endTime));
    check(`pass ${i} elevation at rise ≈ 0°`, Math.abs(riseElev) < 0.15, `got ${riseElev.toFixed(3)}°`);
    check(`pass ${i} elevation at set ≈ 0°`, Math.abs(setElev) < 0.15, `got ${setElev.toFixed(3)}°`);

    // Peak must be a local max. The refined peak sits on a 1 s grid, so a
    // neighbor can be microscopically higher when the true peak falls between
    // grid points — allow 0.01° of slack at ±3–5 s (a 30 s-grid regression
    // would be off by far more), and require a strict drop by ±30 s.
    const peakT = new Date(p.maxTime).getTime();
    const peakElev = elevationAt(new Date(peakT));
    let localMax = true;
    for (const dt of [-5000, -3000, 3000, 5000]) {
      if (elevationAt(new Date(peakT + dt)) > peakElev + 0.01) localMax = false;
    }
    for (const dt of [-30000, 30000]) {
      if (elevationAt(new Date(peakT + dt)) >= peakElev) localMax = false;
    }
    check(`pass ${i} peak is a local max`, localMax, `peak elev ${peakElev.toFixed(3)}°`);
    check(
      `pass ${i} reported maxElevationDeg matches peak`,
      Math.abs(p.maxElevationDeg - peakElev) <= 0.15,
      `reported ${p.maxElevationDeg}, recomputed ${peakElev.toFixed(2)}`,
    );

    // Ordering sanity.
    check(
      `pass ${i} rise < peak < set`,
      new Date(p.startTime).getTime() < peakT && peakT < new Date(p.endTime).getTime(),
    );
  });

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
