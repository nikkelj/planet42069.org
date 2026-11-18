import { Router, type IRouter } from "express";
import { getSatcat, getCacheAge, type SatcatEntry } from "../lib/satcat";
import { getLaunchMap } from "../lib/launch";
import { getFreshness } from "../lib/obc/store";
import {
  activeProvisional,
  classifySite,
  getProvisionalManifest,
  manifestVehicleLabel,
  objectChartMass,
  replacementMassByLabel,
  selectPendingFalcon,
  type PendingLaunch,
  type ProvisionalManifest,
  type SiteClass,
} from "../lib/provisional";

const router: IRouter = Router();

function getYear(ldate: string | null): string | null {
  if (!ldate) return null;
  const m = ldate.match(/^(\d{4})/);
  return m ? m[1] : null;
}

// ── Provisional (pending-cataloguing) tonnage ──────────────────────────────
// Space-track takes days (and GCAT weeks) to catalog fresh launches, so the
// trailing edge of the charts undercounts.
//
// Falcon launches inside the lag window with zero catalogued payload mass get
// a Falcon-median estimate (pendingFalcon / pendingSpacex). Starship never
// uses that median. Starship flights in data/provisional-manifest.json get a
// sourced figure (pendingStarship) until GCAT lists a real payload mass
// (massEstimated !== true), at which point getProvisionalManifest retires the
// row. A Bureau estimate on objects matched by an active row is not added
// again: the manifest figure replaces it. A manifest entry is excluded from
// the Falcon estimator so the two cannot both count the same launch.

function isSpacexFamily(fam: string | null | undefined): boolean {
  const f = (fam ?? "").toLowerCase();
  return f.includes("falcon") || f.includes("starship");
}

/**
 * Falcon-median estimates for recent Falcon launches still missing payload
 * mass. Starship is not estimated here; see getProvisionalManifest.
 */
async function getPendingSpacexLaunches(
  data: SatcatEntry[],
  manifest?: ProvisionalManifest,
): Promise<PendingLaunch[]> {
  const launchMap = await getLaunchMap();
  const entries = (manifest ?? getProvisionalManifest(data)).entries;
  return selectPendingFalcon(data, launchMap.values(), Date.now(), entries);
}

function addReplacement(
  rows: { label: string; massKg: number; estMassKg: number; count: number; payloadCount: number }[],
  extra: Map<string, number>,
): void {
  for (const [label, kg] of extra) {
    let row = rows.find((r) => r.label === label);
    if (!row) {
      row = { label, massKg: 0, estMassKg: 0, count: 0, payloadCount: 0 };
      rows.push(row);
    }
    row.estMassKg += kg;
  }
}

router.get("/satcat/summary", async (req, res): Promise<void> => {
  const [data, freshness] = await Promise.all([getSatcat(), getFreshness()]);

  const payloads = data.filter((e) => e.objectClass === "P");
  // Status "O" = Operational, "OX" = Operational Extended
  const activePayloads = payloads.filter((e) =>
    e.satState === "O" || e.satState === "OX",
  ).length;

  const starlinkActive = payloads.filter((e) =>
    (e.satState === "O" || e.satState === "OX") &&
    e.name.toUpperCase().includes("STARLINK"),
  ).length;

  const owners = new Set(data.map((e) => e.owner).filter(Boolean));
  const lvs = new Set(data.map((e) => e.lv).filter(Boolean));

  // Provisional mass is reported beside the catalog total, never added to it.
  // Estimator mass already covered by an active manifest row is left out of
  // both totalMassKg and estimatedMassKg so pendingMassKg is the only copy.
  const manifest = getProvisionalManifest(data);
  const active = activeProvisional(manifest);
  const pendingFalcon = await getPendingSpacexLaunches(data, manifest);
  let totalMassKg = 0;
  let estimatedMassKg = 0;
  let estimatedObjects = 0;
  for (const e of data) {
    const parts = objectChartMass(e, active);
    if (e.objectClass === "P") totalMassKg += parts.cataloguedKg + parts.estimatedKg;
    if (!e.massEstimated) continue;
    const suppressed = (e.massKg ?? 0) > 0 && parts.cataloguedKg === 0 && parts.estimatedKg === 0;
    if (suppressed) continue;
    estimatedObjects += 1;
    estimatedMassKg += parts.estimatedKg;
  }
  const pendingMassKg =
    pendingFalcon.reduce((s, p) => s + p.estMassKg, 0) +
    active.reduce((s, e) => s + e.massKg, 0);

  const years = data
    .map((e) => getYear(e.ldate))
    .filter((y): y is string => y !== null)
    .map(Number);

  res.json({
    totalObjects: data.length,
    totalPayloads: payloads.length,
    totalMassKg: Math.round(totalMassKg),
    activePayloads,
    starlinkActive,
    countries: owners.size,
    launchVehicles: lvs.size,
    firstLaunchYear: years.length ? Math.min(...years) : 0,
    lastLaunchYear: years.length ? Math.max(...years) : 0,
    cacheAge: getCacheAge(),
    estimatedObjects,
    estimatedMassKg: Math.round(estimatedMassKg),
    pendingMassKg: Math.round(pendingMassKg),
    freshness,
  });
});

