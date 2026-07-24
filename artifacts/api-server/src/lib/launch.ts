import { logger } from "./logger";
import { getLaunchMapFromStore } from "./obc/store";

/**
 * GCAT launch.tsv parser + LaunchEntry shape. Data is served from the OBC
 * catalogue (Postgres, synced daily) — no request-path fetches anymore.
 */

export interface LaunchEntry {
  launchTag: string;
  lv: string | null;        // LV_Type from launch.tsv
  lvFamily: string | null;  // Derived family name
  site: string | null;      // Launch_Site code
  ldate: string | null;     // ISO date "YYYY-MM-DD" parsed from Launch_Date
  orbital: boolean;         // true for orbital / deep-space launches (LaunchCode O*/D*)
}

function parseStr(val: string): string | null {
  const s = val?.trim();
  return s && s !== "-" ? s : null;
}

const MONTH_MAP: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/** "2025 Jan  4 0127" → "2025-01-04". Returns null for "-" or unparseable. */
function parseLDate(raw: string): string | null {
  const s = raw?.trim();
  if (!s || s === "-") return null;
  const m = s.match(/^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})/);
  if (!m) return null;
  const mo = MONTH_MAP[m[2]];
  return mo ? `${m[1]}-${mo}-${m[3].padStart(2, "0")}` : null;
}

/**
 * Derive a human-readable launch vehicle family from the raw LV_Type string.
 * e.g. "Falcon 9 v1.2" → "Falcon 9", "Soyuz-2.1b" → "Soyuz-2"
 */
function deriveLvFamily(lvType: string): string {
  const stripped = lvType
    .replace(/\s+v\d+(\.\d+)*[a-z]?$/i, "")
    .replace(/\s+(Block|Blk)\s+\d+[A-Z]?/i, "")
    .replace(/\s+(ECA|ES|G\+|EL|EC|Plus)\s*$/i, "")
    .trim();
  return stripped || lvType;
}

export function parseLaunchTsv(raw: string): Map<string, LaunchEntry> {
  const lines = raw.split("\n");
  const map = new Map<string, LaunchEntry>();

  let headers: string[] = [];
  let dataStart = 0;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (lines[i].startsWith("#") && lines[i].includes("\t")) {
      headers = lines[i].substring(1).split("\t").map((h) => h.trim().toLowerCase());
      dataStart = i + 1;
      break;
    }
  }
  if (!headers.length) {
    logger.warn("launch: could not find TSV header");
    return map;
  }

  const idx = (name: string) => headers.indexOf(name);
  const C = {
    launchTag:  idx("launch_tag"),
    lvType:     idx("lv_type"),
    site:       idx("launch_site"),
    launchDate: idx("launch_date"),
    launchCode: idx("launchcode"),
  };

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 5) continue;

    const get = (ci: number) => (ci >= 0 && ci < cols.length ? cols[ci] ?? "" : "");
    const launchTag = parseStr(get(C.launchTag));
    if (!launchTag) continue;

    const lvRaw = parseStr(get(C.lvType));
    const code = get(C.launchCode).trim().toUpperCase();
    const first = code.charAt(0);
    map.set(launchTag, {
      launchTag,
      lv: lvRaw,
      lvFamily: lvRaw ? deriveLvFamily(lvRaw) : null,
      site: parseStr(get(C.site)),
      ldate: parseLDate(get(C.launchDate)),
      orbital: first === "O" || first === "D",
    });
  }

  logger.info({ count: map.size }, "launch: parsed");
  return map;
}

// ── public API (backed by the OBC catalogue in Postgres) ──────────────────

export async function getLaunchMap(): Promise<Map<string, LaunchEntry>> {
  return getLaunchMapFromStore();
}
