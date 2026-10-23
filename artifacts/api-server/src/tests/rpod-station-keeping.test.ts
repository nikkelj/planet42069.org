/**
 * Station keeping: a plane-matched red-versus-blue pair holding a steady
 * along-track offset. Pure checks (no database):
 *  - stable offsets inside the cap classify; far, fast, or short histories do not
 *  - blue-blue, red-neutral, and same-launch pairs never enter the prefilter
 *  - Kosmos 2612 (68762) trailing ICEYE-X36 (59103) classifies from the
 *    published 2026-10-21 elements, rewound at each object's own mean motion
 *  - alerts fire on onset and on a ≥100 km offset change, not on a repeat
 *  - the history seek is a VALUES/LATERAL over candidate NORADs only
 *  - existing range and velocity gates are unchanged
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { historyLateralIsCatalogWide, sqlTemplateText } from "../lib/obc/tleArchive";
import {
  evaluateAlert,
  relVelLimits,
  DEFAULT_MAX_REL_VEL_MS,
  DEFAULT_MAX_REL_VEL_RED_BLUE_MS,
  type PolicyEvent,
} from "../lib/rpod/alertPolicy";
import { formatStationKeepingCitation, weightedTweetLength, TWEET_MAX_WEIGHTED } from "../lib/rpod/alert";
import { isSuspectedCrossTag } from "../lib/rpod/maneuver";
import { COALIGNED_MAX_RANGE_KM, COALIGNED_MAX_RELVEL_KM_S, DEFAULT_COALIGNED } from "../lib/rpod/screen";
import {
  DEFAULT_STATION_KEEPING,
  STATION_KEEPING_LEDGER_BASE,
  classifyStationKeeping,
  prefilterStationKeepingPairs,
  rpodKindsShareAFile,
  screenStationKeeping,
  stationKeepingAlertStep,
  stationKeepingHistorySql,
  stationKeepingLedgerKey,
  stationKeepingOptions,
  type ElementSample,
  type StationKeepingCatalog,
  type StationKeepingOptions,
} from "../lib/rpod/stationKeeping";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const DAY = 86400_000;
const T0 = Date.parse("2026-10-21T12:00:00Z");

function wrap360(deg: number): number {
  const x = deg % 360;
  return x < 0 ? x + 360 : x;
}

function el(over: Partial<ElementSample> & Pick<ElementSample, "norad">): ElementSample {
  return {
    epochMs: T0,
    incDeg: 97.8,
    raanDeg: 40,
    eccentricity: 0.001,
    argPerigeeDeg: 90,
    meanAnomalyDeg: 10,
    meanMotionRevPerDay: 15.1,
    ...over,
  };
}

/** Earlier epochs of a published elset, mean anomaly rewound at that mean motion. */
function historyFrom(base: ElementSample, daysAgo: number[]): ElementSample[] {
  return daysAgo.map((d) => ({
    ...base,
    epochMs: base.epochMs - d * DAY,
    meanAnomalyDeg: wrap360(base.meanAnomalyDeg - base.meanMotionRevPerDay * 360 * d),
  }));
}

function cat(norad: number, force: StationKeepingCatalog["force"], launchTag: string | null, payload = true): [number, StationKeepingCatalog] {
  return [norad, { force, payload, launchTag }];
}

function classifyPair(a: ElementSample, b: ElementSample, nowMs = T0 + 3600_000, opts?: StationKeepingOptions) {
  const days = [0, 2, 4, 6];
  return classifyStationKeeping(historyFrom(a, days), historyFrom(b, days), nowMs, opts);
}

