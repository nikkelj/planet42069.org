/**
 * Pure checks for the RPOD alert overhaul (no database):
 *  - forceOf maps GCAT and Space-Track codes, and debris inherits the launch
 *  - evaluateAlert keeps red-vs-blue/neutral shadowing and drops the noise classes
 *  - elsets must be fresh, close in time, and newer than the previous scan
 *  - a red-vs-blue pair is never "docked" from elsets; a cross-tag is excluded
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod-policy
 */
import {
  applyAlertCap,
  elsetsAdvanced,
  elsetsAreFresh,
  evaluateAlert,
  isKosmosOutsider,
  isPackOnPack,
  mayLabelDocked,
  relVelLimits,
  ELSET_MAX_AGE_MS,
  type PolicyEvent,
  type PolicyMember,
} from "../lib/rpod/alertPolicy";
import {
  DEFAULT_FORCE_TABLE,
  forceFromCode,
  forceOf,
  forceTable,
  forcesWarrantAlert,
  resetForceTableCache,
  sameForce,
  type Force,
} from "../lib/rpod/force";
import { designatorFromTleLine1, gcatIntlDesignator, launchTagFromIntl } from "../lib/obc/designator";
import { detectManeuver, isSuspectedCrossTag, type ElsetSnap } from "../lib/rpod/maneuver";
import { semiMajorAxisKm } from "../lib/rpod/screen";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-10-19T18:00:00Z");
const H = 3600_000;

function snap(epochMs: number, over: Partial<ElsetSnap> = {}): ElsetSnap {
  return {
    epochMs,
    incDeg: 97.854,
    raanDeg: 12.4,
    eccentricity: 0.0012,
    meanMotionRevPerDay: 15.07,
    argPerigeeDeg: 80,
    meanAnomalyDeg: 140,
    bstar: 1e-5,
    ...over,
  };
}

function member(norad: number, state: string, over: Partial<PolicyMember> = {}): PolicyMember {
  return {
    norad,
    name: `SAT ${norad}`,
    owner: null,
    state,
    gunterNation: null,
    objectClass: "P",
    opOrbit: "LEO",
    launchTag: null,
    elset: snap(NOW - 2 * H, { meanAnomalyDeg: (norad % 50) + 20 }),
    ...over,
  };
}

function base(over: Partial<PolicyEvent> = {}): PolicyEvent {
  return {
    eventId: 1082,
    kind: "coplanar",
    members: [member(68762, "RU", { name: "Kosmos-2612" }), member(59103, "US", { name: "ICEYE-X36" })],
    minRangeKm: 15.8,
    relVelKmS: 0.017,
    firstDetectedAtMs: NOW - 10 * H,
    lastSeenAtMs: NOW,
    scanCount: 4,
    previousElsetEpochs: null,
    ...over,
  };
}

