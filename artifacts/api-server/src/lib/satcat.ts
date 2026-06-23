import { logger } from "./logger";

const SATCAT_URL = "https://planet4589.org/space/gcat/tsv/cat/satcat.tsv";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface SatcatEntry {
  jcat: string;
  satno: number | null;
  name: string;
  plName: string | null;
  ldate: string | null;       // ISO date "YYYY-MM-DD"
  lv: string | null;
  lvFamily: string | null;
  site: string | null;
  owner: string | null;
  state: string | null;
  objectClass: string | null; // First char of Type: P/R/D/U
  objType: string | null;     // Full Type string
  opOrbit: string | null;     // Normalised orbit class
  satState: string | null;    // Status column
  massKg: number | null;
  apogeeKm: number | null;
  perigeeKm: number | null;
  incDeg: number | null;
  periodMin: number | null;
  decayDate: string | null;
}

interface Cache {
  data: SatcatEntry[];
  fetchedAt: number;
}

let cache: Cache | null = null;
let inflight: Promise<SatcatEntry[]> | null = null;

// ── helpers ────────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/** "1957 Oct  4" → "1957-10-04". Returns null for "-" or unparseable. */
function parseLDate(raw: string): string | null {
  const s = raw?.trim();
  if (!s || s === "-") return null;
  const m = s.match(/^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})/);
  if (!m) return null;
  const mo = MONTH_MAP[m[2]];
  return mo ? `${m[1]}-${mo}-${m[3].padStart(2, "0")}` : null;
}