router.get("/satcat/stats", async (_req, res): Promise<void> => {
  const data = await getSatcat();

  // Only include payloads with known mass for mass analytics
  const payloads = data.filter(
    (e) => e.objectClass === "P",
  );

  const manifest = getProvisionalManifest(data);
  const active = activeProvisional(manifest);

  type Agg = { label: string; massKg: number; estMassKg: number; count: number; payloadCount: number };
  const addTo = (existing: Agg, e: SatcatEntry) => {
    const parts = objectChartMass(e, active);
    existing.massKg += parts.cataloguedKg;
    existing.estMassKg += parts.estimatedKg;
    existing.count += 1;
    existing.payloadCount += e.objectClass === "P" ? 1 : 0;
  };
  const finishRows = (rows: Agg[], byMass: boolean): Agg[] => {
    const rounded = rows.map((r) => ({
      ...r,
      massKg: Math.round(r.massKg),
      estMassKg: Math.round(r.estMassKg),
    }));
    return byMass
      ? rounded.sort((a, b) => (b.massKg + b.estMassKg) - (a.massKg + a.estMassKg))
      : rounded.sort((a, b) => a.label.localeCompare(b.label));
  };
  const agg = (
    entries: SatcatEntry[],
    keyFn: (e: SatcatEntry) => string | null,
    extra: Map<string, number>,
  ): Agg[] => {
    const map = new Map<string, Agg>();
    for (const e of entries) {
      const key = keyFn(e) ?? "Unknown";
      const existing = map.get(key) ?? { label: key, massKg: 0, estMassKg: 0, count: 0, payloadCount: 0 };
      addTo(existing, e);
      map.set(key, existing);
    }
    const rows = Array.from(map.values());
    addReplacement(rows, extra);
    return finishRows(rows, true);
  };

  // byYear — use all data for count. Active manifest mass replaces estimator
  // mass on the launch year, including flights that have no catalog objects yet.
  const yearMap = new Map<string, Agg>();
  for (const e of data) {
    const key = getYear(e.ldate) ?? "Unknown";
    const existing = yearMap.get(key) ?? { label: key, massKg: 0, estMassKg: 0, count: 0, payloadCount: 0 };
    addTo(existing, e);
    yearMap.set(key, existing);
  }
  const yearRows = Array.from(yearMap.values());
  addReplacement(
    yearRows,
    replacementMassByLabel(data, active, (e) => getYear(e.ldate), (entry) => getYear(entry.launchDate)),
  );
  const byYear = finishRows(yearRows, false).filter((y) => y.label !== "Unknown");

  const byCountry = agg(
    payloads,
    (e) => e.state,
    replacementMassByLabel(payloads, active, (e) => e.state),
  ).slice(0, 30);
  const byOrbit = agg(
    payloads,
    (e) => e.opOrbit,
    replacementMassByLabel(payloads, active, (e) => e.opOrbit),
  ).slice(0, 20);

  // Object class breakdown across all objects (not just payloads)
  const classLabels: Record<string, string> = {
    P: "Payload", R: "Rocket Body", D: "Debris", C: "Component", Z: "Other",
  };
  const classKey = (e: SatcatEntry): string => {
    const c = e.objectClass ?? "-";
    return classLabels[c] ?? c;
  };
  const byObjectClass = agg(
    data,
    classKey,
    replacementMassByLabel(data, active, classKey),
  );

  // LV family for readability, fall back to LV. Flights with no objects yet
  // still land on the booked vehicle so the manifest figure is not dropped.
  const byLaunchVehicle = agg(
    payloads,
    (e) => e.lvFamily ?? e.lv,
    replacementMassByLabel(
      payloads,
      active,
      (e) => e.lvFamily ?? e.lv,
      (entry) => manifestVehicleLabel(entry, payloads),
    ),
  ).slice(0, 25);

  // Gunter's Space Page Type/Application breakdown (payloads only).
  // Payloads without a Gunter match fall back to the existing GCAT
  // object-class bucket ("Payload (unclassified)") so nothing is dropped.
  const gunterKey = (e: SatcatEntry) => e.gunterType ?? "Payload (unclassified)";
  const byGunterType = agg(
    payloads,
    gunterKey,
    replacementMassByLabel(payloads, active, gunterKey),
  ).slice(0, 15);
  const gunterCoverage = {
    matchedPayloads: payloads.filter((e) => e.gunterType != null).length,
    totalPayloads: payloads.length,
  };

  res.json({ byYear, byCountry, byOrbit, byObjectClass, byLaunchVehicle, byGunterType, gunterCoverage });
});

router.get("/satcat/by-year-provider", async (_req, res): Promise<void> => {
  const data = await getSatcat();

  // Payloads only. SpaceX is Falcon and Starship — a Starship row is not "rest of world".
  const payloads = data.filter((e) => e.objectClass === "P");

  type YearRow = {
    year: string;
    spacex: number;
    others: number;
    pendingSpacex: number;
    pendingStarship: number;
    spacexCount: number;
    othersCount: number;
  };
  const map = new Map<string, YearRow>();
  const emptyRow = (year: string): YearRow => ({
    year, spacex: 0, others: 0, pendingSpacex: 0, pendingStarship: 0, spacexCount: 0, othersCount: 0,
  });

  const manifest = getProvisionalManifest(data);
  const active = activeProvisional(manifest);
  for (const e of payloads) {
    const year = getYear(e.ldate);
    if (!year) continue;
    const parts = objectChartMass(e, active);
    const mass = parts.cataloguedKg + parts.estimatedKg;
    const isSpaceX = isSpacexFamily(e.lvFamily);
    const row = map.get(year) ?? emptyRow(year);
    if (isSpaceX) {
      row.spacex += mass;
      row.spacexCount += 1;
    } else {
      row.others += mass;
      row.othersCount += 1;
    }
    map.set(year, row);
  }

  // Falcon-median estimates stay in pendingSpacex. Sourced Starship estimates
  // are their own series and are not folded in. Estimator mass of an active
  // manifest launch is omitted above so pendingStarship is the only copy.
  for (const p of await getPendingSpacexLaunches(data, manifest)) {
    const year = getYear(p.ldate);
    if (!year) continue;
    const row = map.get(year) ?? emptyRow(year);
    row.pendingSpacex += p.estMassKg;
    map.set(year, row);
  }
  for (const p of active) {
    const year = getYear(p.launchDate);
    if (!year) continue;
    const row = map.get(year) ?? emptyRow(year);
    row.pendingStarship += p.massKg;
    map.set(year, row);
  }

  const byYearProvider = Array.from(map.values())
    .map((r) => ({
      ...r,
      spacex: Math.round(r.spacex),
      others: Math.round(r.others),
      pendingSpacex: Math.round(r.pendingSpacex),
      pendingStarship: Math.round(r.pendingStarship),
    }))
    .sort((a, b) => a.year.localeCompare(b.year));

  res.json({ byYearProvider });
});

