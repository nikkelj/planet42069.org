import assert from "node:assert/strict";
import { screenCandidatePairs, closeApproach, DEFAULT_SCREEN, type ScreenElset } from "../lib/rpod/screen";
import { screenWatchCrossings, crossingPairIsReportable, parseWatchNorads, DEFAULT_WATCH_NORADS } from "../lib/rpod/crossing";

// Celestrak GP, fetched 2026-10-12. Known passes from independent SGP4 screens:
//   Kosmos-2610 (68758) vs ICEYE-X6 (46497)         ~0.34 km @ 2026-10-14T23:06Z, ~14 km/s
//   Kosmos-2612 (68762) vs IRIDE-MS2-HEO-4 (64582)  ~1.34 km @ 2026-10-15T09:12Z, ~3.6 km/s
const TLES: [string, string][] = [
  ["1 68758U 26083F   26285.28628350  .00002499  00000+0  17141-3 0  9990", "2 68758  97.8224  64.9226 0010916  24.0469 336.1265 15.06928628 26831"],
  ["1 46497U 20068M   26285.29056623  .00002935  00000+0  21155-3 0  9997", "2 46497  98.1048 284.6587 0008221  61.9222 298.2833 15.04991987330843"],
  ["1 68762U 26083H   26284.94696506  .00001431  00000+0  14552-3 0  9993", "2 68762  97.9011  65.2879 0010517 199.0879 160.9947 14.92346808 26775"],
  ["1 64582U 25135BG  26285.28228306  .00002128  00000+0  21540-3 0  9992", "2 64582  97.7836  38.0858 0000939  50.8749 309.2553 14.92023178 71353"],
];

function toElset([l1, l2]: [string, string]): ScreenElset {
  const yr = +l1.substring(18, 20), d = +l1.substring(20, 32);
  return {
    norad: parseInt(l1.substring(2, 7), 10), epochMs: Date.UTC(2000 + yr, 0, 1) + (d - 1) * 86400_000,
    line1: l1, line2: l2, incDeg: +l2.substring(8, 16), raanDeg: +l2.substring(17, 25),
    eccentricity: +("0." + l2.substring(26, 33)), meanMotionRevPerDay: +l2.substring(52, 63),
  };
}

const els = TLES.map(toElset);
const NOW = Date.UTC(2026, 9, 12, 21, 0, 0);

(async () => {
  // Regression: the plane screen alone never makes these candidates.
  const planar = await screenCandidatePairs(els, DEFAULT_SCREEN);
  const keyOf = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const planarKeys = new Set(planar.map((p) => keyOf(p.a.norad, p.b.norad)));
  assert.ok(!planarKeys.has(keyOf(68758, 46497)), "plane screen unexpectedly pairs crossing orbits");
  // And the 60 s/1 s closeApproach mis-ranges the 14 km/s pass by tens of km.
  const coarse = closeApproach(els[0], els[1], NOW, 72 * 3600_000);
  assert.ok(coarse && coarse.minRangeKm > 5, `closeApproach unexpectedly resolved the fast pass (${coarse?.minRangeKm})`);

  const hits = await screenWatchCrossings(DEFAULT_WATCH_NORADS, els, NOW);
  const find = (a: number, b: number) => hits.find((h) => keyOf(h.a, h.b) === keyOf(a, b));

  const x6 = find(68758, 46497);
  assert.ok(x6, "Kosmos-2610 vs ICEYE-X6 not found");
  assert.ok(x6.minRangeKm < 1, `X6 range ${x6.minRangeKm}`);
  assert.ok(Math.abs(x6.relVelKmS - 14.1) < 0.5, `X6 relvel ${x6.relVelKmS}`);
  assert.ok(Math.abs(x6.tcaMs - Date.parse("2026-10-14T23:06:21Z")) < 120_000, `X6 tca ${new Date(x6.tcaMs).toISOString()}`);
  assert.ok(crossingPairIsReportable(x6));

  const iride = find(68762, 64582);
  assert.ok(iride, "Kosmos-2612 vs IRIDE-MS2-HEO-4 not found");
  assert.ok(iride.minRangeKm < 2, `IRIDE range ${iride.minRangeKm}`);
  assert.ok(Math.abs(iride.tcaMs - Date.parse("2026-10-15T09:12:20Z")) < 120_000, `IRIDE tca ${new Date(iride.tcaMs).toISOString()}`);
  assert.ok(crossingPairIsReportable(iride));

  // Reportability gates.
  const fast = { a: 1, b: 2, minRangeKm: 12, relVelKmS: 10, tcaMs: 0 };
  assert.equal(crossingPairIsReportable(fast), false);
  assert.equal(crossingPairIsReportable(fast, "30"), true);
  assert.equal(crossingPairIsReportable({ ...fast, relVelKmS: 0.5 }), true);
  assert.equal(crossingPairIsReportable({ ...fast, minRangeKm: 31, relVelKmS: 0.5 }), false);
  assert.deepEqual(parseWatchNorads("123, 456 x").slice(-2), [123, 456]);

  console.log(`rpod-crossing: ok — X6 ${x6.minRangeKm.toFixed(3)} km @ ${new Date(x6.tcaMs).toISOString()}, ` +
    `IRIDE ${iride.minRangeKm.toFixed(3)} km @ ${new Date(iride.tcaMs).toISOString()}`);
})().catch((err) => { console.error(err); process.exit(1); });