function parseNum(val: string): number | null {
  const s = val?.trim();
  if (!s || s === "-") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseStr(val: string): string | null {
  const s = val?.trim();
  return s && s !== "-" ? s : null;
}

/**
 * Normalise the OpOrbit column to a short canonical class for grouping.
 * Real values include: LLEO/I, LEO/I, LEO/E, VLEO, GTO, GEO/S, MEO, HEO, etc.
 */
function normaliseOrbit(raw: string): string | null {
  const s = raw?.trim().toUpperCase();
  if (!s || s === "-") return null;
  const base = s.split("/")[0]; // drop /I, /S, /E qualifiers
  if (/^[LVEP]?LEO/.test(base) || base === "EEO" || base === "PLEO") return "LEO";
  if (base === "GTO" || base.startsWith("GTO")) return "GTO";
  if (base === "GEO" || base.startsWith("GEO")) return "GEO";
  if (base.startsWith("MEO")) return "MEO";
  if (base.startsWith("HEO") || base === "MOLNIYA" || base === "TUNDRA") return "HEO";
  if (base === "SSO") return "SSO";
  if (base.startsWith("DSO") || base === "HELIO" || base === "ESCAPE" || base === "LLO" || base === "HCO") return "Deep Space";
  return base || null;
}

// ── TSV parser ─────────────────────────────────────────────────────────────

/**
 * GCAT satcat.tsv header (tab-separated, prefixed with '#'):
 * 0  JCAT | 1  Satcat | 2  Launch_Tag | 3  Piece | 4  Type |
 * 5  Name | 6  PLName | 7  LDate | 8  Parent | 9  SDate |
 * 10 Primary | 11 DDate | 12 Status | 13 Dest | 14 Owner |
 * 15 State | 16 Manufacturer | 17 Bus | 18 Motor | 19 Mass |
 * 20 MassFlag | 21 DryMass | … | 33 Perigee | 34 PF |
 * 35 Apogee | 36 AF | 37 Inc | 38 IF | 39 OpOrbit | …
 */
function parseTsv(raw: string): SatcatEntry[] {
  const lines = raw.split("\n");

  // Find the header line (starts with '#' and contains tabs)
  let headers: string[] = [];
  let dataStart = 0;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].startsWith("#") && lines[i].includes("\t")) {
      headers = lines[i].substring(1).split("\t").map((h) => h.trim().toLowerCase());
      dataStart = i + 1;
      break;
    }
  }

  if (!headers.length) {
    logger.warn("satcat: could not find TSV header");
    return [];
  }

  logger.info({ headerCount: headers.length, headers: headers.slice(0, 10) }, "satcat: parsed header");

  const idx = (name: string) => headers.indexOf(name);

  // Column indices using real (lowercased) column names from the TSV
  const C = {
    jcat:    idx("jcat"),
    satcat:  idx("satcat"),
    type:    idx("type"),     // object class: P/R/D...
    name:    idx("name"),
    plname:  idx("plname"),
    ldate:   idx("ldate"),
    ddate:   idx("ddate"),
    status:  idx("status"),   // operational status: O/D/R...
    owner:   idx("owner"),
    state:   idx("state"),
    mass:    idx("mass"),
    perigee: idx("perigee"),
    apogee:  idx("apogee"),
    inc:     idx("inc"),
    // "OpOrbit".toLowerCase() === "oporbit"
    oporbit: idx("oporbit"),
  };

  logger.info({ indices: C }, "satcat: column indices");

  const entries: SatcatEntry[] = [];

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;

    const cols = line.split("\t");
    if (cols.length < 10) continue;

    const get = (ci: number) => (ci >= 0 && ci < cols.length ? cols[ci] ?? "" : "");

    const jcat = parseStr(get(C.jcat)) ?? "";
    if (!jcat) continue;

    const rawType = get(C.type).trim();
    // First character of Type encodes the object class
    const objectClass = rawType.length > 0 ? rawType[0].toUpperCase() : null;

    const satnoRaw = get(C.satcat).trim();
    const satno = satnoRaw && satnoRaw !== "-" ? parseInt(satnoRaw, 10) : null;

    entries.push({
      jcat,
      satno: satno && !isNaN(satno) ? satno : null,
      name: parseStr(get(C.name)) ?? jcat,
      plName: parseStr(get(C.plname)),
      ldate: parseLDate(get(C.ldate)),
      lv: null,       // not in satcat.tsv
      lvFamily: null, // not in satcat.tsv
      site: null,     // not in satcat.tsv
      owner: parseStr(get(C.owner)),
      state: parseStr(get(C.state)),
      objectClass,
      objType: parseStr(rawType) ?? null,
      opOrbit: normaliseOrbit(get(C.oporbit)),
      satState: parseStr(get(C.status)),
      massKg: parseNum(get(C.mass)),
      apogeeKm: parseNum(get(C.apogee)),
      perigeeKm: parseNum(get(C.perigee)),
      incDeg: parseNum(get(C.inc)),
      periodMin: null, // not in satcat.tsv
      decayDate: parseStr(get(C.ddate)),
    });
  }

  return entries;
}

// ── fetch + cache ──────────────────────────────────────────────────────────

async function fetchAndParse(): Promise<SatcatEntry[]> {
  logger.info({ url: SATCAT_URL }, "satcat: fetching");
  const res = await fetch(SATCAT_URL, {
    headers: { "User-Agent": "planet42069-space-report/1.0" },
  });
  if (!res.ok) throw new Error(`satcat fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  logger.info({ bytes: text.length }, "satcat: fetched, parsing");
  const entries = parseTsv(text);
  logger.info({ count: entries.length }, "satcat: parsed");
  if (entries.length > 0) {
    logger.info({ e0: entries[0], e1: entries[1] }, "satcat: first 2 entries");
  }
  return entries;
}

export async function getSatcat(): Promise<SatcatEntry[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = fetchAndParse()
    .then((data) => {
      cache = { data, fetchedAt: Date.now() };
      inflight = null;
      return data;
    })
    .catch((err) => {
      inflight = null;
      if (cache) {
        logger.warn({ err }, "satcat: fetch failed, serving stale cache");
        return cache.data;
      }
      throw err;
    });

  return inflight;
}

export function getCacheAge(): number {
  if (!cache) return -1;
  return Math.floor((Date.now() - cache.fetchedAt) / 1000);
}

// Warm cache in background on startup
setTimeout(() => {
  getSatcat().catch((err) => logger.warn({ err }, "satcat: warmup failed"));
}, 1000);
