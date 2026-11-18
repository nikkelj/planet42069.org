/**
 * Provisional Starship mass: retire when GCAT lists a payload mass, and never
 * let that row also be counted by the Falcon-median pending estimator.
 *
 * Run with: pnpm --filter @workspace/api-server run test:provisional
 */
import type { LaunchEntry } from "../lib/launch";
import type { SatcatEntry } from "../lib/satcat";
import { buildMassModel } from "../lib/obc/estimate";
import {
  activeProvisional,
  annotateManifest,
  cataloguedPayloadMassKg,
  classifySite,
  getProvisionalManifest,
  launchCoveredByManifest,
  manifestVehicleLabel,
  objectChartMass,
  replacementMassByLabel,
  selectPendingFalcon,
  type ManifestEntry,
} from "../lib/provisional";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function payload(partial: Partial<SatcatEntry> & Pick<SatcatEntry, "name">): SatcatEntry {
  return {
    jcat: partial.jcat ?? "S00000",
    satno: partial.satno ?? null,
    name: partial.name,
    plName: partial.plName ?? null,
    ldate: partial.ldate ?? null,
    lv: partial.lv ?? null,
    lvFamily: partial.lvFamily ?? null,
    site: partial.site ?? null,
    owner: partial.owner ?? null,
    state: partial.state ?? null,
    objectClass: partial.objectClass ?? "P",
    objType: partial.objType ?? "P",
    opOrbit: partial.opOrbit ?? "LEO",
    satState: partial.satState ?? "O",
    massKg: partial.massKg ?? null,
    massEstimated: partial.massEstimated ?? false,
    apogeeKm: null,
    perigeeKm: null,
    incDeg: null,
    periodMin: null,
    decayDate: null,
    gunterType: null,
    gunterNation: null,
    gunterOperator: null,
    gunterContractors: null,
    gunterUrl: null,
    gunterTitle: null,
    gunterRetrievedAt: null,
    launchTag: partial.launchTag ?? null,
  };
}

function launch(partial: Partial<LaunchEntry> & Pick<LaunchEntry, "launchTag">): LaunchEntry {
  return {
    launchTag: partial.launchTag,
    lv: partial.lv ?? null,
    lvFamily: partial.lvFamily ?? null,
    site: partial.site ?? null,
    ldate: partial.ldate ?? null,
    orbital: partial.orbital ?? true,
  };
}

const NOW = Date.parse("2026-11-16T12:00:00Z");

function blankEntry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  const base: ManifestEntry = {
    id: "synthetic",
    launchDate: "2026-11-01",
    launchDateTimeUtc: "2026-11-01T00:00:00Z",
    vehicle: "Falcon 9",
    lvFamilyIncludes: "falcon",
    site: "Cape Canaveral",
    siteClass: "capeCanaveral",
    payloadName: "Starlink",
    payloadCount: 20,
    perSatMassKg: 1000,
    perSatLowKg: 1000,
    perSatHighKg: 1000,
    massKg: 20000,
    massLowKg: 20000,
    massHighKg: 20000,
    basis: "estimated",
    sourceUrls: ["https://example.test/source"],
    note: "synthetic",
    calc: {
      title: "synthetic",
      formula: "20 × 1,000",
      inputs: [{ name: "count", value: "20", kind: "editorial", source: "test" }],
      resultKg: 20000,
      rangeKg: [20000, 20000],
      markdownPath: "does-not-exist.md",
    },
    match: {
      ldate: "2026-11-01",
      lvFamilyIncludes: "falcon",
      launchTag: "2026-300",
      payloadNameIncludes: "STARLINK",
      siteHints: ["CC", "KSC"],
    },
  };
  return {
    ...base,
    ...over,
    calc: { ...base.calc, ...over.calc },
    match: { ...base.match, ...over.match },
  };
}