// Map a satellite's launch vehicle to its launch-service provider.
// Order matters: commercial Chinese families must be matched BEFORE the
// generic Chang Zheng / Long March (CASC) rule, since several commercial
// providers fly CASC-derived vehicles but are billed separately.
function providerFromLv(lvFamily: string | null, lv: string | null): string {
  const fam = ((lvFamily ?? "") + " " + (lv ?? "")).toLowerCase();
  if (!fam.trim()) return "Unknown";
  if (fam.includes("falcon") || fam.includes("starship")) return "SpaceX";
  if (fam.includes("new glenn") || fam.includes("new shepard")) return "Blue Origin";
  if (fam.includes("ariane") || fam.includes("vega")) return "Arianespace";
  if (
    fam.includes("vulcan") || fam.includes("atlas") ||
    fam.includes("delta iv") || fam.includes("delta 4")
  ) return "ULA";
  if (fam.includes("electron") || fam.includes("neutron")) return "Rocket Lab";
  if (fam.includes("terran") || fam.includes("relativity")) return "Relativity Space";
  if (fam.includes("nova") || fam.includes("stoke")) return "Stoke Space";
  if (fam.includes("firefly")) return "Firefly Aerospace";
  if (fam.includes("kairos")) return "Space One";
  if (
    fam.includes("pslv") || fam.includes("gslv") ||
    fam.includes("sslv") || fam.includes("lvm3") || fam.includes("lvm-3")
  ) return "ISRO";
  if (
    fam.includes("soyuz") || fam.includes("proton") ||
    fam.includes("angara") || fam.includes("rokot") || fam.includes("dnepr")
  ) return "Roscosmos";
  // Chinese commercial — before the generic CASC rule below
  if (fam.includes("lijian") || fam.includes("kinetica")) return "CAS Space";
  if (
    fam.includes("gushenxing") || fam.includes("ceres") || fam.includes("pallas")
  ) return "Galactic Energy";
  if (fam.includes("jielong") || fam.includes("smart dragon")) return "Chinarocket Co. Ltd.";
  if (fam.includes("kuaizhou")) return "ExPace";
  if (fam.includes("zhuque")) return "LandSpace";
  if (fam.includes("hyperbola") || fam.includes("shuang quxian")) return "iSpace";
  // CASC state launcher (Long March / Chang Zheng) — generic, matched last
  if (
    fam.includes("chang zheng") || fam.includes("long march") ||
    fam.startsWith("cz-") || fam.startsWith("cz ") || fam.includes(" cz-")
  ) return "CASC";
  return "Other";
}

function classifyProvider(e: SatcatEntry): string {
  return providerFromLv(e.lvFamily, e.lv);
}

// Q1 2026 upmass by launch-service provider, computed live from GCAT.
// Mirrors the Bryce Tech "Spacecraft Upmass Carried by Launch Provider"
// chart so the two sources can be compared directly on the Briefing page.
router.get("/satcat/upmass-by-provider", async (req, res): Promise<void> => {
  const data = await getSatcat();
  const start = String(req.query.start ?? "2026-01-01");
  const end = String(req.query.end ?? "2026-03-31");

  const payloads = data.filter(
    (e) =>
      e.objectClass === "P" &&
      e.ldate != null &&
      e.ldate >= start &&
      e.ldate <= end,
  );

  type Row = {
    provider: string;
    massKg: number;
    estMassKg: number;
    pendingMassKg: number;
    pendingStarshipMassKg: number;
    count: number;
  };
  const map = new Map<string, Row>();
  const emptyRow = (provider: string): Row => ({
    provider, massKg: 0, estMassKg: 0, pendingMassKg: 0, pendingStarshipMassKg: 0, count: 0,
  });
  const manifest = getProvisionalManifest(data);
  const active = activeProvisional(manifest);
  for (const e of payloads) {
    const provider = classifyProvider(e);
    const row = map.get(provider) ?? emptyRow(provider);
    const parts = objectChartMass(e, active);
    row.massKg += parts.cataloguedKg;
    row.estMassKg += parts.estimatedKg;
    row.count += 1;
    map.set(provider, row);
  }

  // Falcon-median pending stays in pendingMassKg. Sourced Starship provisional
  // mass is pendingStarshipMassKg and is not folded into the Falcon series.
  // Estimator mass covered by an active manifest row is omitted above.
  for (const p of await getPendingSpacexLaunches(data, manifest)) {
    if (p.ldate < start || p.ldate > end) continue;
    const row = map.get("SpaceX") ?? emptyRow("SpaceX");
    row.pendingMassKg += p.estMassKg;
    map.set("SpaceX", row);
  }
  for (const p of active) {
    if (p.launchDate < start || p.launchDate > end) continue;
    const row = map.get("SpaceX") ?? emptyRow("SpaceX");
    row.pendingStarshipMassKg += p.massKg;
    map.set("SpaceX", row);
  }

  const providers = Array.from(map.values())
    .map((r) => ({
      ...r,
      massKg: Math.round(r.massKg),
      estMassKg: Math.round(r.estMassKg),
      pendingMassKg: Math.round(r.pendingMassKg),
      pendingStarshipMassKg: Math.round(r.pendingStarshipMassKg),
    }))
    .sort((a, b) =>
      (b.massKg + b.estMassKg + b.pendingMassKg + b.pendingStarshipMassKg) -
      (a.massKg + a.estMassKg + a.pendingMassKg + a.pendingStarshipMassKg));

  res.json({
    window: { start, end },
    providers,
    totalMassKg: providers.reduce((s, r) => s + r.massKg + r.estMassKg, 0),
    totalPendingMassKg: providers.reduce((s, r) => s + r.pendingMassKg, 0),
    totalPendingStarshipMassKg: providers.reduce((s, r) => s + r.pendingStarshipMassKg, 0),
    totalCount: payloads.length,
  });
});

// ── Shuttle mass forensics ──────────────────────────────────────────────────
// GCAT catalogs the Shuttle ORBITER itself as a payload on every flight
// (~90-100t each, PLName OV-xxx). That is why "Space Shuttle" tops the
// mass-by-vehicle chart despite only ~135 flights. This endpoint quantifies
// the split: orbiter rows vs actual deployed-cargo rows (GCAT actuals), plus
// a theorized split using published orbiter dry masses.
const ORBITERS: Record<string, { name: string; publishedDryKg: number }> = {
  "OV-102": { name: "Columbia", publishedDryKg: 81600 },
  "OV-099": { name: "Challenger", publishedDryKg: 79500 },
  "OV-103": { name: "Discovery", publishedDryKg: 78450 },
  "OV-104": { name: "Atlantis", publishedDryKg: 78020 },
  "OV-105": { name: "Endeavour", publishedDryKg: 78000 },
};