console.log("gates that must stay put");
{
  const limits = relVelLimits({});
  check("red-on-blue velocity gate stays 200 m/s", limits.redBlueKmS * 1000 === DEFAULT_MAX_REL_VEL_RED_BLUE_MS);
  check("other velocity gate stays 70 m/s", limits.otherKmS * 1000 === DEFAULT_MAX_REL_VEL_MS);
  check("coplanar inclination gate stays 0.15°", DEFAULT_COALIGNED.maxIncDiffDeg === 0.15);
  check("coplanar RAAN gate stays 0.15°", DEFAULT_COALIGNED.maxRaanDiffDeg === 0.15);
  check("coplanar phase gate stays 6°", DEFAULT_COALIGNED.maxPhaseDiffDeg === 6);
  check("coplanar SGP4 range cap stays 250 km", COALIGNED_MAX_RANGE_KM === 250);
  check("coplanar SGP4 velocity cap stays 0.6 km/s", COALIGNED_MAX_RELVEL_KM_S === 0.6);
  check("default station-keeping offset cap is 1000 km", DEFAULT_STATION_KEEPING.maxOffsetKm === 1000);
  const widened = stationKeepingOptions({ RPOD_STATION_KEEP_MAX_OFFSET_KM: "1500" } as NodeJS.ProcessEnv);
  check("RPOD_STATION_KEEP_MAX_OFFSET_KM overrides the cap", widened.maxOffsetKm === 1500);
  const bogus = stationKeepingOptions({ RPOD_STATION_KEEP_MAX_OFFSET_KM: "nope" } as NodeJS.ProcessEnv);
  check("a non-numeric offset cap leaves the default", bogus.maxOffsetKm === 1000);
}

console.log("classification");
{
  const red = el({ norad: 100, meanAnomalyDeg: 10 });
  const blue = el({ norad: 200, meanAnomalyDeg: 14 });
  const held = classifyPair(red, blue);
  check("a steady few-hundred-km offset classifies", held != null && held.offsetKm > 200 && held.offsetKm < 900, JSON.stringify(held));
  check("zero mean-motion difference has no drift", held != null && Math.abs(held.driftKmPerDay) < 1, String(held?.driftKmPerDay));

  const far = el({ norad: 200, meanAnomalyDeg: 10 + 15 });
  check("1500 km class of offset is rejected", classifyPair(red, far) == null);

  const twelve = el({ norad: 200, meanAnomalyDeg: 10 + 10 });
  check("about 1200 km is rejected at the default cap", classifyPair(red, twelve) == null);

  const drifting = el({ norad: 200, meanAnomalyDeg: 12, meanMotionRevPerDay: 15.1 + 0.0046 });
  check("about 200 km/day of drift is rejected", classifyPair(red, drifting) == null);

  const skewed = el({ norad: 200, meanAnomalyDeg: 14, raanDeg: 42 });
  check("a 2° RAAN split is rejected", classifyPair(red, skewed) == null);

  const short = classifyStationKeeping(historyFrom(red, [0, 1]), historyFrom(blue, [0, 1]), T0 + 3600_000);
  check("fewer than 3 samples is rejected", short == null);
  const brief = classifyStationKeeping(historyFrom(red, [0, 0.5, 1]), historyFrom(blue, [0, 0.5, 1]), T0 + 3600_000);
  check("a span under 48 h is rejected", brief == null);

  const tight = stationKeepingOptions({ RPOD_STATION_KEEP_MAX_OFFSET_KM: "100" } as NodeJS.ProcessEnv);
  check("a lower configured cap rejects the same steady pair", classifyPair(red, blue, T0 + 3600_000, tight) == null);
}

console.log("prefilter");
{
  const red = el({ norad: 100, meanAnomalyDeg: 10 });
  const blue = el({ norad: 200, meanAnomalyDeg: 14 });
  const otherBlue = el({ norad: 201, meanAnomalyDeg: 12 });
  const neutral = el({ norad: 300, meanAnomalyDeg: 11 });
  const catalog = new Map<number, StationKeepingCatalog>([
    cat(100, "red", "2026-001"),
    cat(200, "blue", "2024-010"),
    cat(201, "blue", "2024-011"),
    cat(300, "neutral", "2020-001"),
  ]);
  const hits = prefilterStationKeepingPairs([red, blue, otherBlue, neutral], catalog, T0 + 3600_000);
  const keys = hits.map((h) => `${h.a.norad}:${h.b.norad}`).sort();
  check("prefilter keeps red-versus-blue only", JSON.stringify(keys) === JSON.stringify(["100:200", "100:201"]), keys.join(","));
  check("red is the signed-offset reference", hits.every((h) => h.a.norad === 100));

  const bothBlue = new Map<number, StationKeepingCatalog>([cat(100, "blue", "2024-001"), cat(200, "blue", "2024-002")]);
  check("blue-on-blue is not a station-keeping candidate",
    prefilterStationKeepingPairs([red, blue], bothBlue, T0 + 3600_000).length === 0);
  const redNeutral = new Map<number, StationKeepingCatalog>([cat(100, "red", "2026-001"), cat(300, "neutral", "2020-001")]);
  check("red-versus-neutral is not a station-keeping candidate",
    prefilterStationKeepingPairs([red, neutral], redNeutral, T0 + 3600_000).length === 0);
  const sameLaunch = new Map<number, StationKeepingCatalog>([cat(100, "red", "2026-083"), cat(200, "blue", "2026-083")]);
  check("a shared launch tag is excluded",
    prefilterStationKeepingPairs([red, blue], sameLaunch, T0 + 3600_000).length === 0);
  const debris = new Map<number, StationKeepingCatalog>([cat(100, "red", "2026-001", false), cat(200, "blue", "2024-010")]);
  check("a non-payload is excluded",
    prefilterStationKeepingPairs([red, blue], debris, T0 + 3600_000).length === 0);
}