console.log("forceOf");
{
  for (const code of ["RU", "RUS", "SU", "USSR", "CIS", "CN", "PRC", "CHINA", "IR", "IRAN", "KP", "PRK", "NKOR"]) {
    check(`${code} is red`, forceOf({ state: code }) === "red");
  }
  for (const code of ["US", "USA", "UK", "GBR", "J", "JPN", "FI", "FIN", "F", "FR", "SKOR", "CA", "AU"]) {
    check(`${code} is blue`, forceOf({ state: code }) === "blue");
  }
  for (const code of ["TBD", "ESA", "ISS", "INT", "NATO"]) {
    check(`${code} is neutral`, forceOf({ state: code }) === "neutral");
  }
  check("SU and RU are the same force", sameForce([forceOf({ state: "SU" }), forceOf({ state: "RU" })]));
  check("red-red does not warrant an alert", !forcesWarrantAlert([forceOf({ state: "SU" }), forceOf({ state: "RU" })]));
  check("red vs blue warrants an alert", forcesWarrantAlert([forceOf({ state: "RU" }), forceOf({ state: "US" })]));
  check("red vs neutral warrants an alert", forcesWarrantAlert([forceOf({ state: "CN" }), forceOf({ state: "TBD" })]));
  check("I-ESA resolves to Italy (blue)", forceFromCode("I-ESA") === "blue");
  check("US/RU on one string is neutral", forceFromCode("US/RU") === "neutral");
  check("unnamed debris inherits the launch state",
    forceOf({ name: "OBJECT B", objectClass: "D", state: null, launchState: "RU" }) === "red");
  check("a named payload does not inherit the launch state",
    forceOf({ name: "SOMETHING", objectClass: "P", state: null, launchState: "RU" }) === "neutral");
  check("owner is used when state is blank", forceOf({ state: null, owner: "PRC" }) === "red");
  const overlay: Record<string, Force> = { ...DEFAULT_FORCE_TABLE, IN: "blue" };
  check("caller table overlay classifies IN as blue", forceOf({ state: "IN" }, overlay) === "blue");
  resetForceTableCache();
  const fromEnv = forceTable({ RPOD_FORCE_TABLE: JSON.stringify({ BR: "red" }) } as NodeJS.ProcessEnv);
  check("RPOD_FORCE_TABLE JSON overlays a code", fromEnv.BR === "red");
  check("bad JSON overlay leaves the defaults", forceTable({ RPOD_FORCE_TABLE: "{nope" } as NodeJS.ProcessEnv).US === "blue");
  resetForceTableCache();
}

console.log("designator");
{
  check("GCAT tag + piece becomes a COSPAR id", gcatIntlDesignator("2024-043", "F") === "2024-043F");
  check("tag alone is kept when the piece is blank", gcatIntlDesignator("2026-083", null) === "2026-083");
  check("a full piece designator is not double-prefixed", gcatIntlDesignator("2024-043", "2024-043F") === "2024-043F");
  check("launch tag is the YYYY-NNN prefix", launchTagFromIntl("2026-083H") === "2026-083");
  const line1 = "1 68762U 26083H   26292.31400000  .00000000  00000-0  00000-0 0  9992";
  const parsed = designatorFromTleLine1(line1);
  check("TLE line 1 columns 10–17 recover 2026-083H",
    parsed?.intlDes === "2026-083H" && parsed.launchTag === "2026-083", JSON.stringify(parsed));
  check("blank TLE designator is null", designatorFromTleLine1("1 00000U          ") === null);
}

console.log("freshness");
{
  check("two elsets a few hours old and close together are fresh",
    elsetsAreFresh([NOW - 2 * H, NOW - 5 * H], NOW));
  check("an elset older than 24 h is stale",
    !elsetsAreFresh([NOW - ELSET_MAX_AGE_MS - 1000, NOW - H], NOW));
  check("elsets more than 12 h apart fail the skew gate",
    !elsetsAreFresh([NOW - 2 * H, NOW - 15 * H], NOW));
  check("one elset is not enough", !elsetsAreFresh([NOW - H], NOW));
  check("a first scan (no previous epochs) counts as advanced", elsetsAdvanced(null, { "1": NOW }));
  check("a newer epoch advances", elsetsAdvanced({ "1": NOW - 5 * H }, { "1": NOW - H }));
  check("an epoch that went backwards does not advance",
    !elsetsAdvanced({ "1": NOW - H }, { "1": NOW - 5 * H }));
  check("the same epoch again is not a new scan",
    !elsetsAdvanced({ "1": NOW - H, "2": NOW - 2 * H }, { "1": NOW - H, "2": NOW - 2 * H }));
}

