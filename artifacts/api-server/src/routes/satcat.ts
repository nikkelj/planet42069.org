import { Router, type IRouter } from "express";
import { getSatcat, getCacheAge, type SatcatEntry } from "../lib/satcat";

const router: IRouter = Router();

function getYear(ldate: string | null): string | null {
  if (!ldate) return null;
  const m = ldate.match(/^(\d{4})/);
  return m ? m[1] : null;
}

router.get("/satcat/summary", async (req, res): Promise<void> => {
  const data = await getSatcat();

  const payloads = data.filter((e) => e.objectClass === "P");
  // Status "O" = Operational, "OX" = Operational Extended
  const activePayloads = payloads.filter((e) =>
    e.satState === "O" || e.satState === "OX",
  ).length;

  const starlinkActive = payloads.filter((e) =>
    (e.satState === "O" || e.satState === "OX") &&
    e.name.toUpperCase().includes("STARLINK"),
  ).length;

  const totalMassKg = payloads.reduce(
    (sum, e) => sum + (e.massKg ?? 0),
    0,
  );

  const owners = new Set(data.map((e) => e.owner).filter(Boolean));
  const lvs = new Set(data.map((e) => e.lv).filter(Boolean));

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
  });
});

router.get("/satcat/stats", async (_req, res): Promise<void> => {
  const data = await getSatcat();

  // Only include payloads with known mass for mass analytics
  const payloads = data.filter(
    (e) => e.objectClass === "P",
  );

  type Agg = { massKg: number; count: number; payloadCount: number };
  const agg = (
    entries: SatcatEntry[],
    keyFn: (e: SatcatEntry) => string | null,
  ): { label: string; massKg: number; count: number; payloadCount: number }[] => {
    const map = new Map<string, Agg>();
    for (const e of entries) {
      const key = keyFn(e) ?? "Unknown";
      const existing = map.get(key) ?? { massKg: 0, count: 0, payloadCount: 0 };
      existing.massKg += e.massKg ?? 0;
      existing.count += 1;
      existing.payloadCount += e.objectClass === "P" ? 1 : 0;
      map.set(key, existing);
    }
    return Array.from(map.entries())
      .map(([label, v]) => ({ label, ...v, massKg: Math.round(v.massKg) }))
      .sort((a, b) => b.massKg - a.massKg);
  };

  // byYear — use all data for count, payloads for mass
  const yearMap = new Map<string, Agg>();
  for (const e of data) {
    const key = getYear(e.ldate) ?? "Unknown";
    const existing = yearMap.get(key) ?? { massKg: 0, count: 0, payloadCount: 0 };
    existing.massKg += e.massKg ?? 0;
    existing.count += 1;
    existing.payloadCount += e.objectClass === "P" ? 1 : 0;
    yearMap.set(key, existing);
  }
  const byYear = Array.from(yearMap.entries())
    .map(([label, v]) => ({ label, ...v, massKg: Math.round(v.massKg) }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .filter((y) => y.label !== "Unknown");

  const byCountry = agg(payloads, (e) => e.state).slice(0, 30);
  const byOrbit = agg(payloads, (e) => e.opOrbit).slice(0, 20);

  // Object class breakdown across all objects (not just payloads)
  const classLabels: Record<string, string> = {
    P: "Payload", R: "Rocket Body", D: "Debris", C: "Component", Z: "Other",
  };
  const byObjectClass = agg(data, (e) => {
    const c = e.objectClass ?? "-";
    return classLabels[c] ?? c;
  });

  // LV family for readability, fall back to LV
  const byLaunchVehicle = agg(payloads, (e) => e.lvFamily ?? e.lv).slice(0, 25);

  res.json({ byYear, byCountry, byOrbit, byObjectClass, byLaunchVehicle });
});

router.get("/satcat/by-year-provider", async (_req, res): Promise<void> => {
  const data = await getSatcat();

  // Only payloads; SpaceX = any Falcon-family vehicle
  const payloads = data.filter((e) => e.objectClass === "P");

  type YearRow = { year: string; spacex: number; others: number; spacexCount: number; othersCount: number };
  const map = new Map<string, YearRow>();

  for (const e of payloads) {
    const year = getYear(e.ldate);
    if (!year) continue;
    const mass = e.massKg ?? 0;
    const isSpaceX = (e.lvFamily ?? "").toLowerCase().includes("falcon");
    const row = map.get(year) ?? { year, spacex: 0, others: 0, spacexCount: 0, othersCount: 0 };
    if (isSpaceX) {
      row.spacex += mass;
      row.spacexCount += 1;
    } else {
      row.others += mass;
      row.othersCount += 1;
    }
    map.set(year, row);
  }

  const byYearProvider = Array.from(map.values())
    .map((r) => ({ ...r, spacex: Math.round(r.spacex), others: Math.round(r.others) }))
    .sort((a, b) => a.year.localeCompare(b.year));

  res.json({ byYearProvider });
});

// SpaceX Falcon vs Starship mass by year (2010+)
router.get("/satcat/falcon-vs-starship", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  const payloads = data.filter((e) => e.objectClass === "P");

  type Row = { year: string; falcon: number; starship: number };
  const map = new Map<string, Row>();

  for (const e of payloads) {
    const year = getYear(e.ldate);
    if (!year || parseInt(year) < 2010) continue;
    const mass = e.massKg ?? 0;
    const lv = ((e.lvFamily ?? "") + " " + (e.lv ?? "")).toLowerCase();
    if (!lv.includes("falcon") && !lv.includes("starship")) continue;
    const row = map.get(year) ?? { year, falcon: 0, starship: 0 };
    if (lv.includes("falcon")) {
      row.falcon += mass;
    } else {
      row.starship += mass;
    }
    map.set(year, row);
  }

  const rows = Array.from(map.values())
    .map((r) => ({ ...r, falcon: Math.round(r.falcon), starship: Math.round(r.starship) }))
    .sort((a, b) => a.year.localeCompare(b.year));

  const starshipTotal = rows.reduce((s, r) => s + r.starship, 0);
  res.json({ rows, starshipTotal });
});

// SpaceX (Falcon family) monthly mass by launch site for a given year
router.get("/satcat/spacex-by-site-monthly", async (req, res): Promise<void> => {
  const data = await getSatcat();
  const year = String(req.query.year ?? new Date().getFullYear()).trim();

  const payloads = data.filter(
    (e) =>
      e.objectClass === "P" &&
      (e.lvFamily ?? "").toLowerCase().includes("falcon") &&
      getYear(e.ldate) === year,
  );

  const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

  type MonthRow = { month: string; monthNum: number; capeCanaveral: number; vandenberg: number; other: number };
  const rows: MonthRow[] = MONTH_NAMES.map((month, i) => ({
    month, monthNum: i + 1, capeCanaveral: 0, vandenberg: 0, other: 0,
  }));

  for (const e of payloads) {
    if (!e.ldate) continue;
    const monthNum = parseInt(e.ldate.split("-")[1] ?? "0", 10);
    if (monthNum < 1 || monthNum > 12) continue;
    const mass = e.massKg ?? 0;
    const site = (e.site ?? "").toUpperCase();
    const row = rows[monthNum - 1];
    if (site === "CC" || site.startsWith("KSC")) {
      row.capeCanaveral += mass;
    } else if (site.startsWith("VSFB") || site.startsWith("VAFB")) {
      row.vandenberg += mass;
    } else {
      row.other += mass;
    }
  }

  const result = rows.map((r) => ({
    ...r,
    capeCanaveral: Math.round(r.capeCanaveral),
    vandenberg: Math.round(r.vandenberg),
    other: Math.round(r.other),
  }));

  res.json({ year, rows: result });
});

// SpaceX (Falcon family) mass by launch site, 2010+
router.get("/satcat/spacex-by-site", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  const payloads = data.filter(
    (e) => e.objectClass === "P" && (e.lvFamily ?? "").toLowerCase().includes("falcon"),
  );

  type SiteRow = { year: string; capeCanaveral: number; vandenberg: number; other: number };
  const map = new Map<string, SiteRow>();

  for (const e of payloads) {
    const year = getYear(e.ldate);
    if (!year || parseInt(year) < 2010) continue;
    const mass = e.massKg ?? 0;
    const site = (e.site ?? "").toUpperCase();
    const row = map.get(year) ?? { year, capeCanaveral: 0, vandenberg: 0, other: 0 };
    if (site === "CC" || site.startsWith("KSC")) {
      row.capeCanaveral += mass;
    } else if (site.startsWith("VSFB") || site.startsWith("VAFB")) {
      row.vandenberg += mass;
    } else {
      row.other += mass;
    }
    map.set(year, row);
  }

  const rows = Array.from(map.values())
    .map((r) => ({
      ...r,
      capeCanaveral: Math.round(r.capeCanaveral),
      vandenberg: Math.round(r.vandenberg),
      other: Math.round(r.other),
    }))
    .sort((a, b) => a.year.localeCompare(b.year));

  res.json({ rows });
});