router.get("/satcat/shuttle-audit", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  const payloads = data.filter((e) => e.objectClass === "P");

  const shuttleRows = payloads.filter(
    (e) => (e.lvFamily ?? "").toLowerCase() === "space shuttle",
  );

  const perOrbiter = Object.entries(ORBITERS).map(([ov, meta]) => ({
    ov,
    name: meta.name,
    publishedDryKg: meta.publishedDryKg,
    flights: 0,
    gcatMassKg: 0,
  }));
  const byOv = new Map(perOrbiter.map((o) => [o.ov, o]));

  let orbiterGcatKg = 0;
  let cargoGcatKg = 0;
  let cargoObjects = 0;

  for (const e of shuttleRows) {
    const o = e.plName ? byOv.get(e.plName) : undefined;
    if (o) {
      o.flights += 1;
      o.gcatMassKg += e.massKg ?? 0;
      orbiterGcatKg += e.massKg ?? 0;
    } else {
      cargoGcatKg += e.massKg ?? 0;
      cargoObjects += 1;
    }
  }

  const gcatTotalKg = orbiterGcatKg + cargoGcatKg;
  const flights = perOrbiter.reduce((s, o) => s + o.flights, 0);
  const theorizedOrbiterDryKg = perOrbiter.reduce(
    (s, o) => s + o.flights * o.publishedDryKg,
    0,
  );
  const theorizedDeliveredKg = Math.max(0, gcatTotalKg - theorizedOrbiterDryKg);

  // Falcon 9 reference (genuine payloads only — no vehicle rides along)
  const falcon9Rows = payloads.filter(
    (e) => (e.lvFamily ?? "").toLowerCase() === "falcon 9",
  );
  const falcon9TotalKg = falcon9Rows.reduce((s, e) => s + (e.massKg ?? 0), 0);

  res.json({
    gcat: {
      totalKg: Math.round(gcatTotalKg),
      orbiterKg: Math.round(orbiterGcatKg),
      cargoKg: Math.round(cargoGcatKg),
      flights,
      cargoObjects,
    },
    theorized: {
      orbiterDryKg: Math.round(theorizedOrbiterDryKg),
      deliveredKg: Math.round(theorizedDeliveredKg),
    },
    perOrbiter: perOrbiter
      .map((o) => ({
        ...o,
        gcatMassKg: Math.round(o.gcatMassKg),
        theorizedDryTotalKg: o.flights * o.publishedDryKg,
      }))
      .sort((a, b) => b.flights - a.flights),
    falcon9: {
      totalKg: Math.round(falcon9TotalKg),
      payloadCount: falcon9Rows.length,
    },
    cacheAgeMs: getCacheAge(),
  });
});

// ── Shuttle vs Falcon 9 cadence comparison ─────────────────────────────────
// Launch ATTEMPTS per program year (year 1 = first orbital flight year),
// computed live from the GCAT launch table. Aligning both programs on
// "years since first flight" makes the divergence point visible: where one
// program lost the exponential and the other kept it.
type CadenceEvent = {
  program: "shuttle" | "falcon9";
  programYear: number;
  calendarYear: number;
  label: string;
  detail: string;
};

const CADENCE_EVENTS: CadenceEvent[] = [
  { program: "shuttle", programYear: 1, calendarYear: 1981, label: "STS-1", detail: "First flight. Crewed on the first try. The Bureau notes this was very brave." },
  { program: "shuttle", programYear: 5, calendarYear: 1985, label: "PEAK: 10 FLIGHTS", detail: "The program's best year, per the catalog. This number will not be exceeded. Ever." },
  { program: "shuttle", programYear: 6, calendarYear: 1986, label: "CHALLENGER", detail: "Loss of vehicle and crew. Fleet grounded 32 months. The exponential does not survive." },
  { program: "shuttle", programYear: 8, calendarYear: 1988, label: "RETURN TO FLIGHT", detail: "Flights resume at roughly half the prior cadence, permanently." },
  { program: "shuttle", programYear: 23, calendarYear: 2003, label: "COLUMBIA", detail: "Loss of vehicle and crew. Fleet grounded 29 months. Cadence never recovers." },
  { program: "shuttle", programYear: 31, calendarYear: 2011, label: "STS-135 / RETIRED", detail: "Final flight. 31 years of service, ~4.5 launches per year on average. The catalog closes the file." },
  { program: "falcon9", programYear: 1, calendarYear: 2010, label: "F9 FLIGHT 1", detail: "First flight. Uncrewed. The Bureau approves of this ordering." },
  { program: "falcon9", programYear: 6, calendarYear: 2015, label: "CRS-7 FAILURE", detail: "In-flight breakup. Grounded ~6 months, not 32. No crew aboard — nothing to ground forever." },
  { program: "falcon9", programYear: 7, calendarYear: 2016, label: "AMOS-6", detail: "Pad explosion during fueling. Grounded ~4 months. Cadence resumes climbing." },
  { program: "falcon9", programYear: 8, calendarYear: 2017, label: "FIRST REFLIGHT", detail: "A flown booster flies again. Refurbishment measured in weeks, not standing armies." },
  { program: "falcon9", programYear: 10, calendarYear: 2019, label: "STARLINK BEGINS", detail: "The vendor becomes its own anchor customer. Demand is now also vertically integrated." },
  { program: "falcon9", programYear: 15, calendarYear: 2024, label: "OUT-LAUNCHES NATIONS", detail: "One vehicle family exceeds the launch cadence of every nation-state. Filed without comment." },
];

router.get("/satcat/shuttle-vs-falcon-rate", async (_req, res): Promise<void> => {
  const launches = await getLaunchMap();

  const shuttleByYear = new Map<number, number>();
  const falconByYear = new Map<number, number>();

  for (const l of launches.values()) {
    if (!l.orbital || !l.ldate) continue;
    const year = parseInt(l.ldate.slice(0, 4), 10);
    if (Number.isNaN(year)) continue;
    const fam = (l.lvFamily ?? "").toLowerCase();
    if (fam === "space shuttle") {
      shuttleByYear.set(year, (shuttleByYear.get(year) ?? 0) + 1);
    } else if (fam === "falcon 9") {
      falconByYear.set(year, (falconByYear.get(year) ?? 0) + 1);
    }
  }

  if (shuttleByYear.size === 0 || falconByYear.size === 0) {
    res.status(503).json({
      error: "GCAT launch data missing expected vehicle families (Space Shuttle / Falcon 9); refusing to compute cadence comparison.",
    });
    return;
  }

  const shuttleFirstYear = Math.min(...shuttleByYear.keys());
  const falconFirstYear = Math.min(...falconByYear.keys());
  const shuttleLastYear = Math.max(...shuttleByYear.keys());
  const falconLastYear = Math.max(...falconByYear.keys());

  const shuttleSpan = shuttleLastYear - shuttleFirstYear + 1;
  const falconSpan = falconLastYear - falconFirstYear + 1;
  const span = Math.max(shuttleSpan, falconSpan);

  const rows = Array.from({ length: span }, (_, i) => {
    const programYear = i + 1;
    const sYear = shuttleFirstYear + i;
    const fYear = falconFirstYear + i;
    const inShuttle = sYear <= shuttleLastYear;
    const inFalcon = fYear <= falconLastYear;
    return {
      programYear,
      shuttleYear: inShuttle ? sYear : null,
      shuttleCount: inShuttle ? (shuttleByYear.get(sYear) ?? 0) : null,
      falconYear: inFalcon ? fYear : null,
      falconCount: inFalcon ? (falconByYear.get(fYear) ?? 0) : null,
    };
  });

  const shuttleTotal = Array.from(shuttleByYear.values()).reduce((s, v) => s + v, 0);
  const falconTotal = Array.from(falconByYear.values()).reduce((s, v) => s + v, 0);

  res.json({
    rows,
    events: CADENCE_EVENTS,
    shuttleFirstYear,
    falconFirstYear,
    shuttleTotal,
    falconTotal,
    cacheAgeMs: getCacheAge(),
  });
});