console.log("docked sanity and cross-tag");
{
  check("a station stack may be labeled docked", mayLabelDocked([25544, 66664], ["neutral", "red"]));
  check("red vs blue is never docked from elsets", !mayLabelDocked([68762, 59103], ["red", "blue"]));
  check("red vs neutral is never docked from elsets", !mayLabelDocked([68762, 99901], ["red", "neutral"]));
  check("same-force uncatalogued pair may follow geometry", mayLabelDocked([99999201, 99999202], ["neutral", "neutral"]));
  const same = snap(NOW - H);
  check("near-identical elsets are a suspected cross-tag", isSuspectedCrossTag(same, { ...same, epochMs: NOW - H + 60_000 }));
  const separatedA = snap(NOW - 2 * H, { meanMotionRevPerDay: 15.078, raanDeg: 12.4, meanAnomalyDeg: 20 });
  const separatedB = snap(NOW - 6 * H, { meanMotionRevPerDay: 15.07, raanDeg: 12.6, meanAnomalyDeg: 200 });
  check("the real 2612/X36 element split is not a cross-tag", !isSuspectedCrossTag(separatedA, separatedB));
}

console.log("maneuver");
{
  const prev = snap(NOW - 26 * H, { meanMotionRevPerDay: 15.2 });
  const curr = snap(NOW - 2 * H, { meanMotionRevPerDay: 15.07 });
  const target = snap(NOW - 2 * H, { meanMotionRevPerDay: 15.07, incDeg: 97.854 });
  const mark = detectManeuver(prev, curr, target);
  const dSma = semiMajorAxisKm(15.07) - semiMajorAxisKm(15.2);
  check("an SMA change past the drag budget is a burn", mark != null && mark.beyondDrag, JSON.stringify(mark));
  check("a burn that lands on the target's SMA is a match", mark?.relation === "match", `dSma=${dSma.toFixed(2)} rel=${mark?.relation}`);
  const away = detectManeuver(curr, prev, target);
  check("a burn that leaves the target is a departure", away?.relation === "depart", away?.relation);
  const noise = detectManeuver(snap(NOW - 5 * H), snap(NOW - 2 * H, { meanMotionRevPerDay: 15.0701 }));
  check("meter-scale drag noise is not a burn", noise == null);
}

