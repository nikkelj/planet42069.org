import { logger } from "../logger";

const BASE = "https://www.space-track.org";
const FETCH_TIMEOUT_MS = 120_000;

export interface SpacetrackRow {
  NORAD_CAT_ID: string;
  OBJECT_ID: string | null;   // intl designator "2026-160A"
  OBJECT_NAME: string | null;
  OBJECT_TYPE: string | null; // PAYLOAD | ROCKET BODY | DEBRIS | UNKNOWN
  COUNTRY: string | null;
  LAUNCH: string | null;      // "2026-07-14"
  SITE: string | null;
  DECAY: string | null;
  APOGEE: string | null;
  PERIGEE: string | null;
  INCLINATION: string | null;
  CURRENT: string | null;     // "Y"/"N"
}

async function login(): Promise<string> {
  const user = process.env["SPACETRACK_USERNAME"];
  const pass = process.env["SPACETRACK_PASSWORD"];
  if (!user || !pass) throw new Error("SPACETRACK_USERNAME / SPACETRACK_PASSWORD not set");

  const res = await fetch(`${BASE}/ajaxauth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ identity: user, password: pass }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`space-track login failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("space-track login: no session cookie returned");
  return cookie.split(";")[0];
}

/**
 * Fetch the full space-track satellite catalog (current + decayed).
 * One request per day; well within space-track rate limits.
 */
export async function fetchSpacetrackSatcat(): Promise<SpacetrackRow[]> {
  const cookie = await login();
  const url = `${BASE}/basicspacedata/query/class/satcat/orderby/NORAD_CAT_ID%20asc/format/json`;
  logger.info({ url }, "spacetrack: fetching satcat");
  const res = await fetch(url, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`space-track satcat fetch failed: ${res.status}`);
  const rows = (await res.json()) as SpacetrackRow[];
  if (!Array.isArray(rows) || rows.length < 10_000) {
    throw new Error(`space-track satcat suspiciously small: ${Array.isArray(rows) ? rows.length : typeof rows} rows`);
  }
  logger.info({ count: rows.length }, "spacetrack: satcat fetched");
  return rows;
}