// Orbital launch cadence by provider AND vehicle, computed live from the GCAT
// launch table (NOT satcat payloads — rideshares would distort cadence). Counts
// orbital-class launch ATTEMPTS (LaunchCode O*/D*); excludes suborbital, weapon,
// and sounding-rocket flights. Highlights high-cadence operators like Rocket Lab.
const LAUNCH_RATE_MIN_YEAR = 2019;

// Heavy-lift / next-gen contenders we "anticipate" the way we already track
// Starship — they surface here automatically once GCAT catalogs their flights.
const CONTENDER_WATCHLIST: Array<{ vehicle: string; provider: string; match: string[] }> = [
  { vehicle: "Starship", provider: "SpaceX", match: ["starship"] },
  { vehicle: "New Glenn (NG 7x2 / 9x4)", provider: "Blue Origin", match: ["new glenn"] },
  { vehicle: "Vulcan", provider: "ULA", match: ["vulcan"] },
  { vehicle: "Neutron", provider: "Rocket Lab", match: ["neutron"] },
  { vehicle: "Terran R", provider: "Relativity Space", match: ["terran r", "terran-r"] },
  { vehicle: "Nova", provider: "Stoke Space", match: ["stoke", "nova"] },
  { vehicle: "Zhuque-3", provider: "LandSpace", match: ["zhuque-3", "zhuque 3"] },
  { vehicle: "Long March 10B", provider: "CASC", match: ["long march 10", "chang zheng 10", "cz-10"] },
  { vehicle: "Cowboy Space (TBD)", provider: "Cowboy Space", match: ["cowboy"] },
];