console.log("Kosmos 2612 vs ICEYE-X36 (CelesTrak GP, epoch 2026-10-21)");
{
  // Published general perturbations. History below is these elements with
  // mean anomaly rewound at the published mean motion; plane and SMA stay
  // at the published values. Not an archive replay.
  const iceye = el({
    norad: 59103,
    epochMs: Date.parse("2026-10-21T07:19:02.618688Z"),
    incDeg: 97.8535,
    raanDeg: 74.8455,
    eccentricity: 0.00046118,
    argPerigeeDeg: 247.1663,
    meanAnomalyDeg: 112.9077,
    meanMotionRevPerDay: 15.07843995,
  });
  const kosmos2612 = el({
    norad: 68762,
    epochMs: Date.parse("2026-10-21T07:20:05.404704Z"),
    incDeg: 97.8544,
    raanDeg: 74.8448,
    eccentricity: 0.00063337,
    argPerigeeDeg: 259.8673,
    meanAnomalyDeg: 100.184,
    meanMotionRevPerDay: 15.07844969,
  });
  const pack = [
    el({
      norad: 68758,
      epochMs: Date.parse("2026-10-21T07:36:07.581888Z"),
      incDeg: 97.8237, raanDeg: 74.0985, eccentricity: 0.00101984,
      argPerigeeDeg: 355.5978, meanAnomalyDeg: 4.5157, meanMotionRevPerDay: 15.06973482,
    }),
    el({
      norad: 68759,
      epochMs: Date.parse("2026-10-21T06:54:14.566176Z"),
      incDeg: 97.8296, raanDeg: 73.5494, eccentricity: 0.00112155,
      argPerigeeDeg: 0.7481, meanAnomalyDeg: 359.3761, meanMotionRevPerDay: 15.06632067,
    }),
    kosmos2612,
    el({
      norad: 68763,
      epochMs: Date.parse("2026-10-21T06:37:05.699424Z"),
      incDeg: 97.7989, raanDeg: 73.5883, eccentricity: 0.00061125,
      argPerigeeDeg: 290.642, meanAnomalyDeg: 69.415, meanMotionRevPerDay: 15.05950135,
    }),
    el({
      norad: 68764,
      epochMs: Date.parse("2026-10-21T07:19:25.481856Z"),
      incDeg: 97.7965, raanDeg: 72.7517, eccentricity: 0.00052779,
      argPerigeeDeg: 321.4472, meanAnomalyDeg: 38.6376, meanMotionRevPerDay: 15.06223358,
    }),
  ];
  const nowMs = Date.parse("2026-10-21T12:00:00Z");
  const catalog = new Map<number, StationKeepingCatalog>([
    cat(59103, "blue", "2024-043"),
    ...pack.map((p) => cat(p.norad, "red" as const, "2026-083")),
  ]);
  const candidates = prefilterStationKeepingPairs([iceye, ...pack], catalog, nowMs);
  const paired = candidates.filter((c) => c.b.norad === 59103 || c.a.norad === 59103);
  check("only Kosmos 2612 plane-matches ICEYE-X36 inside the pack",
    paired.length === 1 && paired[0].a.norad === 68762 && paired[0].b.norad === 59103,
    paired.map((c) => `${c.a.norad}:${c.b.norad} off=${c.offsetKm.toFixed(1)}`).join(", "));

  const verdict = classifyPair(kosmos2612, iceye, nowMs);
  console.log(
    `  evidence 68762 vs 59103: offset=${verdict?.offsetKm.toFixed(1)} km`
    + ` signed=${verdict?.signedOffsetKm.toFixed(1)} km (red ahead of blue)`
    + ` drift=${verdict?.driftKmPerDay.toFixed(2)} km/day`
    + ` Δinc=${verdict?.dIncDeg.toFixed(4)}°`
    + ` ΔRAAN=${verdict?.dRaanDeg.toFixed(4)}°`
    + ` ΔSMA=${verdict?.dSmaKm.toFixed(3)} km`
    + ` trail=${verdict?.trailNorad} lead=${verdict?.leadNorad}`
    + ` samples=${verdict?.samples} spanDays=${verdict?.spanDays.toFixed(2)}`,
  );
  check("the pair classifies as station keeping", verdict != null);
  check("offset is a few hundred km, inside the 1000 km cap",
    verdict != null && verdict.offsetKm >= 400 && verdict.offsetKm <= 560, String(verdict?.offsetKm));
  check("Kosmos 2612 is the trailer and ICEYE-X36 is the leader",
    verdict?.trailNorad === 68762 && verdict?.leadNorad === 59103);
  check("implied drift stays under 5 km/day", verdict != null && Math.abs(verdict.driftKmPerDay) < 5, String(verdict?.driftKmPerDay));
  check("inclination split is under 0.01°", verdict != null && Math.abs(verdict.dIncDeg) < 0.01, String(verdict?.dIncDeg));
  check("RAAN split is under 0.01°", verdict != null && Math.abs(verdict.dRaanDeg) < 0.01, String(verdict?.dRaanDeg));
  check("SMA split is under 1 km", verdict != null && Math.abs(verdict.dSmaKm) < 1, String(verdict?.dSmaKm));
  check("published elements are not a suspected cross-tag", !isSuspectedCrossTag(kosmos2612, iceye));

  // CelesTrak publishes one elset for every vehicle docked to the ISS.
  // Nauka and Crew Dragon 13, epoch 2026-10-21T01:08:59.469792Z.
  const iss = el({
    norad: 49044,
    epochMs: Date.parse("2026-10-21T01:08:59.469792Z"),
    incDeg: 51.6327,
    raanDeg: 37.2623,
    eccentricity: 0.00067597,
    argPerigeeDeg: 289.5321,
    meanAnomalyDeg: 70.4938,
    meanMotionRevPerDay: 15.48967427,
  });
  const dragon = { ...iss, norad: 100882 };
  check("an ISS docked pair sharing one elset is a cross-tag, not a new case", isSuspectedCrossTag(iss, dragon));

  const screened = await screenStationKeeping({
    latest: [iceye, ...pack],
    catalog,
    nowMs,
    loadHistory: async (norads) => {
      check("history loader is asked only for the plane-matched pair",
        norads.length === 2 && norads.includes(68762) && norads.includes(59103), norads.join(","));
      const byId = new Map<number, ElementSample>([[68762, kosmos2612], [59103, iceye]]);
      return norads.flatMap((n) => {
        const base = byId.get(n);
        return base ? historyFrom(base, [0, 2, 4, 6]) : [];
      });
    },
  });
  check("screen returns the Kosmos/ICEYE hit",
    screened.hits.length === 1 && screened.hits[0].a === 68762 && screened.hits[0].b === 59103 && !screened.capped);

  const excluded = await screenStationKeeping({
    latest: [iceye, kosmos2612],
    catalog,
    excludePairs: new Set(["59103:68762"]),
    nowMs,
    loadHistory: async () => {
      check("an already-flagged pair does not seek history", false);
      return [];
    },
  });
  check("a pair already filed as conjunction/coplanar is left alone", excluded.hits.length === 0 && excluded.candidates === 0);
}

