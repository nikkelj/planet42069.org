/**
 * RPOD interest policy (src/lib/rpod/interest.ts): what persists to the
 * board vs. what is constellation housekeeping.
 *
 * Same-constellation is not a hard ban. Locks in mixed-operator, Starlink-
 * on-Starlink (near-miss / crossing-track / messy cluster), and the boring
 * same-plane km-scale housekeeping class using catalog fixtures — no live
 * Space-Track.
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyEvent, classifyPairByNorad, countFreeBodies, selectInterestingEvents,
  prioritizeSgp4Pairs, constellationTag, nameFamily, isCrossingTrackGeometry,
  SAME_OPERATOR_NEAR_MISS_KM, SAME_OPERATOR_CROSSING_RELVEL_KM_S,
  CLUSTER_MIN_FREE_BODIES, CLUSTER_MAX_RANGE_KM,
  MIXED_OPERATOR_MAX_RANGE_KM, DOCKED_MAX_RANGE_KM, DOCKED_MAX_RELVEL_KM_S,
  type InterestCatalogMeta,
} from "../lib/rpod/interest";
import { RPOD_MAX_RANGE_KM } from "../lib/rpod/screen";
import type { ClusteredEvent, FlaggedPair } from "../lib/rpod/screen";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const TCA = Date.parse("2026-08-27T12:00:00Z");

function meta(partial: Partial<InterestCatalogMeta> & { name: string }): InterestCatalogMeta {
  return {
    owner: null, state: null, gunterOperator: null, gunterNation: null, objectClass: "P",
    ...partial,
  };
}

function pair(a: number, b: number, minRangeKm: number, relVelKmS = 0.2): FlaggedPair {
  return { a, b, minRangeKm, relVelKmS, tcaMs: TCA };
}

function event(members: number[], pairs: FlaggedPair[]): ClusteredEvent {
  const tightest = pairs.reduce((m, p) => (p.minRangeKm < m.minRangeKm ? p : m), pairs[0]);
  return {
    members: [...members].sort((x, y) => x - y),
    pairs,
    minRangeKm: tightest.minRangeKm,
    relVelKmS: tightest.relVelKmS,
    tcaMs: tightest.tcaMs,
    windowStartMs: TCA - 1800_000,
    windowEndMs: TCA + 1800_000,
    hitCap: false,
  };
}

function catalog(entries: [number, InterestCatalogMeta][]): Map<number, InterestCatalogMeta> {
  return new Map(entries);
}

console.log("Thresholds are documented and mixed ≫ same-operator");
{
  check("mixed-operator range matches the conjunction bubble", MIXED_OPERATOR_MAX_RANGE_KM === RPOD_MAX_RANGE_KM);
  check("same-operator near-miss is much tighter than mixed", SAME_OPERATOR_NEAR_MISS_KM * 20 < MIXED_OPERATOR_MAX_RANGE_KM,
    `near-miss=${SAME_OPERATOR_NEAR_MISS_KM} mixed=${MIXED_OPERATOR_MAX_RANGE_KM}`);
  check("crossing-track relvel is above neighbor flybys and inside the conjunction cap",
    SAME_OPERATOR_CROSSING_RELVEL_KM_S > 0.1 && SAME_OPERATOR_CROSSING_RELVEL_KM_S < 1.5,
    String(SAME_OPERATOR_CROSSING_RELVEL_KM_S));
  check("cluster volume matches the conjunction bubble", CLUSTER_MAX_RANGE_KM === RPOD_MAX_RANGE_KM);
  check("same-operator cluster needs many free-flyers, not a dense-shell trio",
    CLUSTER_MIN_FREE_BODIES >= 6, String(CLUSTER_MIN_FREE_BODIES));
  check("docked range sits outside the near-miss bar (attached ≠ fuckup)",
    DOCKED_MAX_RANGE_KM > SAME_OPERATOR_NEAR_MISS_KM);
}

console.log("Name / constellation affiliation");
{
  check("STARLINK-30123 tags starlink", constellationTag("STARLINK-30123") === "starlink");
  check("OneWeb-0123 tags oneweb", constellationTag("ONEWEB-0123") === "oneweb");
  check("Kosmos-2542 is NOT a constellation (inspector names stay mixed-capable)",
    constellationTag("Kosmos-2542") === null);
  check("nameFamily aliases Kosmos → cosmos", nameFamily("Kosmos-2542") === "cosmos");
  check("nameFamily COSMOS 2542 → cosmos", nameFamily("COSMOS 2542") === "cosmos");
  check("generic OBJECT A is not a mixed-name signal", nameFamily("OBJECT A") === null);
  check("USA 245 family is usa", nameFamily("USA 245") === "usa");
}

console.log("Class 1: mixed-operator / mixed-force / mixed-name");
{
  const starlinkVsOneweb = event([1001, 2001], [pair(1001, 2001, 12)]);
  const mixedConst = catalog([
    [1001, meta({ name: "STARLINK-30123", owner: "SPX", state: "US" })],
    [2001, meta({ name: "ONEWEB-0123", owner: "ONE", state: "UK" })],
  ]);
  check("Starlink vs OneWeb at 12 km is mixed-operator",
    classifyEvent(starlinkVsOneweb, mixedConst).reason === "mixed-operator");
  check("Starlink vs OneWeb is kept",
    classifyEvent(starlinkVsOneweb, mixedConst).keep);

  const cosmosVsUsa = event([2542, 3245], [pair(2542, 3245, 18)]);
  const mixedNamesNoOwner = catalog([
    [2542, meta({ name: "COSMOS 2542" })],
    [3245, meta({ name: "USA 245" })],
  ]);
  check("COSMOS vs USA with missing owners is mixed-name, not dropped",
    classifyEvent(cosmosVsUsa, mixedNamesNoOwner).keep
    && classifyEvent(cosmosVsUsa, mixedNamesNoOwner).reason === "mixed-operator");
  check("pair classifier agrees (mixed names, no owner)",
    classifyPairByNorad(2542, 3245, mixedNamesNoOwner) === "mixed");

  const usMilVsStarlink = event([5001, 5002], [pair(5001, 5002, 9)]);
  const sameNationDifferentOwner = catalog([
    [5001, meta({ name: "USA 245", owner: "NRO", state: "US" })],
    [5002, meta({ name: "STARLINK-1234", owner: "SPX", state: "US" })],
  ]);
  check("same nation + different owners is mixed-force (not same-operator)",
    classifyEvent(usMilVsStarlink, sameNationDifferentOwner).reason === "mixed-operator");

  const issDragon = event([25544, 58000], [pair(25544, 58000, 0.05, 0.001)]);
  const mixedDocked = catalog([
    [25544, meta({ name: "ISS (ZARYA)", owner: "ISS", state: "ISS" })],
    [58000, meta({ name: "DRAGON CRS-32", owner: "SPX", state: "US" })],
  ]);
  check("ISS + Dragon docked stack is mixed-operator (visiting vehicle), not a cluster",
    classifyEvent(issDragon, mixedDocked).reason === "mixed-operator"
    && countFreeBodies(issDragon) === 0);
}

console.log("Class 2: Starlink-on-Starlink crossing-track (allowed, not a ban)");
{
  const twoStarlink = catalog([
    [40, meta({ name: "STARLINK-40", owner: "SPX", state: "US" })],
    [41, meta({ name: "STARLINK-41", owner: "SPX", state: "US" })],
  ]);
  const crossing = event([40, 41], [pair(40, 41, 8.0, 0.5)]);
  check("8 km Starlink-on-Starlink at 0.5 km/s is crossing-track geometry",
    isCrossingTrackGeometry(8.0, 0.5));
  check("crossing-track Starlink-on-Starlink is kept",
    classifyEvent(crossing, twoStarlink).keep
    && classifyEvent(crossing, twoStarlink).reason === "same-operator-crossing");

  const oneweb = catalog([
    [50, meta({ name: "ONEWEB-050", owner: "ONE" })],
    [51, meta({ name: "ONEWEB-051", owner: "ONE" })],
  ]);
  check("same-constellation OneWeb crossing-track is also kept (not a Starlink-only exception)",
    classifyEvent(event([50, 51], [pair(50, 51, 10, 0.45)]), oneweb).reason === "same-operator-crossing");
}

console.log("Class 3: ultra-close same-operator near-miss (Starlink allowed)");
{
  const twoStarlink = catalog([
    [30, meta({ name: "STARLINK-10", owner: "SPX" })],
    [31, meta({ name: "STARLINK-11", owner: "SPX" })],
  ]);
  const nearMiss = event([30, 31], [pair(30, 31, 0.12, 0.4)]);
  check("0.12 km Starlink-on-Starlink with real relative velocity is a near-miss",
    classifyEvent(nearMiss, twoStarlink).keep
    && classifyEvent(nearMiss, twoStarlink).reason === "same-operator-near-miss");

  const attached = event([30, 31], [pair(30, 31, 0.1, DOCKED_MAX_RELVEL_KM_S)]);
  check("same-operator at 0.1 km AND docked velocity is attached, not a fuckup",
    !classifyEvent(attached, twoStarlink).keep
    && classifyEvent(attached, twoStarlink).reason === "boring");
}

console.log("Class 4: messy cluster of many free-flyers, not a dense-shell trio");
{
  const starlinks = catalog(
    [10, 11, 12, 13, 14, 15, 16].map((n) => [n, meta({ name: `STARLINK-${n}`, owner: "SPX", state: "US" })] as [number, InterestCatalogMeta]),
  );
  const trio = event(
    [10, 11, 12],
    [pair(10, 11, 8, 0.05), pair(11, 12, 11, 0.04)],
  );
  check("three slow Starlinks in a 30 km bubble is density, not a cluster",
    countFreeBodies(trio) === 3
    && classifyEvent(trio, starlinks).reason === "boring"
    && !classifyEvent(trio, starlinks).keep);

  const messyPairs = [10, 11, 12, 13, 14, 15].map((n, i, arr) =>
    i < arr.length - 1 ? pair(n, arr[i + 1], 6 + i, 0.05) : null,
  ).filter((p): p is NonNullable<typeof p> => p != null);
  const messy = event([10, 11, 12, 13, 14, 15], messyPairs);
  check("six slow independently flying Starlinks is a messy cluster",
    countFreeBodies(messy) === 6);
  check("same-constellation messy cluster is kept (Starlink-on-Starlink allowed)",
    classifyEvent(messy, starlinks).keep
    && classifyEvent(messy, starlinks).reason === "cluster");

  const dockedStack = event(
    [20, 21, 22, 23],
    [
      pair(20, 21, 0.02, 0.001),
      pair(21, 22, 0.03, 0.002),
      pair(22, 23, 0.01, 0.001),
    ],
  );
  const tianhe = catalog([
    [20, meta({ name: "CSS (TIANHE)", owner: "PRC", state: "CN" })],
    [21, meta({ name: "TIANZHOU 7", owner: "PRC", state: "CN" })],
    [22, meta({ name: "SHENZHOU 18", owner: "PRC", state: "CN" })],
    [23, meta({ name: "CSS (WENTIAN)", owner: "PRC", state: "CN" })],
  ]);
  check("docked same-operator station stack has zero free bodies",
    countFreeBodies(dockedStack) === 0);
  check("docked same-operator stack is NOT a cluster and is dropped",
    classifyEvent(dockedStack, tianhe).reason === "boring"
    && !classifyEvent(dockedStack, tianhe).keep);

  const farTrio = event(
    [10, 11, 12],
    [pair(10, 11, 80, 0.05), pair(11, 12, 90, 0.04)],
  );
  check("same-operator trio outside the 30 km volume is not a cluster",
    countFreeBodies(farTrio) === 0);
  check("coplanar-range same-operator trio is boring",
    classifyEvent(farTrio, starlinks).reason === "boring");
}

console.log("Boring: typical same-plane km-scale housekeeping / fail-closed");
{
  const twoStarlink = catalog([
    [40, meta({ name: "STARLINK-40", owner: "SPX", state: "US" })],
    [41, meta({ name: "STARLINK-41", owner: "SPX", state: "US" })],
  ]);
  const housekeeping = event([40, 41], [pair(40, 41, 8.5, 0.15)]);
  check("typical same-plane Starlink-on-Starlink at 8.5 km / 0.15 km/s is dropped",
    classifyEvent(housekeeping, twoStarlink).reason === "boring"
    && !classifyEvent(housekeeping, twoStarlink).keep);
  check("8.5 km / 0.15 km/s is not crossing-track",
    !isCrossingTrackGeometry(8.5, 0.15));

  const oneweb = catalog([
    [50, meta({ name: "ONEWEB-050", owner: "ONE" })],
    [51, meta({ name: "ONEWEB-051", owner: "ONE" })],
  ]);
  check("typical same-plane OneWeb-on-OneWeb at 15 km is dropped",
    !classifyEvent(event([50, 51], [pair(50, 51, 15, 0.08)]), oneweb).keep);

  const plannedRpo = catalog([
    [60, meta({ name: "TIANZHOU 7", owner: "PRC", state: "CN" })],
    [61, meta({ name: "CSS (TIANHE)", owner: "PRC", state: "CN" })],
  ]);
  check("planned same-owner RPO at 2 km (slow, different names, same owner) is dropped",
    classifyPairByNorad(60, 61, plannedRpo) === "same"
    && !classifyEvent(event([60, 61], [pair(60, 61, 2, 0.05)]), plannedRpo).keep);

  const unknown = catalog([
    [70, meta({ name: "OBJECT A" })],
    [71, meta({ name: "OBJECT B" })],
  ]);
  check("missing owners + generic names fail closed (not surfaced as mixed)",
    classifyPairByNorad(70, 71, unknown) === "unknown"
    && !classifyEvent(event([70, 71], [pair(70, 71, 10)]), unknown).keep);

  const halfKnown = catalog([
    [80, meta({ name: "STARLINK-80", owner: "SPX" })],
    [81, meta({ name: "OBJECT Z" })],
  ]);
  check("Starlink vs generic OBJECT with no owner fails closed (not a clearly mixed name)",
    classifyPairByNorad(80, 81, halfKnown) === "unknown"
    && !classifyEvent(event([80, 81], [pair(80, 81, 10)]), halfKnown).keep);

  const empty = new Map<number, InterestCatalogMeta>();
  check("empty catalog: 10 km slow pair fails closed",
    !classifyEvent(event([1, 2], [pair(1, 2, 10, 0.08)]), empty).keep);
  check("empty catalog: 0.1 km with real relvel still a near-miss (geometry only)",
    classifyEvent(event([1, 2], [pair(1, 2, 0.1, 0.4)]), empty).reason === "same-operator-near-miss");
  check("empty catalog: km-scale crossing-track still kept (unusual geometry, not a bland guess)",
    classifyEvent(event([1, 2], [pair(1, 2, 8, 0.5)]), empty).reason === "same-operator-crossing");
}

console.log("selectInterestingEvents drops boring before persist");
{
  const metaMap = catalog([
    [1, meta({ name: "STARLINK-1", owner: "SPX" })],
    [2, meta({ name: "STARLINK-2", owner: "SPX" })],
    [3, meta({ name: "ONEWEB-1", owner: "ONE" })],
    [4, meta({ name: "STARLINK-3", owner: "SPX" })],
    [5, meta({ name: "STARLINK-4", owner: "SPX" })],
    [6, meta({ name: "STARLINK-5", owner: "SPX" })],
    [7, meta({ name: "STARLINK-6", owner: "SPX" })],
    [8, meta({ name: "STARLINK-7", owner: "SPX" })],
    [9, meta({ name: "STARLINK-8", owner: "SPX" })],
    [10, meta({ name: "STARLINK-9", owner: "SPX" })],
  ]);
  const mixed = event([1, 3], [pair(1, 3, 12)]);
  const boring = event([1, 2], [pair(1, 2, 8, 0.12)]);
  const cluster = event(
    [4, 5, 6, 7, 8, 9],
    [pair(4, 5, 7, 0.05), pair(5, 6, 9, 0.04), pair(6, 7, 5, 0.06), pair(7, 8, 8, 0.05), pair(8, 9, 6, 0.04)],
  );
  const nearMiss = event([1, 10], [pair(1, 10, 0.08, 0.5)]);
  const crossing = event([2, 4], [pair(2, 4, 9, 0.55)]);
  const { kept, stats } = selectInterestingEvents([mixed, boring, cluster, nearMiss, crossing], metaMap);
  check("keeps mixed, cluster, near-miss, and crossing-track Starlink", kept.length === 4, `kept=${kept.length}`);
  check("drops the boring same-plane Starlink pair", stats.dropped === 1 && stats.kept === 4,
    JSON.stringify(stats));
  check("stats count each interesting class once",
    stats.mixed === 1 && stats.cluster === 1 && stats.nearMiss === 1 && stats.crossing === 1,
    JSON.stringify(stats));
}

console.log("SGP4 budget prefers mixed-force, then splits tight vs crossing same-operator");
{
  const metaMap = catalog([
    [1, meta({ name: "STARLINK-1", owner: "SPX" })],
    [2, meta({ name: "STARLINK-2", owner: "SPX" })],
    [3, meta({ name: "STARLINK-3", owner: "SPX" })],
    [4, meta({ name: "STARLINK-4", owner: "SPX" })],
    [9, meta({ name: "COSMOS 2542", owner: "CIS", state: "RU" })],
  ]);
  const pairs = [
    { a: { norad: 1, incDeg: 53.0 }, b: { norad: 2, incDeg: 53.01 } }, // same, tightest plane
    { a: { norad: 1, incDeg: 53.0 }, b: { norad: 3, incDeg: 53.02 } },
    { a: { norad: 1, incDeg: 53.0 }, b: { norad: 4, incDeg: 53.40 } }, // same, loosest plane (crossing-ish)
    { a: { norad: 1, incDeg: 53.0 }, b: { norad: 9, incDeg: 53.5 } },  // mixed, looser plane
  ];
  const planeScore = (p: (typeof pairs)[0]) => Math.abs(p.a.incDeg - p.b.incDeg);
  const picked2 = prioritizeSgp4Pairs(pairs, metaMap, 2, planeScore);
  check("budget of 2 keeps the mixed pair even though its plane is looser",
    picked2.some((p) => p.b.norad === 9), JSON.stringify(picked2.map((p) => [p.a.norad, p.b.norad])));
  check("budget of 2 also keeps the tightest same-operator leftover",
    picked2.length === 2 && picked2.some((p) => p.b.norad === 2));

  const picked3 = prioritizeSgp4Pairs(pairs, metaMap, 3, planeScore);
  check("budget of 3 keeps mixed + tightest same + loosest same (crossing-track slot)",
    picked3.some((p) => p.b.norad === 9)
    && picked3.some((p) => p.b.norad === 2)
    && picked3.some((p) => p.b.norad === 4),
    JSON.stringify(picked3.map((p) => [p.a.norad, p.b.norad])));
}

console.log("doScan wires the filter in front of persist (scanner health path intact)");
{
  const scanSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/rpod/scan.ts"), "utf8");
  check("doScan filters via selectInterestingEvents", scanSrc.includes("selectInterestingEvents("));
  check("conjunction persist uses the filtered list",
    /selectInterestingEvents\(events[\s\S]{0,500}persistEvents\(conjKept\.kept/.test(scanSrc));
  check("coplanar persist uses the filtered list",
    /selectInterestingEvents\(coEvents[\s\S]{0,500}persistEvents\(coKept\.kept/.test(scanSrc));
  check("PR#7: doScan still loads elsets via getLatestElsetsOrSkip",
    scanSrc.includes("getLatestElsetsOrSkip("));
  check("PR#7: elset-fetch skip still logs success, not error",
    /if \(loaded\.warning\)[\s\S]{0,500}logScanRow\(\s*"success"/.test(scanSrc));
  check("PR#7: lastScanEvents can be 0 on skip (rowCount 0)",
    /logScanRow\("success", started, 0, loaded\.warning\)/.test(scanSrc));

  const statusSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../routes/rpod.ts"), "utf8");
  check("PR#6: /rpod/status still LIMIT 1 on the latest scan-log row",
    /eq\(obcSyncLog\.source, "rpod-scan"\)[\s\S]{0,200}\.limit\(1\)/.test(statusSrc));
  check("PR#6: /rpod/status still uses formatRpodScanStatus",
    statusSrc.includes("formatRpodScanStatus("));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll RPOD interest-policy checks passed");