router.get("/satcat/launch-rate", async (_req, res): Promise<void> => {
  const launches = await getLaunchMap();

  // year -> provider -> count
  const provByYear = new Map<string, Map<string, number>>();
  // year -> provider -> vehicle -> count
  const vehByYearProv = new Map<string, Map<string, Map<string, number>>>();
  // year -> vehicle -> { count, provider }
  const vehByYear = new Map<string, Map<string, { count: number; provider: string }>>();
  const yearsSet = new Set<string>();

  // Watchlist accumulation across ALL years (orbital only).
  const watchAcc = CONTENDER_WATCHLIST.map((w) => ({
    ...w,
    totalLaunches: 0,
    firstYear: null as string | null,
  }));

  for (const l of launches.values()) {
    if (!l.orbital || !l.ldate) continue;
    const year = l.ldate.slice(0, 4);
    const yNum = parseInt(year, 10);
    if (Number.isNaN(yNum)) continue;

    const provider = providerFromLv(l.lvFamily, l.lv);
    const vehicle = l.lvFamily ?? l.lv ?? "Unknown";
    const lvStr = ((l.lvFamily ?? "") + " " + (l.lv ?? "")).toLowerCase();

    // Watchlist (all years, so first flights before the window still register).
    for (const w of watchAcc) {
      if (w.match.some((m) => lvStr.includes(m))) {
        w.totalLaunches += 1;
        if (!w.firstYear || year < w.firstYear) w.firstYear = year;
      }
    }

    if (yNum < LAUNCH_RATE_MIN_YEAR) continue;
    yearsSet.add(year);

    // provider counts
    let pm = provByYear.get(year);
    if (!pm) { pm = new Map(); provByYear.set(year, pm); }
    pm.set(provider, (pm.get(provider) ?? 0) + 1);

    // provider -> vehicle counts
    let pv = vehByYearProv.get(year);
    if (!pv) { pv = new Map(); vehByYearProv.set(year, pv); }
    let vm = pv.get(provider);
    if (!vm) { vm = new Map(); pv.set(provider, vm); }
    vm.set(vehicle, (vm.get(vehicle) ?? 0) + 1);

    // vehicle counts
    let vy = vehByYear.get(year);
    if (!vy) { vy = new Map(); vehByYear.set(year, vy); }
    const cur = vy.get(vehicle);
    if (cur) cur.count += 1;
    else vy.set(vehicle, { count: 1, provider });
  }

  const years = Array.from(yearsSet).sort();

  const data: Record<string, {
    providers: Array<{ name: string; count: number; vehicles: Array<{ name: string; count: number }> }>;
    vehicles: Array<{ name: string; count: number; provider: string }>;
    total: number;
  }> = {};

  for (const year of years) {
    const pm = provByYear.get(year)!;
    const pv = vehByYearProv.get(year)!;
    const vy = vehByYear.get(year)!;

    const providers = Array.from(pm.entries())
      .map(([name, count]) => ({
        name,
        count,
        vehicles: Array.from((pv.get(name) ?? new Map<string, number>()).entries())
          .map(([vn, vc]) => ({ name: vn, count: vc }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.count - a.count);

    const vehicles = Array.from(vy.entries())
      .map(([name, v]) => ({ name, count: v.count, provider: v.provider }))
      .sort((a, b) => b.count - a.count);

    const total = providers.reduce((s, p) => s + p.count, 0);
    data[year] = { providers, vehicles, total };
  }

  const anticipated = watchAcc.map((w) => ({
    vehicle: w.vehicle,
    provider: w.provider,
    status: w.totalLaunches > 0 ? "FLYING" : "AWAITING",
    firstYear: w.firstYear,
    totalLaunches: w.totalLaunches,
  }));

  res.json({ years, data, anticipated, cacheAgeMs: getCacheAge() });
});

// SpaceX Falcon vs Starship mass by year (2010+)
router.get("/satcat/falcon-vs-starship", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  const payloads = data.filter((e) => e.objectClass === "P");

  type Row = { year: string; falcon: number; starship: number; pendingFalcon: number; pendingStarship: number };
  const map = new Map<string, Row>();
  const emptyRow = (year: string): Row => ({ year, falcon: 0, starship: 0, pendingFalcon: 0, pendingStarship: 0 });

  const manifest = getProvisionalManifest(data);
  const active = activeProvisional(manifest);
  for (const e of payloads) {
    const year = getYear(e.ldate);
    if (!year || parseInt(year) < 2010) continue;
    const parts = objectChartMass(e, active);
    const mass = parts.cataloguedKg + parts.estimatedKg;
    const lv = ((e.lvFamily ?? "") + " " + (e.lv ?? "")).toLowerCase();
    if (!lv.includes("falcon") && !lv.includes("starship")) continue;
    const row = map.get(year) ?? emptyRow(year);
    if (lv.includes("falcon")) {
      row.falcon += mass;
    } else {
      row.starship += mass;
    }
    map.set(year, row);
  }

  // Falcon-median pending stays on pendingFalcon. Sourced Starship provisional
  // mass is pendingStarship — not folded into the Falcon series. Estimator
  // mass covered by an active manifest row is omitted above.
  for (const p of await getPendingSpacexLaunches(data, manifest)) {
    const year = getYear(p.ldate);
    if (!year) continue;
    const row = map.get(year) ?? emptyRow(year);
    row.pendingFalcon += p.estMassKg;
    map.set(year, row);
  }
  for (const p of active) {
    const year = getYear(p.launchDate);
    if (!year) continue;
    const row = map.get(year) ?? emptyRow(year);
    row.pendingStarship += p.massKg;
    map.set(year, row);
  }

  const rows = Array.from(map.values())
    .map((r) => ({
      ...r,
      falcon: Math.round(r.falcon),
      starship: Math.round(r.starship),
      pendingFalcon: Math.round(r.pendingFalcon),
      pendingStarship: Math.round(r.pendingStarship),
    }))
    .sort((a, b) => a.year.localeCompare(b.year));

  const starshipTotal = rows.reduce((s, r) => s + r.starship, 0);
  res.json({ rows, starshipTotal });
});

// SpaceX (Falcon family) monthly mass by launch site for a given year
router.get("/satcat/spacex-by-site-monthly", async (req, res): Promise<void> => {
  const data = await getSatcat();
  const year = String(req.query.year ?? new Date().getFullYear()).trim();

  const payloads = data.filter((e) => {
    const fam = (e.lvFamily ?? "").toLowerCase();
    return (
      e.objectClass === "P" &&
      (fam.includes("falcon") || fam.includes("starship")) &&
      getYear(e.ldate) === year
    );
  });

  const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

  type MonthRow = {
    month: string; monthNum: number;
    capeCanaveral: number; vandenberg: number; starbase: number; other: number;
    pendingCapeCanaveral: number; pendingVandenberg: number; pendingStarbase: number; pendingOther: number;
  };
  const rows: MonthRow[] = MONTH_NAMES.map((month, i) => ({
    month, monthNum: i + 1,
    capeCanaveral: 0, vandenberg: 0, starbase: 0, other: 0,
    pendingCapeCanaveral: 0, pendingVandenberg: 0, pendingStarbase: 0, pendingOther: 0,
  }));

  const manifest = getProvisionalManifest(data);
  const active = activeProvisional(manifest);
  for (const e of payloads) {
    if (!e.ldate) continue;
    const monthNum = parseInt(e.ldate.split("-")[1] ?? "0", 10);
    if (monthNum < 1 || monthNum > 12) continue;
    const parts = objectChartMass(e, active);
    const mass = parts.cataloguedKg + parts.estimatedKg;
    const row = rows[monthNum - 1];
    row[classifySite(e.site)] += mass;
  }

  const PENDING_KEY: Record<SiteClass, "pendingCapeCanaveral" | "pendingVandenberg" | "pendingStarbase" | "pendingOther"> = {
    capeCanaveral: "pendingCapeCanaveral",
    vandenberg: "pendingVandenberg",
    starbase: "pendingStarbase",
    other: "pendingOther",
  };
  for (const p of await getPendingSpacexLaunches(data, manifest)) {
    if (getYear(p.ldate) !== year) continue;
    const monthNum = parseInt(p.ldate.split("-")[1] ?? "0", 10);
    if (monthNum < 1 || monthNum > 12) continue;
    rows[monthNum - 1][PENDING_KEY[p.siteClass]] += p.estMassKg;
  }
  for (const p of active) {
    if (getYear(p.launchDate) !== year) continue;
    const monthNum = parseInt(p.launchDate.split("-")[1] ?? "0", 10);
    if (monthNum < 1 || monthNum > 12) continue;
    rows[monthNum - 1][PENDING_KEY[p.siteClass]] += p.massKg;
  }

  const result = rows.map((r) => ({
    ...r,
    capeCanaveral: Math.round(r.capeCanaveral),
    vandenberg: Math.round(r.vandenberg),
    starbase: Math.round(r.starbase),
    other: Math.round(r.other),
    pendingCapeCanaveral: Math.round(r.pendingCapeCanaveral),
    pendingVandenberg: Math.round(r.pendingVandenberg),
    pendingStarbase: Math.round(r.pendingStarbase),
    pendingOther: Math.round(r.pendingOther),
  }));

  res.json({ year, rows: result });
});

// SpaceX (Falcon + Starship families) mass by launch site, 2010+
router.get("/satcat/spacex-by-site", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  const payloads = data.filter((e) => {
    const fam = (e.lvFamily ?? "").toLowerCase();
    return e.objectClass === "P" && (fam.includes("falcon") || fam.includes("starship"));
  });

  type SiteRow = {
    year: string;
    capeCanaveral: number; vandenberg: number; starbase: number; other: number;
    pendingCapeCanaveral: number; pendingVandenberg: number; pendingStarbase: number; pendingOther: number;
  };
  const map = new Map<string, SiteRow>();
  const emptyRow = (year: string): SiteRow => ({
    year, capeCanaveral: 0, vandenberg: 0, starbase: 0, other: 0,
    pendingCapeCanaveral: 0, pendingVandenberg: 0, pendingStarbase: 0, pendingOther: 0,
  });

  const manifest = getProvisionalManifest(data);
  const active = activeProvisional(manifest);
  for (const e of payloads) {
    const year = getYear(e.ldate);
    if (!year || parseInt(year) < 2010) continue;
    const parts = objectChartMass(e, active);
    const mass = parts.cataloguedKg + parts.estimatedKg;
    const row = map.get(year) ?? emptyRow(year);
    row[classifySite(e.site)] += mass;
    map.set(year, row);
  }

  const PENDING_KEY: Record<SiteClass, "pendingCapeCanaveral" | "pendingVandenberg" | "pendingStarbase" | "pendingOther"> = {
    capeCanaveral: "pendingCapeCanaveral",
    vandenberg: "pendingVandenberg",
    starbase: "pendingStarbase",
    other: "pendingOther",
  };
  for (const p of await getPendingSpacexLaunches(data, manifest)) {
    const year = getYear(p.ldate);
    if (!year) continue;
    const row = map.get(year) ?? emptyRow(year);
    row[PENDING_KEY[p.siteClass]] += p.estMassKg;
    map.set(year, row);
  }
  for (const p of active) {
    const year = getYear(p.launchDate);
    if (!year) continue;
    const row = map.get(year) ?? emptyRow(year);
    row[PENDING_KEY[p.siteClass]] += p.massKg;
    map.set(year, row);
  }

  const rows = Array.from(map.values())
    .map((r) => ({
      ...r,
      capeCanaveral: Math.round(r.capeCanaveral),
      vandenberg: Math.round(r.vandenberg),
      starbase: Math.round(r.starbase),
      other: Math.round(r.other),
      pendingCapeCanaveral: Math.round(r.pendingCapeCanaveral),
      pendingVandenberg: Math.round(r.pendingVandenberg),
      pendingStarbase: Math.round(r.pendingStarbase),
      pendingOther: Math.round(r.pendingOther),
    }))
    .sort((a, b) => a.year.localeCompare(b.year));

  res.json({ rows });
});

// SpaceX (Falcon + Starship) mass by customer segment, 2010+
const US_GOV_OWNERS = new Set([
  "NASA", "USAF", "USSF", "USN", "USA", "NRO", "NOAA", "USGS", "NSF",
  "DARPA", "DOD", "USDOD", "AFRL", "MDA", "USDOE", "USCG",
]);

router.get("/satcat/spacex-by-entity", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  const payloads = data.filter(
    (e) => e.objectClass === "P" && isSpacexFamily(e.lvFamily),
  );

  type EntityRow = {
    year: string;
    starlink: number;
    usGov: number;
    commercial: number;
    pending: number;
    pendingStarship: number;
  };
  const map = new Map<string, EntityRow>();
  const emptyRow = (year: string): EntityRow => ({
    year, starlink: 0, usGov: 0, commercial: 0, pending: 0, pendingStarship: 0,
  });

  const manifest = getProvisionalManifest(data);
  const active = activeProvisional(manifest);
  for (const e of payloads) {
    const year = getYear(e.ldate);
    if (!year || parseInt(year) < 2010) continue;
    const parts = objectChartMass(e, active);
    const mass = parts.cataloguedKg + parts.estimatedKg;
    const row = map.get(year) ?? emptyRow(year);

    if (e.name.toUpperCase().includes("STARLINK")) {
      row.starlink += mass;
    } else if (e.state === "US" && e.owner && US_GOV_OWNERS.has(e.owner)) {
      row.usGov += mass;
    } else {
      row.commercial += mass;
    }
    map.set(year, row);
  }

  // Falcon launches still missing a catalog: segment is unknown, so the
  // median stays in `pending` and is not guessed into Starlink. Sourced
  // Starship provisional mass is `pendingStarship`, not folded into either.
  // Estimator mass covered by an active manifest row is omitted above.
  for (const p of await getPendingSpacexLaunches(data, manifest)) {
    const year = getYear(p.ldate);
    if (!year) continue;
    const row = map.get(year) ?? emptyRow(year);
    row.pending += p.estMassKg;
    map.set(year, row);
  }
  for (const p of active) {
    const year = getYear(p.launchDate);
    if (!year) continue;
    const row = map.get(year) ?? emptyRow(year);
    row.pendingStarship += p.massKg;
    map.set(year, row);
  }

  const rows = Array.from(map.values())
    .map((r) => ({
      ...r,
      starlink: Math.round(r.starlink),
      usGov: Math.round(r.usGov),
      commercial: Math.round(r.commercial),
      pending: Math.round(r.pending),
      pendingStarship: Math.round(r.pendingStarship),
    }))
    .sort((a, b) => a.year.localeCompare(b.year));

  res.json({ rows });
});

router.get("/satcat/provisional-manifest", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  res.json(getProvisionalManifest(data));
});