console.log("alerts");
{
  const onset = stationKeepingAlertStep(479, null, 0, 100);
  check("first sighting is an onset", onset.what === "onset" && onset.generation === 0 && onset.anchorKm === 479);
  const repeat = stationKeepingAlertStep(489, onset.anchorKm, onset.generation, 100);
  check("a 10 km wander does not re-alert", repeat.what === null && repeat.anchorKm === 479 && repeat.generation === 0);
  const change = stationKeepingAlertStep(580, repeat.anchorKm, repeat.generation, 100);
  check("a 100 km offset change alerts and advances the generation",
    change.what === "change" && change.generation === 1 && change.anchorKm === 580);

  const key = stationKeepingLedgerKey(42, 0);
  check("ledger keys sit above 1e9", key === STATION_KEEPING_LEDGER_BASE + 4200);
  check("onset key does not collide with +eventId or -eventId", key !== 42 && key !== -42);
  check("a later generation is a different ledger key", stationKeepingLedgerKey(42, 1) === key + 1);

  check("station keeping does not share a file with conjunction", !rpodKindsShareAFile("conjunction", "station-keeping"));
  check("station keeping does not share a file with coplanar", !rpodKindsShareAFile("coplanar", "station-keeping"));
  check("station keeping does not share a file with docked", !rpodKindsShareAFile("docked", "station-keeping"));
  check("station keeping matches only itself", rpodKindsShareAFile("station-keeping", "station-keeping"));
  check("conjunction still shares a file with coplanar", rpodKindsShareAFile("conjunction", "coplanar"));
  check("conjunction still shares a file with docked", rpodKindsShareAFile("conjunction", "docked"));

  const now = Date.parse("2026-10-21T12:00:00Z");
  const policy: PolicyEvent = {
    eventId: 50,
    kind: "station-keeping",
    members: [
      { norad: 68762, name: "COSMOS 2612", state: "CIS", objectClass: "P", opOrbit: "LEO", launchTag: "2026-083" },
      { norad: 59103, name: "ICEYE-X36", state: "US", objectClass: "P", opOrbit: "LEO", launchTag: "2024-043" },
    ],
    minRangeKm: 479,
    relVelKmS: 0.0001,
    firstDetectedAtMs: now - 3 * DAY,
    lastSeenAtMs: now,
    scanCount: 8,
    previousElsetEpochs: null,
  };
  const verdict = evaluateAlert(policy, now);
  check("evaluateAlert still rejects a 479 km station-keeping row as out of range",
    !verdict.eligible && verdict.reason === "range", verdict.reason);

  const text = formatStationKeepingCitation(
    { eventId: 50, kind: "station-keeping", members: [68762, 59103], minRangeKm: 479, relVelKmS: 0.0001, tcaMs: now },
    (n) => n === 68762 ? { name: "COSMOS 2612", launchTag: "2026-083" } : { name: "ICEYE-X36", launchTag: "2024-043" },
    {
      what: "onset", offsetKm: 479, driftKmPerDay: 0.4,
      dIncDeg: 0.0009, dRaanDeg: -0.0007, dSmaKm: -0.03,
      leadNorad: 59103, trailNorad: 68762,
    },
  );
  check("station-keeping citation fits the weighted 280 cap", weightedTweetLength(text) <= TWEET_MAX_WEIGHTED, `${weightedTweetLength(text)}: ${text}`);
  check("citation names the trailer and the offset", /COSMOS 2612/.test(text) && /479/.test(text));
}