function main() {
  console.log("checked-in manifest:");
  const empty = getProvisionalManifest([]);
  const ids = empty.entries.map((e) => e.id);
  check("books flight 14 and flight 15", ids, ["starship-flight-14", "starship-flight-15"]);
  check("does not book flight 13", ids.includes("starship-flight-13"), false);
  check("both active when GCAT has no mass", empty.entries.every((e) => e.retired === false), true);
  check("active mass is 39 t + 39 t", empty.activeMassKg, 78000);
  check("no catalogued or estimator mass when the catalog is empty", empty.entries.map((e) => [e.cataloguedMassKg, e.estimatedMassKg]), [[0, 0], [0, 0]]);
  check("retire note does not treat a Bureau estimate as catalogued", empty.note.includes("Bureau estimate") && empty.note.includes("does not count as catalogued"), true);
  for (const e of empty.entries) {
    check(`${e.id} basis estimated`, e.basis, "estimated");
    check(`${e.id} per-sat booked / low / high`, [e.perSatMassKg, e.perSatLowKg, e.perSatHighKg], [1500, 1500, 2500]);
    check(`${e.id} batch booked / low / high`, [e.massKg, e.massLowKg, e.massHighKg], [39000, 39000, 65000]);
    check(`${e.id} count times booked unit`, e.payloadCount * e.perSatMassKg, e.massKg);
    check(`${e.id} count times high unit`, e.payloadCount * e.perSatHighKg, e.massHighKg);
    check(`${e.id} calc result matches booked`, e.calc.resultKg, 39000);
    check(`${e.id} calc range`, e.calc.rangeKg, [39000, 65000]);
    check(`${e.id} site class is starbase`, e.siteClass, "starbase");
    check(`${e.id} markdown is the published calc`, e.markdown.includes("ESTIMATED / provisional") && e.markdown.includes("39,000 kg"), true);
    check(`${e.id} markdown says a Bureau estimate does not retire the row`, e.markdown.includes("not a Bureau estimate") && e.markdown.includes("does not retire this row"), true);
    check(`${e.id} inputs are tagged`, e.calc.inputs.every((i) => i.kind === "published" || i.kind === "derived" || i.kind === "editorial"), true);
    check(`${e.id} has an editorial booked unit`, e.calc.inputs.some((i) => i.kind === "editorial" && i.value.includes("1,500")), true);
    check(`${e.id} has a derived ceiling`, e.calc.inputs.some((i) => i.kind === "derived" && i.value.includes("1,667")), true);
  }
  const f15 = empty.entries.find((e) => e.id === "starship-flight-15")!;
  const f14 = empty.entries.find((e) => e.id === "starship-flight-14")!;
  check("flight 15 identity", [f15.launchDate, f15.launchDateTimeUtc, f15.match.launchTag, f15.payloadCount], ["2026-11-13", "2026-11-13T22:47:36Z", "2026-256", 26]);
  check("flight 14 identity", [f14.launchDate, f14.launchDateTimeUtc, f14.match.launchTag, f14.payloadCount], ["2026-09-28", "2026-09-28T12:48:59Z", "2026-225", 26]);
  check("flight 15 markdown names the flight", f15.markdown.includes("Flight 15") && f15.markdown.includes("2026-256"), true);
  check("flight 14 markdown names the flight", f14.markdown.includes("Flight 14") && f14.markdown.includes("2026-225"), true);
  check("flight 13 is called out as not booked", f14.markdown.includes("Flight 13 itself is not booked"), true);

  console.log("retire:");
  const withMass = [
    payload({ name: "STARLINK V3", launchTag: "2026-256", ldate: "2026-11-13", lvFamily: "Starship", site: "BC", massKg: 1600 }),
  ];
  const retired = getProvisionalManifest(withMass);
  const r15 = retired.entries.find((e) => e.id === "starship-flight-15")!;
  const r14 = retired.entries.find((e) => e.id === "starship-flight-14")!;
  check("flight 15 retires once GCAT lists payload mass", r15.retired, true);
  check("flight 15 catalogued mass is the sum", r15.cataloguedMassKg, 1600);
  check("flight 15 estimator mass is separate and empty", r15.estimatedMassKg, 0);
  check("flight 14 stays active", r14.retired, false);
  check("retired row is excluded from active mass", retired.activeMassKg, 39000);
  check("activeProvisional drops the retired row", activeProvisional(retired).map((e) => e.id), ["starship-flight-14"]);

  const zeroMass = [
    payload({ name: "OBJECT A", launchTag: "2026-256", ldate: "2026-11-13", lvFamily: "Starship", site: "BC", massKg: 0 }),
    payload({ name: "OBJECT B", launchTag: "2026-256", ldate: "2026-11-13", lvFamily: "Starship", site: "BC", massKg: null }),
  ];
  check("zero or unknown payload mass does not retire", getProvisionalManifest(zeroMass).entries.every((e) => !e.retired), true);

  const rocketBody = [
    payload({ name: "STARSHIP", launchTag: "2026-256", objectClass: "R", ldate: "2026-11-13", lvFamily: "Starship", site: "BC", massKg: 120000 }),
  ];
  check("a rocket body on the same tag does not retire", getProvisionalManifest(rocketBody).entries.every((e) => !e.retired), true);

  const otherLaunchSameDay = [
    payload({ name: "STARLINK", launchTag: "2026-999", ldate: "2026-11-13", lvFamily: "Falcon 9", site: "CC", massKg: 14000 }),
  ];
  check("another launch on the same date does not retire flight 15", getProvisionalManifest(otherLaunchSameDay).entries.find((e) => e.id === "starship-flight-15")!.retired, false);

  console.log("fallback match is not date alone:");
  const untagged = blankEntry({
    id: "untagged-starship",
    launchDate: "2026-11-13",
    vehicle: "Starship",
    lvFamilyIncludes: "starship",
    site: "Starbase",
    siteClass: "starbase",
    match: {
      ldate: "2026-11-13",
      lvFamilyIncludes: "starship",
      launchTag: null,
      payloadNameIncludes: "STARLINK",
      siteHints: ["BC", "STARBASE"],
    },
  });
  const dateOnly = [payload({ name: "STARLINK", ldate: "2026-11-13", lvFamily: "Falcon 9", site: "CC", massKg: 8000 })];
  check("date alone does not match", cataloguedPayloadMassKg(dateOnly, untagged), 0);
  const dateAndVehicleWrongSite = [payload({ name: "STARLINK", ldate: "2026-11-13", lvFamily: "Starship", site: "CC", massKg: 8000 })];
  check("date + vehicle without the site does not match", cataloguedPayloadMassKg(dateAndVehicleWrongSite, untagged), 0);
  const dateVehicleSite = [payload({ name: "STARLINK-A", ldate: "2026-11-13", lvFamily: "Starship", site: "BC", massKg: 1000 })];
  check("date + vehicle + site matches", cataloguedPayloadMassKg(dateVehicleSite, untagged), 1000);
  const wrongName = [payload({ name: "CUBESAT", plName: "DEMO", ldate: "2026-11-13", lvFamily: "Starship", site: "BC", massKg: 50 })];
  check("payload-name hint rejects a different payload", cataloguedPayloadMassKg(wrongName, untagged), 0);
  const summed = [
    payload({ name: "STARLINK-A", ldate: "2026-11-13", lvFamily: "Starship", site: "BC", massKg: 1000 }),
    payload({ name: "STARLINK-B", ldate: "2026-11-13", lvFamily: "Starship", site: "Starbase", massKg: 500 }),
  ];
  check("fallback sums every matching payload", cataloguedPayloadMassKg(summed, untagged), 1500);
  check("fallback retires only when that sum is > 0", annotateManifest(summed, [untagged])[0].retired, true);
  check("fallback stays active at zero", annotateManifest(dateOnly, [untagged])[0].retired, false);

  console.log("no double counting:");
  const manifestFalcon = blankEntry();
  const falconLaunch = launch({ launchTag: "2026-300", lvFamily: "Falcon 9", lv: "Falcon 9", site: "CC", ldate: "2026-11-01" });
  const starshipLaunch = launch({ launchTag: "2026-256", lvFamily: "Starship", lv: "Starship", site: "BC", ldate: "2026-11-13" });
  const otherFalcon = launch({ launchTag: "2026-301", lvFamily: "Falcon 9", lv: "Falcon 9", site: "VSFB", ldate: "2026-11-13" });
  const launches = [falconLaunch, starshipLaunch, otherFalcon];
  const fileEntries = getProvisionalManifest([]).entries;

  check("manifest tag covers that launch", launchCoveredByManifest(falconLaunch, [manifestFalcon]), true);
  check("starship manifest does not cover a same-day Falcon", launchCoveredByManifest(otherFalcon, fileEntries), false);
  check("starship launch is covered by its manifest row", launchCoveredByManifest(starshipLaunch, fileEntries), true);

  const pending = selectPendingFalcon([], launches, NOW, [manifestFalcon, ...fileEntries]);
  check("manifest Falcon is not also in the Falcon-median series", pending.some((p) => p.ldate === "2026-11-01"), false);
  check("Starship is never given the Falcon median", pending.every((p) => p.siteClass !== "starbase"), true);
  check("an uncovered Falcon still gets the median estimate", pending.map((p) => [p.ldate, p.siteClass, p.estMassKg]), [["2026-11-13", "vandenberg", 14000]]);

  const annotated = annotateManifest([], [manifestFalcon]);
  const bothSeries = annotated.filter((e) => !e.retired).reduce((s, e) => s + e.massKg, 0)
    + pending.reduce((s, p) => s + p.estMassKg, 0);
  check("manifest mass and Falcon median are not both added for the covered launch", bothSeries, 20000 + 14000);

  const cataloguedFalcon = [payload({ name: "STARLINK", launchTag: "2026-301", ldate: "2026-11-13", lvFamily: "Falcon 9", site: "VSFB", massKg: 15000 })];
  const pendingAfterCatalog = selectPendingFalcon(cataloguedFalcon, launches, NOW, [manifestFalcon, ...fileEntries]);
  check("catalogued Falcon mass suppresses the median for that launch only", pendingAfterCatalog, []);

  const retiredAndPending = selectPendingFalcon(withMass, launches, NOW, fileEntries);
  check("retired Starship is not revived as a Falcon estimate", retiredAndPending.some((p) => p.ldate === "2026-11-13" && p.siteClass === "starbase"), false);

  console.log("estimator mass does not retire, and totals count the manifest once:");
  // 25 × 594 + 600 = 15,450 kg, the Falcon-era STARLINK median painted onto Flight 14.
  const flight14Masses = [...Array(25).fill(594), 600];
  const flight14Estimated = flight14Masses.map((massKg, i) => payload({
    name: `STARLINK-${11400 + i}`,
    launchTag: "2026-225",
    ldate: "2026-09-28",
    lvFamily: "Starship",
    lv: "Starship",
    site: "BC",
    massKg,
    massEstimated: true,
    state: "US",
  }));
  const uncoveredFalcon = payload({
    name: "STARLINK-1",
    launchTag: "2026-100",
    ldate: "2026-06-01",
    lvFamily: "Falcon 9",
    lv: "Falcon 9",
    site: "CC",
    massKg: 800,
    massEstimated: true,
  });
  const estimatedCatalog = [...flight14Estimated, uncoveredFalcon];
  const estimatedManifest = getProvisionalManifest(estimatedCatalog);
  const est14 = estimatedManifest.entries.find((e) => e.id === "starship-flight-14")!;
  const est15 = estimatedManifest.entries.find((e) => e.id === "starship-flight-15")!;
  check("flight 14 stays active when every matched mass is estimated", est14.retired, false);
  check("flight 14 catalogued mass ignores estimates", est14.cataloguedMassKg, 0);
  check("flight 14 estimated mass is reported separately", est14.estimatedMassKg, 15450);
  check("flight 15 stays active beside the estimated flight 14", est15.retired, false);
  check("both flights stay in the booked total", estimatedManifest.activeMassKg, 78000);
  const activeEstimated = estimatedManifest.entries.filter((e) => !e.retired);
  let countedObjectKg = 0;
  for (const e of estimatedCatalog) {
    const parts = objectChartMass(e, activeEstimated);
    countedObjectKg += parts.cataloguedKg + parts.estimatedKg;
  }
  const bookedKg = activeEstimated.reduce((s, e) => s + e.massKg, 0);
  check("flight 14 estimator mass is not added beside its 39,000 kg", countedObjectKg + bookedKg, 800 + 78000);
  const flight14ObjectKg = flight14Estimated.reduce((s, e) => {
    const parts = objectChartMass(e, activeEstimated);
    return s + parts.cataloguedKg + parts.estimatedKg;
  }, 0);
  check("flight 14 objects contribute 0 kg to chart totals", flight14ObjectKg, 0);
  check("flight 14 is counted once, as the manifest figure", flight14ObjectKg + est14.massKg, 39000);
  const byYear = replacementMassByLabel(
    estimatedCatalog,
    activeEstimated,
    (e) => e.ldate?.slice(0, 4) ?? null,
    (entry) => entry.launchDate.slice(0, 4),
  );
  check("by-year replacement is both booked flights, not 15,450", byYear.get("2026"), 78000);
  const byVehicle = replacementMassByLabel(
    estimatedCatalog,
    activeEstimated,
    (e) => e.lvFamily ?? e.lv,
    (entry) => manifestVehicleLabel(entry, estimatedCatalog),
  );
  check("by-vehicle replacement is Starship 78,000 once", byVehicle.get("Starship"), 78000);
  const byState = replacementMassByLabel(estimatedCatalog, activeEstimated, (e) => e.state);
  check("country breakdown replaces flight 14's estimator mass with 39,000", byState.get("US"), 39000);

  console.log("real GCAT mass still retires:");
  const realFlight14 = [
    payload({
      name: "STARLINK V3",
      launchTag: "2026-225",
      ldate: "2026-09-28",
      lvFamily: "Starship",
      site: "BC",
      massKg: 41000,
      massEstimated: false,
    }),
  ];
  const realManifest = getProvisionalManifest(realFlight14);
  const real14 = realManifest.entries.find((e) => e.id === "starship-flight-14")!;
  const real15 = realManifest.entries.find((e) => e.id === "starship-flight-15")!;
  check("real mass retires flight 14", real14.retired, true);
  check("real mass is the catalogued sum", real14.cataloguedMassKg, 41000);
  check("real mass leaves estimator mass at 0", real14.estimatedMassKg, 0);
  check("flight 15 stays booked", real15.retired, false);
  check("retired flight drops out of the booked total", realManifest.activeMassKg, 39000);
  const activeReal = realManifest.entries.filter((e) => !e.retired);
  const realParts = objectChartMass(realFlight14[0], activeReal);
  check("retired launch's GCAT mass is what the chart counts", realParts.cataloguedKg + real15.massKg, 41000 + 39000);

  console.log("name-family estimator skips Starship payloads:");
  const falconStarlinks = [300, 400, 500, 600, 800].map((massKg, i) => ({
    name: `STARLINK-${1000 + i}`,
    objectClass: "P",
    lvFamily: "Falcon 9",
    massKg,
    massEstimated: false,
  }));
  const falconModel = buildMassModel(falconStarlinks);
  check(
    "Falcon Starlink still gets the name-family median",
    falconModel.estimate({ name: "STARLINK-99999", objectClass: "P", lvFamily: "Falcon 9", massKg: null, massEstimated: false }),
    { massKg: 500, method: "name-family:STARLINK" },
  );
  check(
    "Starship Starlink is left unestimated",
    falconModel.estimate({ name: "STARLINK-30001", objectClass: "P", lvFamily: "Starship", massKg: null, massEstimated: false }),
    null,
  );
  check(
    "Starship family string still blocks the Falcon median",
    falconModel.estimate({ name: "STARLINK V3", objectClass: "P", lvFamily: "Starship Super Heavy", massKg: null, massEstimated: false }),
    null,
  );
  const withClassMedian = buildMassModel([
    ...falconStarlinks,
    { name: "CUBESAT-1", objectClass: "P", lvFamily: "Electron", massKg: 10, massEstimated: false },
    { name: "CUBESAT-2", objectClass: "P", lvFamily: "Electron", massKg: 12, massEstimated: false },
    { name: "CUBESAT-3", objectClass: "P", lvFamily: "Electron", massKg: 14, massEstimated: false },
  ]);
  check(
    "class median does not fill in a Starship payload",
    withClassMedian.estimate({ name: "PAYLOAD", objectClass: "P", lvFamily: "Starship", massKg: null, massEstimated: false }),
    null,
  );
  const shifted = buildMassModel([
    ...falconStarlinks,
    { name: "STARLINK-V3A", objectClass: "P", lvFamily: "Starship", massKg: 1500, massEstimated: false },
    { name: "STARLINK-V3B", objectClass: "P", lvFamily: "Starship", massKg: 1600, massEstimated: false },
    { name: "STARLINK-V3C", objectClass: "P", lvFamily: "Starship", massKg: 1700, massEstimated: false },
  ]);
  check(
    "catalogued Starship masses do not move the Falcon STARLINK median",
    shifted.estimate({ name: "STARLINK-7", objectClass: "P", lvFamily: "Falcon 9", massKg: null, massEstimated: false }),
    { massKg: 500, method: "name-family:STARLINK" },
  );

  console.log("site class:");
  check("BC is Starbase", classifySite("BC"), "starbase");
  check("Starbase name is Starbase", classifySite("Starbase, Texas"), "starbase");
  check("Cape stays Cape", classifySite("CC"), "capeCanaveral");
  check("KSC stays Cape", classifySite("KSC"), "capeCanaveral");
  check("Vandenberg stays Vandenberg", classifySite("VSFB"), "vandenberg");
  check("Wallops stays other", classifySite("WFF"), "other");

  if (failures > 0) {
    console.error(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nall provisional-manifest checks passed");
}

main();
