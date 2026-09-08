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
  screenCandidatePairs, screenCoAlignedPairs, minRaanDiffDeg, minPhaseDiffDeg, raanRateDegPerDay, closeApproach, clusterPairs,
  DEFAULT_SCREEN, DEFAULT_COALIGNED, hasUsableTleLines, tleEpochMs, tleEpochIsCurrent, MAX_SGP4_PAIR_MS, SCREEN_YIELD_EVERY,
  type ScreenElset, type FlaggedPair,
} from "../lib/rpod/screen";
import { selectEndedCoplanarIds, COPLANAR_END_AFTER_MS, selectReopenCandidate, COPLANAR_REOPEN_WINDOW_MS } from "../lib/rpod/retire";

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
  const pairs = await screenCandidatePairs([a, b, c, d, e]);
  const keys = pairs.map((p) => [p.a.norad, p.b.norad].sort().join(":"));
  check("keeps the coplanar pair", keys.includes("100:101"), keys.join(","));
  check("drops far-RAAN pair", !keys.some((k) => k.includes("102")));
  check("drops different-inclination pair", !keys.some((k) => k.includes("103")));
  check("drops different-orbit-size pair", !keys.some((k) => k.includes("104")));
}

console.log("Stage 1: screening yields the event loop");
{
  const many = Array.from({ length: 80 }, (_, i) =>
    makeElset({ norad: 5000 + i, incDeg: 97.5, raanDeg: 120 + (i % 3) * 0.05, mm: 15.1 + (i % 5) * 0.01 }),
  );
  const syncPairs = await screenCandidatePairs(many, DEFAULT_SCREEN, 0);
  const yieldPairs = await screenCandidatePairs(many, DEFAULT_SCREEN, 50);
  const keyOf = (p: { a: ScreenElset; b: ScreenElset }) => [p.a.norad, p.b.norad].sort().join(":");
  check("yielding screen matches sync pairs",
    syncPairs.length === yieldPairs.length
    && syncPairs.map(keyOf).sort().join() === yieldPairs.map(keyOf).sort().join(),
    `sync=${syncPairs.length} yield=${yieldPairs.length}`);
  check("worker yield stride is set", SCREEN_YIELD_EVERY >= 100 && SCREEN_YIELD_EVERY <= 20_000, String(SCREEN_YIELD_EVERY));

  let ticks = 0;
  const id = setInterval(() => { ticks++; }, 1);
  await screenCandidatePairs(many, DEFAULT_SCREEN, 20);
  clearInterval(id);
  check("yielding screen lets timers fire (event loop not blocked)", ticks > 0, `ticks=${ticks}`);

  let timedOut = false;
  try {
    await screenCandidatePairs(many, DEFAULT_SCREEN, 20, Date.now() - 1);
  } catch (err) {
    timedOut = String(err).includes("timed out");
  }
  check("expired screening deadline throws", timedOut);
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

console.log("Stage 2: unusable / future / Alpha-5 TLEs must not throw");
{
  const startMs = Date.parse("2026-08-23T15:00:00Z");
  const win = 6 * 3600_000;
  const good = makeElset({ norad: 400, incDeg: 97.5, raanDeg: 120, mm: 15.1 });
  check("null TLE lines are unusable", !hasUsableTleLines({ line1: null as unknown as string, line2: good.line2 }));
  check("short garbage is unusable", !hasUsableTleLines({ line1: "N/A", line2: "N/A" }));
  check("empty strings are unusable", !hasUsableTleLines({ line1: "", line2: "" }));

  let threw = false;
  try {
    const ca = closeApproach(
      { line1: null as unknown as string, line2: null as unknown as string },
      good,
      startMs,
      win,
    );
    check("null TLE lines return null (no throw)", ca == null);
  } catch (err) {
    threw = true;
    check("null TLE lines return null (no throw)", false, String(err));
  }
  check("null TLE did not throw", !threw);

  threw = false;
  try {
    const ca = closeApproach({ line1: "N/A", line2: "N/A" }, good, startMs, win);
    check("garbage TLE returns null (no fake 0 km hit)", ca == null);
  } catch (err) {
    threw = true;
    check("garbage TLE returns null (no fake 0 km hit)", false, String(err));
  }
  check("garbage TLE did not throw", !threw);

  // Alpha-5 catalog numbers (≥100000) in the TLE satnum field. USSF exhausted
  // 5-digit numbers on 2026-07-11; GP JSON still carries numeric NORAD_CAT_ID
  // while TLE_LINE1/2 use Axxxx encoding. satellite.js must still propagate.
  const alpha = makeElset({ norad: 400, incDeg: 97.5, raanDeg: 120, ma: 0.02, mm: 15.1 });
  alpha.line1 = alpha.line1.replace(" 00400U", " A0001U");
  alpha.line2 = alpha.line2.replace(" 00400 ", " A0001 ");
  check("Alpha-5 lines look usable", hasUsableTleLines(alpha));
  // Line epoch is day 211 (2026-07-30); SGP4 is skipped when |tleEpoch-start| > 10d.
  const caAlpha = closeApproach(good, alpha, Date.parse("2026-07-30T00:00:00Z"), win);
  check("Alpha-5 pair propagates", caAlpha != null, caAlpha ? `range ${caAlpha.minRangeKm.toFixed(2)} km` : "null");

  // Predicted epoch ~4 days ahead of "now" (live newestEpoch 2026-08-27).
  const currentCompanion = makeElset({ norad: 400, incDeg: 97.5, raanDeg: 120, mm: 15.1 });
  currentCompanion.line1 = currentCompanion.line1.replace("26211.00000000", "26235.62500000");
  const futureEpoch = makeElset({ norad: 401, incDeg: 97.5, raanDeg: 120, ma: 0.02, mm: 15.1 });
  futureEpoch.line1 = futureEpoch.line1.replace("26211.00000000", "26239.47140641");
  futureEpoch.epochMs = Date.parse("2026-08-27T11:19:49Z");
  const caFuture = closeApproach(currentCompanion, futureEpoch, startMs, win);
  check("future-epoch TLE does not throw", caFuture == null || Number.isFinite(caFuture.minRangeKm));

  // 6-digit catalog numbers in the 5-digit TLE satnum field shift columns
  // 19–32. satellite.js then reads epochyr≈2 / epochdays≈6200 and deep-space
  // (mm≈1) dspace integrates decades of 720-minute steps — one pair hung the
  // live Node event loop (GET /api/rpod/status 20s / 0 bytes).
  const shifted = makeElset({ norad: 100000, incDeg: 0.1, raanDeg: 120, mm: 1.0027 });
  check("shifted 6-digit line epoch is unusable (doy ≥ 367)", tleEpochMs(shifted.line1) == null, `got ${tleEpochMs(shifted.line1)}`);
  check("shifted 6-digit epoch is not current", !tleEpochIsCurrent(shifted.line1, startMs));
  const tHang = Date.now();
  const caShifted = closeApproach(good, shifted, startMs, 48 * 3600_000);
  check("shifted 6-digit pair returns null (no SGP4)", caShifted == null);
  check("shifted 6-digit pair returns in <200ms", Date.now() - tHang < 200, `took ${Date.now() - tHang}ms`);
  check("SGP4 pair wall-clock cap is tight enough to keep HTTP alive",
    MAX_SGP4_PAIR_MS > 0 && MAX_SGP4_PAIR_MS <= 5_000, String(MAX_SGP4_PAIR_MS));
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

console.log("Co-aligned (coplanar shadowing) screen");
{
  // Calibration case: real elsets of a known long-running shadowing demo
  // (Jackal-0004 #69012 vs VICTUS HAZE Puma #69646, 2026-07-31):
  // Δinc 0.073°, ΔRAAN 0.061°, Δa 5.4 km, in-track ~175 km — never inside
  // the 30 km conjunction bubble, but must surface as co-aligned.
  const jackal: ScreenElset = {
    norad: 69012, epochMs: Date.parse("2026-07-31T11:51:02Z"),
    line1: "1 69012U 26100AJ  26212.49377417  .00003444  00000-0  15828-3 0  9994",
    line2: "2 69012  97.4587 109.7619 0012642  35.5985 324.6091 15.20980141 13542",
    incDeg: 97.4587, raanDeg: 109.7619, eccentricity: 0.0012642, meanMotionRevPerDay: 15.20980141,
  };
  const puma: ScreenElset = {
    norad: 69646, epochMs: Date.parse("2026-07-31T11:50:50Z"),
    line1: "1 69646U 26142A   26212.49363583 -.00000012  00000-0  24455-5 0  9999",
    line2: "2 69646  97.3853 109.7007 0004605 189.3400 170.7752 15.22771897  6400",
    incDeg: 97.3853, raanDeg: 109.7007, eccentricity: 0.0004605, meanMotionRevPerDay: 15.22771897,
  };
  // A same-band sun-sync object in a different plane (RAAN 5° away).
  const other = makeElset({ norad: 900, incDeg: 97.42, raanDeg: 114.8, mm: 15.21 });
  // Same plane but a shell far below (Δa ~ 90 km via mean motion).
  const lowShell = makeElset({ norad: 901, incDeg: 97.44, raanDeg: 109.75, mm: 15.5 });
  // Same plane & shell as Jackal, but on the far side of the orbit
  // (phase 180° off, same mean motion → never catches up).
  const farPhase: ScreenElset = {
    ...jackal, norad: 902,
    line2: "2 00902  97.4587 109.7619 0012642  35.5985 144.6091 15.20980141    13",
  };

  const now = Date.parse("2026-07-31T12:00:00Z");
  const co = await screenCoAlignedPairs([jackal, puma, other, lowShell, farPhase], DEFAULT_COALIGNED, now);
  const keys = co.map((p) => [p.a.norad, p.b.norad].sort().join(":"));
  const norads = new Set(co.flatMap((p) => [p.a.norad, p.b.norad]));
  check("known shadowing pair surfaces", keys.includes("69012:69646"), keys.join(",") || "none");
  check("different plane excluded", !norads.has(900));
  check("different shell excluded", !norads.has(901));
  check("far-side phase excluded", !norads.has(902));

  // Regression: large cumulative phase drift (>360° over the window) must not
  // be mistaken for a zero-crossing — a fast-lapping object sweeps past, it
  // does not shadow.
  const lapping: ScreenElset = { ...jackal, norad: 903, meanMotionRevPerDay: jackal.meanMotionRevPerDay + 1.2 };
  const dLap = minPhaseDiffDeg(farPhase, lapping, now, DEFAULT_COALIGNED.windowMs);
  check("fast-lapping pair keeps its phase separation", dLap > DEFAULT_COALIGNED.maxPhaseDiffDeg, `got ${dLap.toFixed(2)}`);

  // And SGP4 differencing over 48h stays under the loose coplanar caps.
  const ca = closeApproach(jackal, puma, Date.parse("2026-07-31T12:00:00Z"), DEFAULT_SCREEN.windowMs);
  check("shadowing pair propagates", ca != null);
  if (ca) {
    check("in-track range under coplanar cap", ca.minRangeKm < 250, `got ${ca.minRangeKm.toFixed(1)} km`);
    check("slow drift under coplanar rel-vel cap", ca.relVelKmS < 0.6, `got ${ca.relVelKmS.toFixed(3)} km/s`);
  }
}

// ── coplanar retirement rule ────────────────────────────────────────────────
{
  console.log("\nCoplanar retirement (drifted pairs end, fresh pairs survive):");
  const now = Date.parse("2026-08-01T00:00:00Z");
  const h = 3600_000;
  const events = [
    { id: 1, lastSeenAt: new Date(now) },                                  // re-detected this scan
    { id: 2, lastSeenAt: new Date(now - 12 * h) },                         // brief elset gap
    { id: 3, lastSeenAt: new Date(now - COPLANAR_END_AFTER_MS) },          // exactly at threshold
    { id: 4, lastSeenAt: new Date(now - COPLANAR_END_AFTER_MS - 1) },      // just past threshold
    { id: 5, lastSeenAt: new Date(now - 7 * 24 * h) },                     // long gone
  ];
  const ended = selectEndedCoplanarIds(events, now);
  check("freshly re-detected event stays active", !ended.includes(1));
  check("short gap stays active", !ended.includes(2));
  check("event exactly at threshold stays active", !ended.includes(3));
  check("event just past threshold is ended", ended.includes(4));
  check("long-drifted event is ended", ended.includes(5));
  check("only the drifted events end", ended.length === 2, `got ${JSON.stringify(ended)}`);
  check("no events → nothing to end", selectEndedCoplanarIds([], now).length === 0);
}

// ── coplanar reopen rule ────────────────────────────────────────────────────
{
  console.log("\nCoplanar reopen (same pair closes ranks again → reactivate old case):");
  const now = Date.parse("2026-08-01T00:00:00Z");
  const d = 86400_000;
  const ended = [
    { id: 10, endedAt: new Date(now - 5 * d), members: [111, 222] },                     // recent, exact pair
    { id: 11, endedAt: new Date(now - 30 * d), members: [111, 222, 333] },               // older, superset
    { id: 12, endedAt: new Date(now - COPLANAR_REOPEN_WINDOW_MS - d), members: [444, 555] }, // too old
    { id: 13, endedAt: null, members: [666, 777] },                                      // no end date
    { id: 14, endedAt: new Date(now - 2 * d), members: [111, 888] },                     // only 1 shared member
  ];

  check("same pair within window reopens the old case",
    selectReopenCandidate(ended, [111, 222], now) === 10);
  check("most recently ended candidate wins over older superset",
    selectReopenCandidate([ended[1], ended[0]], [111, 222], now) === 10);
  check("≥2 shared members suffices (cluster grew a member)",
    selectReopenCandidate([ended[1]], [222, 333, 999], now) === 11);
  check("single shared member → new case",
    selectReopenCandidate([ended[4]], [111, 999], now) === null);
  check("case ended beyond the reopen window → new case",
    selectReopenCandidate([ended[2]], [444, 555], now) === null);
  check("case exactly at the window edge still reopens",
    selectReopenCandidate([{ id: 20, endedAt: new Date(now - COPLANAR_REOPEN_WINDOW_MS), members: [1, 2] }], [1, 2], now) === 20);
  check("missing endedAt never matches",
    selectReopenCandidate([ended[3]], [666, 777], now) === null);
  check("disjoint membership → new case",
    selectReopenCandidate(ended, [900, 901], now) === null);
  check("no ended cases → new case", selectReopenCandidate([], [111, 222], now) === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll RPOD screening checks passed");
