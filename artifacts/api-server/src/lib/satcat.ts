import { logger } from "./logger";
import { getSatcatFromStore, getStoreCacheAge } from "./obc/store";

/**
 * GCAT satcat TSV parser + the SatcatEntry shape used across all analytics.
 * Data is served from the OBC catalogue (Postgres, merged GCAT + space-track,
 * synced daily) — no request-path fetches to planet4589.org anymore.
 */

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
  massEstimated: boolean;     // true when massKg is a Bureau estimate, not GCAT data
  apogeeKm: number | null;
  perigeeKm: number | null;
  incDeg: number | null;
  periodMin: number | null;
  decayDate: string | null;
  // Gunter's Space Page annotations (fusion source #3)
  gunterType: string | null;      // "Type / Application", e.g. "Communication"
  gunterUrl: string | null;       // dossier cross-link on space.skyrocket.de
  gunterTitle: string | null;     // dossier title, for Krebs-format citations
  gunterRetrievedAt: string | null; // ISO date the dossier was retrieved
}

/** Parser output — includes the GCAT Launch_Tag for launch cross-referencing. */
export type SatcatRawEntry = SatcatEntry & { launchTag: string | null };

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
 * JCAT | Satcat | Launch_Tag | Piece | Type | Name | PLName | LDate | ... |
 * DDate | Status | ... | Owner | State | ... | Mass | ... | Perigee |
 * Apogee | Inc | ... | OpOrbit | ...
 */
export function parseTsv(raw: string): SatcatRawEntry[] {
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

  const idx = (name: string) => headers.indexOf(name);

  const C = {
    jcat:       idx("jcat"),
    satcat:     idx("satcat"),
    launch_tag: idx("launch_tag"),
    type:       idx("type"),
    name:       idx("name"),
    plname:     idx("plname"),
    ldate:      idx("ldate"),
    ddate:      idx("ddate"),
    status:     idx("status"),
    owner:      idx("owner"),
    state:      idx("state"),
    mass:       idx("mass"),
    perigee:    idx("perigee"),
    apogee:     idx("apogee"),
    inc:        idx("inc"),
    oporbit:    idx("oporbit"),
  };

  const entries: SatcatRawEntry[] = [];

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;

    const cols = line.split("\t");
    if (cols.length < 10) continue;

    const get = (ci: number) => (ci >= 0 && ci < cols.length ? cols[ci] ?? "" : "");

    const jcat = parseStr(get(C.jcat)) ?? "";
    if (!jcat) continue;

    const rawType = get(C.type).trim();
    const objectClass = rawType.length > 0 ? rawType[0].toUpperCase() : null;

    const satnoRaw = get(C.satcat).trim();
    const satno = satnoRaw && satnoRaw !== "-" ? parseInt(satnoRaw, 10) : null;

    entries.push({
      jcat,
      satno: satno && !isNaN(satno) ? satno : null,
      name: parseStr(get(C.name)) ?? jcat,
      plName: parseStr(get(C.plname)),
      ldate: parseLDate(get(C.ldate)),
      launchTag: parseStr(get(C.launch_tag)),
      lv: null,       // enriched from launch map during sync
      lvFamily: null,
      site: null,
      owner: parseStr(get(C.owner)),
      state: parseStr(get(C.state)),
      objectClass,
      objType: parseStr(rawType) ?? null,
      opOrbit: normaliseOrbit(get(C.oporbit)),
      satState: parseStr(get(C.status)),
      massKg: parseNum(get(C.mass)),
      massEstimated: false,
      apogeeKm: parseNum(get(C.apogee)),
      perigeeKm: parseNum(get(C.perigee)),
      incDeg: parseNum(get(C.inc)),
      periodMin: null,
      decayDate: parseStr(get(C.ddate)),
      gunterType: null,
      gunterUrl: null,
      gunterTitle: null,
      gunterRetrievedAt: null,
    });
  }

  return entries;
}

// ── public API (backed by the OBC catalogue in Postgres) ──────────────────

export async function getSatcat(): Promise<SatcatEntry[]> {
  return getSatcatFromStore();
}

export function getCacheAge(): number {
  return getStoreCacheAge();
}
