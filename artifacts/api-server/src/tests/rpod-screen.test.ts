/**
 * Tests for the RPOD screening pipeline (src/lib/rpod/screen.ts):
 *  - stage-1 plane screen keeps coplanar/converging pairs and drops others
 *  - J2 RAAN convergence detection catches drifting-together planes
 *  - stage-2 SGP4 differencing finds a tight approach for near-identical
 *    elsets and a large range for well-separated planes
 *  - stage-3 clustering merges shared-member pairs, respects the member cap,
 *    and splits time-separated groups
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import {
  screenCandidatePairs, minRaanDiffDeg, raanRateDegPerDay, closeApproach, clusterPairs,
  DEFAULT_SCREEN, type ScreenElset, type FlaggedPair,
} from "../lib/rpod/screen";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// TLE checksum so satellite.js accepts synthetic lines
function checksum(line: string): string {
  let sum = 0;
  for (const ch of line.slice(0, 68)) {
    if (ch >= "0" && ch <= "9") sum += ch.charCodeAt(0) - 48;
    else if (ch === "-") sum += 1;
  }
  return String(sum % 10);
}

function pad(v: number, w: number, dec: number): string {
  return v.toFixed(dec).padStart(w, " ");
}

/** Build a synthetic elset. Epoch: 2026-07-30 00:00 UTC (day 211 of 2026). */
function makeElset(opts: {
  norad: number; incDeg: number; raanDeg: number; ecc?: number;
  argp?: number; ma?: number; mm: number;
}): ScreenElset {
  const ecc = opts.ecc ?? 0.0002;
  const argp = opts.argp ?? 90;
  const ma = opts.ma ?? 0;
  const noradStr = String(opts.norad).padStart(5, "0");
  let l1 = `1 ${noradStr}U 26001A   26211.00000000  .00000100  00000-0  10000-4 0  999`;
  l1 += checksum(l1);
  const eccStr = ecc.toFixed(7).slice(2);
  let l2 = `2 ${noradStr} ${pad(opts.incDeg, 8, 4)} ${pad(opts.raanDeg, 8, 4)} ${eccStr} ${pad(argp, 8, 4)} ${pad(ma, 8, 4)} ${opts.mm.toFixed(8).padStart(11, " ")}    1`;
  l2 += checksum(l2);
  return {
    norad: opts.norad,
    epochMs: Date.parse("2026-07-30T00:00:00Z"),
    line1: l1,
    line2: l2,
    incDeg: opts.incDeg,
    raanDeg: opts.raanDeg,
    eccentricity: ecc,
    meanMotionRevPerDay: opts.mm,
  };
}

console.log("Stage 1: plane screen");
{
  const a = makeElset({ norad: 100, incDeg: 97.5, raanDeg: 120.0, mm: 15.1 });
  const b = makeElset({ norad: 101, incDeg: 97.6, raanDeg: 120.5, mm: 15.15 }); // coplanar-ish
  const c = makeElset({ norad: 102, incDeg: 97.5, raanDeg: 200.0, mm: 15.1 }); // far RAAN
  const d = makeElset({ norad: 103, incDeg: 51.6, raanDeg: 120.0, mm: 15.1 }); // wrong inc
  const e = makeElset({ norad: 104, incDeg: 97.5, raanDeg: 120.1, mm: 14.2 }); // wrong orbit size
  const pairs = screenCandidatePairs([a, b, c, d, e]);
  const keys = pairs.map((p) => [p.a.norad, p.b.norad].sort().join(":"));
  check("keeps the coplanar pair", keys.includes("100:101"), keys.join(","));
  check("drops far-RAAN pair", !keys.some((k) => k.includes("102")));
  check("drops different-inclination pair", !keys.some((k) => k.includes("103")));
  check("drops different-orbit-size pair", !keys.some((k) => k.includes("104")));
}

