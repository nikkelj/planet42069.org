import { logger } from "./logger";

const LAUNCH_URL = "https://planet4589.org/space/gcat/tsv/launch/launch.tsv";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface LaunchEntry {
  launchTag: string;
  lv: string | null;        // LV_Type from launch.tsv
  lvFamily: string | null;  // Derived family name
  site: string | null;      // Launch_Site code
}

interface Cache {
  data: Map<string, LaunchEntry>;
  fetchedAt: number;
}

let cache: Cache | null = null;
let inflight: Promise<Map<string, LaunchEntry>> | null = null;

function parseStr(val: string): string | null {
  const s = val?.trim();
  return s && s !== "-" ? s : null;
}

/**
 * Derive a human-readable launch vehicle family from the raw LV_Type string.
 * e.g. "Falcon 9 v1.2" → "Falcon 9", "Soyuz-2.1b" → "Soyuz-2", "Long March 2D" → "Long March 2D"
 */
function deriveLvFamily(lvType: string): string {
  const stripped = lvType
    .replace(/\s+v\d+(\.\d+)*[a-z]?$/i, "")   // strip trailing version " v1.2"
    .replace(/\s+(Block|Blk)\s+\d+[A-Z]?/i, "") // strip "Block 5"
    .replace(/\s+(ECA|ES|G\+|EL|EC|Plus)\s*$/i, "") // strip Ariane suffixes
    .trim();
  return stripped || lvType;
}

function parseLaunchTsv(raw: string): Map<string, LaunchEntry> {
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
    launchTag: idx("launch_tag"),
    lvType:    idx("lv_type"),
    site:      idx("launch_site"),
  };

  logger.info({ headerCount: headers.length, indices: C }, "launch: parsed header");

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 5) continue;

    const get = (ci: number) => (ci >= 0 && ci < cols.length ? cols[ci] ?? "" : "");
    const launchTag = parseStr(get(C.launchTag));
    if (!launchTag) continue;

    const lvRaw = parseStr(get(C.lvType));
    map.set(launchTag, {
      launchTag,
      lv: lvRaw,
      lvFamily: lvRaw ? deriveLvFamily(lvRaw) : null,
      site: parseStr(get(C.site)),
    });
  }

  logger.info({ count: map.size }, "launch: parsed");
  return map;
}

async function fetchAndParse(): Promise<Map<string, LaunchEntry>> {
  logger.info({ url: LAUNCH_URL }, "launch: fetching");
  const res = await fetch(LAUNCH_URL, {
    headers: { "User-Agent": "planet42069-space-report/1.0" },
  });
  if (!res.ok) throw new Error(`launch fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  logger.info({ bytes: text.length }, "launch: fetched, parsing");
  return parseLaunchTsv(text);
}

export async function getLaunchMap(): Promise<Map<string, LaunchEntry>> {
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
        logger.warn({ err }, "launch: fetch failed, serving stale cache");
        return cache.data;
      }
      throw err;
    });

  return inflight;
}

// Warm cache in background on startup
setTimeout(() => {
  getLaunchMap().catch((err) => logger.warn({ err }, "launch: warmup failed"));
}, 2000);