console.log("alert selection");
{
  const kosmos = evaluateAlert(base(), NOW);
  check("Kosmos-2612 shadowing ICEYE-X36 is eligible", kosmos.eligible && kosmos.reason === "kosmos", kosmos.reason);
  check("the Kosmos pack bypasses the daily cap", kosmos.bypassCap === true);
  check("coplanar shadowing is allowed to alert", kosmos.eligible && base().kind === "coplanar");

  const redRed = evaluateAlert(base({
    members: [member(11111, "RU", { name: "KOSMOS-X" }), member(22222, "SU", { name: "COSMOS-Y" })],
  }), NOW);
  check("red-red (SU vs RU) is not an alert", !redRed.eligible && redRed.reason === "red-red", redRed.reason);

  const pack = evaluateAlert(base({
    eventId: 9,
    members: [member(68758, "RU"), member(68762, "RU")],
    minRangeKm: 3,
  }), NOW);
  check("pack-on-pack at kilometer range is not an alert", !pack.eligible && pack.reason === "pack-on-pack", pack.reason);
  check("2612 vs a non-pack object is the outsider case", isKosmosOutsider([68762, 59103]) && !isPackOnPack([68762, 59103]));

  const blueBlue = evaluateAlert(base({
    members: [member(40001, "US", { name: "STARLINK" }), member(40002, "UK", { name: "ONEWEB" })],
  }), NOW);
  check("low-velocity blue-on-blue is not an alert", !blueBlue.eligible && blueBlue.reason === "not-red-blue", blueBlue.reason);

  const exercise = evaluateAlert(base({
    eventId: 12,
    members: [member(40001, "US"), member(40002, "US")],
    minRangeKm: 8,
    relVelKmS: 0.02,
  }), NOW, [{ norad: 40001, expiresAtMs: NOW + H }]);
  check("an active exercise flag lets blue-on-blue through", exercise.eligible && exercise.reason === "exercise", exercise.reason);
  const expired = evaluateAlert(base({
    members: [member(40001, "US"), member(40002, "US")],
    relVelKmS: 0.02,
  }), NOW, [{ norad: 40001, expiresAtMs: NOW - H }]);
  check("an expired exercise flag does not", !expired.eligible);

  const near = evaluateAlert(base({
    eventId: 15,
    kind: "conjunction",
    members: [member(50001, "US"), member(50002, "US")],
    minRangeKm: 0.15,
    relVelKmS: 0.04,
  }), NOW);
  check("a ~150 m non-docked same-operator miss alerts", near.eligible && near.reason === "near-miss", near.reason);

  const fast = evaluateAlert(base({ relVelKmS: 0.4 }), NOW);
  check("red-blue at 400 m/s is over the 200 m/s ceiling", !fast.eligible && fast.reason === "fast", fast.reason);
  const underRedBlue = evaluateAlert(base({ relVelKmS: 0.15 }), NOW);
  check("red-blue at 150 m/s still alerts", underRedBlue.eligible && underRedBlue.reason === "kosmos", underRedBlue.reason);
  const atCeiling = evaluateAlert(base({ relVelKmS: 0.2 }), NOW);
  check("red-blue at exactly 200 m/s is not under the ceiling", !atCeiling.eligible && atCeiling.reason === "fast", atCeiling.reason);
  const neutralFast = evaluateAlert(base({
    eventId: 21,
    members: [member(11111, "RU", { name: "KOSMOS-X" }), member(70001, "TBD", { name: "UNKNOWN" })],
    relVelKmS: 0.08,
  }), NOW);
  check("red-vs-neutral above 70 m/s is out", !neutralFast.eligible && neutralFast.reason === "fast", neutralFast.reason);
  const otherSlow = evaluateAlert(base({
    eventId: 22,
    kind: "conjunction",
    members: [member(50001, "US"), member(50002, "US")],
    minRangeKm: 0.15,
    relVelKmS: 0.06,
  }), NOW);
  check("a same-operator miss under 70 m/s still alerts", otherSlow.eligible && otherSlow.reason === "near-miss", otherSlow.reason);
  const tightening = evaluateAlert(base({
    relVelKmS: 0.15,
    minRangeKm: 8,
    scanCount: 1,
    firstDetectedAtMs: NOW,
    previousMinRangeKm: 18,
  }), NOW);
  check("a tightening red-blue miss skips the two-scan wait", tightening.eligible, tightening.reason);
  const firstLook = evaluateAlert(base({
    relVelKmS: 0.15,
    minRangeKm: 8,
    scanCount: 1,
    firstDetectedAtMs: NOW,
    previousMinRangeKm: null,
  }), NOW);
  check("a first red-blue look is not yet persistent", !firstLook.eligible && firstLook.reason === "not-persistent", firstLook.reason);
  const widening = evaluateAlert(base({
    relVelKmS: 0.15,
    minRangeKm: 18,
    scanCount: 1,
    firstDetectedAtMs: NOW,
    previousMinRangeKm: 8,
  }), NOW);
  check("a widening red-blue miss still needs persistence", !widening.eligible && widening.reason === "not-persistent", widening.reason);

  const siblingCluster = evaluateAlert(base({
    eventId: 1623,
    kind: "conjunction",
    minRangeKm: 2.713,
    relVelKmS: 0.041,
    members: [
      member(60475, "TR", { name: "Connecta T4.3", launchTag: "2024-149", closestRangeKm: 13.772, closestRelVelKmS: 0.0772 }),
      member(67286, "RU", { name: "Mule-4T", launchTag: "2025-313", closestRangeKm: 2.713, closestRelVelKmS: 0.041 }),
      member(67292, "RU", { name: "SITRO-AIS-64", launchTag: "2025-313", closestRangeKm: 2.713, closestRelVelKmS: 0.041 }),
    ],
  }), NOW);
  check("a same-launch sibling pair does not carry a cluster that merely includes an outsider",
    !siblingCluster.eligible && (siblingCluster.reason === "fast" || siblingCluster.reason === "not-slow" || siblingCluster.reason === "co-launched"),
    siblingCluster.reason);

  const realOutsider = evaluateAlert(base({
    eventId: 1718,
    kind: "conjunction",
    minRangeKm: 3.777,
    relVelKmS: 0.0118,
    members: [
      member(62726, "PRC", { name: "OBJECT B", objectClass: "U", launchTag: "2025-012", closestRangeKm: 3.777, closestRelVelKmS: 0.0118 }),
      member(66721, "US", { name: "Flock 4h-18", launchTag: "2025-276", closestRangeKm: 3.777, closestRelVelKmS: 0.0118 }),
      member(66754, "FI", { name: "ICEYE-X61", launchTag: "2025-276", closestRangeKm: 6.385, closestRelVelKmS: 0.0273 }),
    ],
  }), NOW);
  check("a red unknown tight with a western payload still alerts",
    realOutsider.eligible, realOutsider.reason);

  const siblings = evaluateAlert(base({
    members: [
      member(1, "CN", { launchTag: "2024-043" }),
      member(2, "US", { launchTag: "2024-043" }),
    ],
  }), NOW);
  check("same-launch siblings are not an alert", !siblings.eligible && siblings.reason === "co-launched", siblings.reason);

  const bogus = evaluateAlert(base({
    eventId: 1638,
    kind: "docked",
    minRangeKm: 0.01,
    relVelKmS: 0.0001,
  }), NOW);
  check("event 1638 style red-vs-blue 'docked' at 10 m is excluded", !bogus.eligible && bogus.reason === "bogus-docked", bogus.reason);

  const station = evaluateAlert(base({
    kind: "docked",
    members: [member(25544, "US", { name: "ISS" }), member(66664, "RU")],
    minRangeKm: 0.01,
    relVelKmS: 0.0001,
  }), NOW);
  check("a real station stack is docked, not an alert", !station.eligible && station.reason === "docked", station.reason);

  const crossed = evaluateAlert(base({
    suspectedCrossTag: true,
  }), NOW);
  check("a suspected cross-tag is excluded", !crossed.eligible && crossed.reason === "cross-tag", crossed.reason);

  const stale = evaluateAlert(base({
    members: [
      member(11111, "RU", { name: "KOSMOS-X", elset: snap(NOW - 30 * H, { meanAnomalyDeg: 10 }) }),
      member(22222, "US", { name: "WESTERN", elset: snap(NOW - 30 * H, { meanAnomalyDeg: 200 }) }),
    ],
  }), NOW);
  check("elsets older than 24 h block the alert", !stale.eligible && stale.reason === "stale-elset", stale.reason);

  const skew = evaluateAlert(base({
    members: [
      member(68762, "RU", { elset: snap(NOW - H) }),
      member(59103, "US", { elset: snap(NOW - 20 * H) }),
    ],
  }), NOW);
  check("elsets more than 12 h apart block the alert", !skew.eligible && skew.reason === "stale-elset", skew.reason);

  const once = evaluateAlert(base({ scanCount: 1, firstDetectedAtMs: NOW }), NOW);
  check("a single scan is not persistent", !once.eligible && once.reason === "not-persistent", once.reason);
  const shortSpan = evaluateAlert(base({ firstDetectedAtMs: NOW - 2 * H, scanCount: 3 }), NOW);
  check("two scans inside 6 h are not persistent yet", !shortSpan.eligible && shortSpan.reason === "not-persistent", shortSpan.reason);
  const rewound = evaluateAlert(base({
    previousElsetEpochs: { "68762": NOW - H, "59103": NOW - H },
    members: [
      member(68762, "RU", { elset: snap(NOW - 5 * H) }),
      member(59103, "US", { elset: snap(NOW - 5 * H, { meanAnomalyDeg: 10 }) }),
    ],
  }), NOW);
  check("elsets that did not move forward are not a new observation", !rewound.eligible && rewound.reason === "not-persistent", rewound.reason);

  const far = evaluateAlert(base({ minRangeKm: 40 }), NOW);
  check("LEO beyond 30 km is out of range", !far.eligible && far.reason === "range", far.reason);

  const neutral = evaluateAlert(base({
    eventId: 20,
    members: [member(11111, "RU", { name: "KOSMOS-X" }), member(70001, "TBD", { name: "UNKNOWN" })],
  }), NOW);
  check("red vs neutral is eligible", neutral.eligible && neutral.reason === "red-blue", neutral.reason);
  check("red-blue outranks red-neutral", kosmos.score > neutral.score, `${kosmos.score} vs ${neutral.score}`);
}