console.log("J2 RAAN convergence");
{
  // Sun-sync-ish orbit: precession rate ~0.98 deg/day at inc 97.5.
  const rate = raanRateDegPerDay({ incDeg: 97.5, eccentricity: 0.0002, meanMotionRevPerDay: 15.1 });
  check("SSO precession rate ≈ +1 deg/day", rate > 0.6 && rate < 1.4, `got ${rate.toFixed(3)}`);
  // Different inclinations → different rates → planes converge.
  const a = makeElset({ norad: 200, incDeg: 97.5, raanDeg: 10.0, mm: 15.1 });
  const b = makeElset({ norad: 201, incDeg: 90.0, raanDeg: 10.8, mm: 15.1 }); // rate ~0 vs ~+1/day
  const dMin = minRaanDiffDeg(a, b, 2 * 86400_000);
  check("converging planes reach ~0 within window", dMin < 0.2, `got ${dMin.toFixed(3)}`);
  const dStatic = minRaanDiffDeg(a, b, 0);
  check("zero window keeps initial separation", Math.abs(dStatic - 0.8) < 0.05, `got ${dStatic.toFixed(3)}`);
}

console.log("Stage 2: SGP4 close approach");
{
  const startMs = Date.parse("2026-07-30T00:00:00Z");
  const win = 6 * 3600_000;
  const a = makeElset({ norad: 300, incDeg: 97.5, raanDeg: 120, ma: 0, mm: 15.1 });
  const b = makeElset({ norad: 301, incDeg: 97.5, raanDeg: 120, ma: 0.02, mm: 15.1 }); // trailing ~2 km
  const ca = closeApproach(a, b, startMs, win);
  check("near-identical elsets propagate", ca != null);
  if (ca) {
    check("tight range for trailing pair", ca.minRangeKm < 10, `got ${ca.minRangeKm.toFixed(2)} km`);
    check("low relative velocity", ca.relVelKmS < 0.2, `got ${ca.relVelKmS.toFixed(3)} km/s`);
    check("TCA inside window", ca.tcaMs >= startMs - 60_000 && ca.tcaMs <= startMs + win + 60_000);
  }
  const c = makeElset({ norad: 302, incDeg: 97.5, raanDeg: 140, ma: 180, mm: 15.1 });
  const far = closeApproach(a, c, startMs, win);
  check("separated planes stay far", far != null && far.minRangeKm > 100, far ? `got ${far.minRangeKm.toFixed(1)} km` : "null");
}

console.log("Stage 3: clustering");
{
  const t0 = Date.parse("2026-07-30T12:00:00Z");
  const mk = (a: number, b: number, tcaMs: number, r = 5): FlaggedPair => ({ a, b, minRangeKm: r, relVelKmS: 0.05, tcaMs });
  // chain 1-2, 2-3 same time → one 3-member event
  // pair 8-9 twelve hours later → separate event
  const events = clusterPairs([mk(1, 2, t0, 3), mk(2, 3, t0 + 3600_000, 7), mk(8, 9, t0 + 13 * 3600_000, 1)]);
  check("two events", events.length === 2, `got ${events.length}`);
  const three = events.find((e) => e.members.length === 3);
  check("shared member merges into 3-craft event", three != null && three.members.join(",") === "1,2,3");
  check("tightest pair drives event stats", three != null && three.minRangeKm === 3);
  check("sorted tightest-first", events[0].minRangeKm <= events[1].minRangeKm);

  // Member cap: star of 6 craft around hub 50
  const star = clusterPairs([1, 2, 3, 4, 5].map((i) => mk(50, 50 + i, t0)), 5);
  check("capped cluster flagged for widened scan", star.length === 1 && star[0].hitCap, JSON.stringify(star.map((s) => [s.members.length, s.hitCap])));

  check("empty input → no events", clusterPairs([]).length === 0);

  // Regression: pairs sharing a member but with TCAs far outside the merge
  // window must remain SEPARATE events (same craft, different operations).
  const apart = clusterPairs([mk(10, 11, t0), mk(11, 12, t0 + 48 * 3600_000)]);
  check("shared member beyond time window stays split", apart.length === 2, `got ${apart.length}`);
  // ...but transitive chains within the window still merge.
  const chain = clusterPairs([mk(20, 21, t0), mk(21, 22, t0 + 2 * 3600_000), mk(22, 23, t0 + 4 * 3600_000)]);
  check("in-window transitive chain merges", chain.length === 1 && chain[0].members.length === 4, `got ${chain.length}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll RPOD screening checks passed");