console.log("history query");
{
  const since = new Date("2026-10-11T00:00:00Z");
  const until = new Date("2026-10-21T12:00:00Z");
  const query = stationKeepingHistorySql([68762, 59103, 68762], since, until, 12);
  const text = sqlTemplateText(query);
  check("candidate history is not a catalog-wide probe", historyLateralIsCatalogWide(text) === false, text.slice(0, 400));
  check("history reads obc_tle_history with a per-object LIMIT",
    /obc_tle_history/i.test(text) && /limit\s+12/i.test(text), text.slice(0, 500));
  check("history does not pull TLE text", !/line1/i.test(text) && !/line2/i.test(text));
  check("history is not DISTINCT norad FROM obc_objects", !/distinct\s+norad/i.test(text) && !/obc_objects/i.test(text));
  check("an empty NORAD list does not build a query", stationKeepingHistorySql([], since, until, 12) == null);
  const catalogWide = `
    select h.inc_deg from (select distinct norad from obc_objects) ids
    cross join lateral (
      select inc_deg from obc_tle_history where norad = ids.norad order by epoch desc limit 12
    ) h
  `;
  check("a catalog-driven lateral is still catalog-wide", historyLateralIsCatalogWide(catalogWide) === true);

  const here = dirname(fileURLToPath(import.meta.url));
  const scanSrc = readFileSync(join(here, "../lib/rpod/scan.ts"), "utf8");
  check("the scan loads station-keeping history through the bounded seek", /loadStationKeepingSamples\(/.test(scanSrc));
  check("the scan does not call getRecentSamples", !/getRecentSamples\(/.test(scanSrc));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll station-keeping checks passed");