console.log("daily cap");
{
  const items = [
    { id: "low", score: 5, bypassCap: false },
    { id: "mid", score: 20, bypassCap: false },
    { id: "kosmos", score: 1000, bypassCap: true },
    { id: "high", score: 40, bypassCap: false },
  ];
  const capped = applyAlertCap(items, 0, 2);
  const posted = capped.filter((c) => c.post).map((c) => c.item.id);
  const held = capped.filter((c) => c.held).map((c) => c.item.id);
  check("best score and the Kosmos bypass post", posted.includes("kosmos") && posted.includes("high") && posted.includes("mid"), posted.join(","));
  check("the leftover is held, not dropped", held.length === 1 && held[0] === "low" && posted.length + held.length === items.length, held.join(","));
  const full = applyAlertCap([{ id: "a", score: 10, bypassCap: false }, { id: "k", score: 1, bypassCap: true }], 2, 2);
  check("a full day still posts the bypass and holds the rest",
    full.find((c) => c.item.id === "k")?.post === true && full.find((c) => c.item.id === "a")?.held === true);
}

console.log("velocity ceilings");
{
  const custom = relVelLimits({ RPOD_MAX_REL_VEL_MS: "40", RPOD_MAX_REL_VEL_RED_BLUE_MS: "90" } as NodeJS.ProcessEnv);
  check("RPOD_MAX_REL_VEL_MS and RPOD_MAX_REL_VEL_RED_BLUE_MS override the defaults",
    custom.otherKmS === 0.04 && custom.redBlueKmS === 0.09, JSON.stringify(custom));
  check("a blank or bad override keeps 70 and 200",
    relVelLimits({ RPOD_MAX_REL_VEL_MS: "nope", RPOD_MAX_REL_VEL_RED_BLUE_MS: "" } as NodeJS.ProcessEnv).otherKmS === 0.07
    && relVelLimits({} as NodeJS.ProcessEnv).redBlueKmS === 0.2);
  const prev = process.env.RPOD_MAX_REL_VEL_RED_BLUE_MS;
  process.env.RPOD_MAX_REL_VEL_RED_BLUE_MS = "90";
  try {
    const gated = evaluateAlert(base({ relVelKmS: 0.1 }), NOW);
    check("the live red-blue ceiling rejects 100 m/s when set to 90", !gated.eligible && gated.reason === "fast", gated.reason);
  } finally {
    if (prev == null) delete process.env.RPOD_MAX_REL_VEL_RED_BLUE_MS;
    else process.env.RPOD_MAX_REL_VEL_RED_BLUE_MS = prev;
  }
  const kosmosNeutral = evaluateAlert(base({
    members: [member(68764, "RU", { name: "Kosmos-2614" }), member(80001, "TBD", { name: "UNOWNED" })],
    relVelKmS: 0.15,
  }), NOW);
  check("Kosmos-2614 versus a neutral outsider uses the 200 m/s ceiling",
    kosmosNeutral.eligible && kosmosNeutral.reason === "kosmos", kosmosNeutral.reason);
  const packFast = evaluateAlert(base({
    members: [member(68758, "RU"), member(68764, "RU", { name: "Kosmos-2614" })],
    minRangeKm: 3,
    relVelKmS: 0.01,
  }), NOW);
  check("pack-on-pack still never alerts", !packFast.eligible && packFast.reason === "pack-on-pack", packFast.reason);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll RPOD alert-policy checks passed");