const DEORBIT_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
const DEORBIT_EPOCH = Date.UTC(1957, 0, 1);

function decayDateToDayNum(raw: string): number | null {
  const s = raw.trim();
  const full = s.match(/^(\d{4})\s+([A-Za-z]{3})\s+(\d+)/);
  if (full) {
    const yr = parseInt(full[1], 10);
    const mo = DEORBIT_MONTHS[full[2]] ?? 0;
    const dy = parseInt(full[3], 10);
    return Math.round((Date.UTC(yr, mo, dy) - DEORBIT_EPOCH) / 86400000);
  }
  const yearOnly = s.match(/^(\d{4})/);
  if (yearOnly) {
    return Math.round((Date.UTC(parseInt(yearOnly[1], 10), 0, 1) - DEORBIT_EPOCH) / 86400000);
  }
  return null;
}

router.get("/satcat/deorbit-history", async (_req, res): Promise<void> => {
  const data = await getSatcat();

  // dday === -1 is a sentinel meaning "still in orbit" (no catalogued decay date)
  const objects: { lday: number; dday: number; p: number; a: number; i: number; c: string }[] = [];

  for (const e of data) {
    if (!e.ldate || e.perigeeKm == null || e.incDeg == null) continue;
    // Parse ISO ldate "YYYY-MM-DD"
    const ld = new Date(e.ldate + "T00:00:00Z");
    if (isNaN(ld.getTime())) continue;
    const lday = Math.round((ld.getTime() - DEORBIT_EPOCH) / 86400000);
    if (lday < 0) continue;

    let dday: number;
    if (e.decayDate) {
      const d = decayDateToDayNum(e.decayDate);
      if (d == null || d < 0 || d > 30000 || lday > d) continue;
      dday = d;
    } else {
      // Still in orbit — persists, never drains
      dday = -1;
    }

    objects.push({
      lday,
      dday,
      p: Math.round(e.perigeeKm),
      a: Math.round(e.apogeeKm ?? e.perigeeKm),
      i: Math.round(e.incDeg * 10) / 10,
      c: e.objectClass ?? "U",
    });
  }

  objects.sort((a, b) => a.lday - b.lday);
  const todayNum = Math.round((Date.now() - DEORBIT_EPOCH) / 86400000);
  const decayed = objects.reduce((n, o) => n + (o.dday >= 0 ? 1 : 0), 0);
  const inOrbit = objects.length - decayed;
  const ldayMin = objects[0]?.lday ?? 0;
  const ddayMax = objects.reduce((m, o) => Math.max(m, o.dday >= 0 ? o.dday : o.lday), 0);
  res.json({
    objects,
    total: objects.length,
    decayed,
    inOrbit,
    dayMin: ldayMin,
    dayMax: Math.max(ddayMax, todayNum),
  });
});