// SpaceX (Falcon family) mass by customer segment, 2010+
const US_GOV_OWNERS = new Set([
  "NASA", "USAF", "USSF", "USN", "USA", "NRO", "NOAA", "USGS", "NSF",
  "DARPA", "DOD", "USDOD", "AFRL", "MDA", "USDOE", "USCG",
]);

router.get("/satcat/spacex-by-entity", async (_req, res): Promise<void> => {
  const data = await getSatcat();
  const payloads = data.filter(
    (e) => e.objectClass === "P" && (e.lvFamily ?? "").toLowerCase().includes("falcon"),
  );

  type EntityRow = { year: string; starlink: number; usGov: number; commercial: number };
  const map = new Map<string, EntityRow>();

  for (const e of payloads) {
    const year = getYear(e.ldate);
    if (!year || parseInt(year) < 2010) continue;
    const mass = e.massKg ?? 0;
    const row = map.get(year) ?? { year, starlink: 0, usGov: 0, commercial: 0 };

    if (e.name.toUpperCase().includes("STARLINK")) {
      row.starlink += mass;
    } else if (e.state === "US" && e.owner && US_GOV_OWNERS.has(e.owner)) {
      row.usGov += mass;
    } else {
      row.commercial += mass;
    }
    map.set(year, row);
  }

  const rows = Array.from(map.values())
    .map((r) => ({
      ...r,
      starlink: Math.round(r.starlink),
      usGov: Math.round(r.usGov),
      commercial: Math.round(r.commercial),
    }))
    .sort((a, b) => a.year.localeCompare(b.year));

  res.json({ rows });
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

  res.json({ owners, orbits, satStates, objectClasses });
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
  const sortField = String(req.query.sort ?? "ldate").trim();
  const sortOrder = String(req.query.order ?? "desc").trim();

  let filtered = data;

  if (search) {
    filtered = filtered.filter(
      (e) =>
        e.name.toLowerCase().includes(search) ||
        (e.plName?.toLowerCase().includes(search) ?? false) ||
        e.jcat.toLowerCase().includes(search) ||
        (e.satno != null && String(e.satno).includes(search)),
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

  res.json({ data: slice, total, page, limit, pages });
});

export default router;