router.get("/satcat/mass-cdf", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  const valid = data.filter((e) => e.massKg != null && e.massKg > 0) as (typeof data[0] & { massKg: number })[];

  function cdf(items: typeof valid, nPts = 250): { m: number; f: number }[] {
    if (items.length === 0) return [];
    const sorted = items.map((e) => e.massKg).sort((a, b) => a - b);
    const total = sorted.length;
    const result: { m: number; f: number }[] = [];
    const step = Math.max(1, Math.floor(total / nPts));
    for (let i = 0; i < total; i += step) {
      result.push({ m: sorted[i], f: (i + 1) / total });
    }
    if (result[result.length - 1]?.m !== sorted[total - 1]) {
      result.push({ m: sorted[total - 1], f: 1.0 });
    }
    return result;
  }

  // Aggregate
  const aggregate = cdf(valid);

  // By type
  const TYPE_KEYS = ["P", "R", "D", "C"];
  const byType: Record<string, { m: number; f: number }[]> = {};
  for (const t of TYPE_KEYS) {
    const sub = valid.filter((e) => e.objectClass === t);
    if (sub.length > 20) byType[t] = cdf(sub);
  }

  // By nation — top 7 by count with mass data
  const nationCount = new Map<string, number>();
  for (const e of valid) if (e.state) nationCount.set(e.state, (nationCount.get(e.state) ?? 0) + 1);
  const topNations = [...nationCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k);
  const byNation: Record<string, { m: number; f: number }[]> = {};
  for (const n of topNations) byNation[n] = cdf(valid.filter((e) => e.state === n));

  // By site — top 7 by count with mass data
  const siteCount = new Map<string, number>();
  for (const e of valid) if (e.site) siteCount.set(e.site, (siteCount.get(e.site) ?? 0) + 1);
  const topSites = [...siteCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k);
  const bySite: Record<string, { m: number; f: number }[]> = {};
  for (const s of topSites) bySite[s] = cdf(valid.filter((e) => e.site === s));

  res.json({ aggregate, byType, byNation, bySite, total: valid.length });
});

router.get("/satcat/orbital-map", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  const points = data
    .filter((e) => e.perigeeKm != null && e.incDeg != null)
    .map((e) => ({ p: e.perigeeKm!, i: e.incDeg!, c: e.objectClass ?? "U" }));
  res.json({ points, total: points.length });
});

router.get("/satcat/filters", async (_req, res): Promise<void> => {
  const data = await getSatcat();

  const owners = [...new Set(data.map((e) => e.owner).filter(Boolean) as string[])]
    .sort();
  const orbits = [...new Set(data.map((e) => e.opOrbit).filter(Boolean) as string[])]
    .sort();
  const satStates = [
    ...new Set(data.map((e) => e.satState).filter(Boolean) as string[]),
  ].sort();
  const objectClasses = [
    ...new Set(data.map((e) => e.objectClass).filter(Boolean) as string[]),
  ].sort();
  const gunterTypes = [
    ...new Set(data.map((e) => e.gunterType).filter(Boolean) as string[]),
  ].sort();
  const gunterMatched = data.reduce((n, e) => n + (e.gunterUrl ? 1 : 0), 0);

  res.json({ owners, orbits, satStates, objectClasses, gunterTypes, gunterMatched, totalObjects: data.length });
});

router.get("/satcat", async (req, res): Promise<void> => {
  const data = await getSatcat();

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const search = String(req.query.search ?? "").toLowerCase().trim();
  const ownerFilter = String(req.query.owner ?? "").trim();
  const classFilter = String(req.query.objectClass ?? "").trim();
  const orbitFilter = String(req.query.orbit ?? "").trim();
  const stateFilter = String(req.query.satState ?? "").trim();
  const gunterTypeFilter = String(req.query.gunterType ?? "").trim();
  const massMinRaw = parseFloat(String(req.query.massMin ?? ""));
  const massMaxRaw = parseFloat(String(req.query.massMax ?? ""));
  const massMin = Number.isFinite(massMinRaw) ? massMinRaw : null;
  const massMax = Number.isFinite(massMaxRaw) ? massMaxRaw : null;
  const sortField = String(req.query.sort ?? "ldate").trim();
  const sortOrder = String(req.query.order ?? "desc").trim();

  let filtered = data;

  if (search) {
    filtered = filtered.filter(
      (e) =>
        e.name.toLowerCase().includes(search) ||
        (e.plName?.toLowerCase().includes(search) ?? false) ||
        e.jcat.toLowerCase().includes(search) ||
        (e.satno != null && String(e.satno).includes(search)) ||
        (e.gunterOperator?.toLowerCase().includes(search) ?? false) ||
        (e.gunterContractors?.toLowerCase().includes(search) ?? false),
    );
  }
  if (ownerFilter) {
    filtered = filtered.filter((e) => e.owner === ownerFilter);
  }
  if (classFilter) {
    filtered = filtered.filter((e) => e.objectClass === classFilter);
  }
  if (orbitFilter) {
    filtered = filtered.filter((e) => e.opOrbit === orbitFilter);
  }
  if (stateFilter) {
    filtered = filtered.filter((e) => e.satState === stateFilter);
  }
  if (gunterTypeFilter) {
    filtered = filtered.filter((e) => e.gunterType === gunterTypeFilter);
  }
  if (massMin != null || massMax != null) {
    filtered = filtered.filter(
      (e) =>
        e.massKg != null &&
        (massMin == null || e.massKg >= massMin) &&
        (massMax == null || e.massKg <= massMax),
    );
  }

  let filteredMassKg = 0;
  let filteredEstMassKg = 0;
  for (const e of filtered) {
    if (e.massKg == null) continue;
    if (e.massEstimated) filteredEstMassKg += e.massKg;
    else filteredMassKg += e.massKg;
  }

  // Sort — use a typed whitelist to avoid TS2352 index-access errors
  const SORTABLE = [
    "jcat", "satno", "name", "plName", "ldate", "lv", "lvFamily", "site",
    "owner", "state", "objectClass", "objType", "opOrbit", "satState",
    "massKg", "apogeeKm", "perigeeKm", "incDeg",
  ] as const;
  type Sortable = (typeof SORTABLE)[number];
  const safeSortField: Sortable = (SORTABLE as readonly string[]).includes(sortField)
    ? (sortField as Sortable)
    : "ldate";
  const sortDir = sortOrder === "desc" ? -1 : 1;
  filtered = [...filtered].sort((a, b) => {
    const av = a[safeSortField];
    const bv = b[safeSortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // nulls always last regardless of direction
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * sortDir;
    }
    return String(av).localeCompare(String(bv)) * sortDir;
  });

  const total = filtered.length;
  const pages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const slice = filtered.slice(offset, offset + limit);

  res.json({ data: slice, total, page, limit, pages, filteredMassKg, filteredEstMassKg });
});

export default router;
