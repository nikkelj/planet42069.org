import { logger } from "./logger";

/**
 * Per-NORAD TLE fetch + cache against space-track.org's GP class.
 *
 * space-track rate limits are strict (< 30 req/min, < 300 req/hr), so:
 *  - element sets are cached in memory for 6 hours (TLEs barely move that fast)
 *  - negative results (no elset) are cached for 1 hour
 *  - all outbound requests go through a serialized queue with a minimum
 *    2-second gap between hits
 *  - the login cookie is reused for ~2 hours instead of re-authing per call
 */

const BASE = "https://www.space-track.org";
const TLE_TTL_MS = 6 * 3600_000;
const NEG_TTL_MS = 3600_000;
const COOKIE_TTL_MS = 2 * 3600_000;
const MIN_GAP_MS = 2000;

export interface TleData {
  norad: number;
  name: string | null;
  line1: string;
  line2: string;
  epoch: string;
  incDeg: number;
  raanDeg: number;
  argPerigeeDeg: number;
  meanAnomalyDeg: number;
  eccentricity: number;
  meanMotionRevPerDay: number;
  fetchedAt: string;
}

interface GpRow {
  NORAD_CAT_ID: string;
  OBJECT_NAME: string | null;
  EPOCH: string;
  INCLINATION: string;
  RA_OF_ASC_NODE: string;
  ARG_OF_PERICENTER: string;
  MEAN_ANOMALY: string;
  ECCENTRICITY: string;
  MEAN_MOTION: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
}

const cache = new Map<number, { data: TleData | null; expires: number }>();
const inflight = new Map<number, Promise<TleData | null>>();

let cookie: { value: string; expires: number } | null = null;
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

async function getCookie(): Promise<string> {
  if (cookie && cookie.expires > Date.now()) return cookie.value;
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
  const raw = res.headers.get("set-cookie");
  if (!raw) throw new Error("space-track login: no session cookie returned");
  cookie = { value: raw.split(";")[0], expires: Date.now() + COOKIE_TTL_MS };
  return cookie.value;
}

/** Fetch the latest GP element set for a NORAD id. Returns null when none exists. */
export async function getTle(norad: number): Promise<TleData | null> {
  const hit = cache.get(norad);
  if (hit && hit.expires > Date.now()) return hit.data;

  const pending = inflight.get(norad);
  if (pending) return pending;

  const p = throttled(async () => {
    const c = await getCookie();
    const url =
      `${BASE}/basicspacedata/query/class/gp/NORAD_CAT_ID/${norad}` +
      `/orderby/EPOCH%20desc/limit/1/format/json`;
    const res = await fetch(url, {
      headers: { Cookie: c },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) {
      cookie = null; // force re-auth next time
      throw new Error(`space-track gp fetch unauthorized: ${res.status}`);
    }
    if (!res.ok) throw new Error(`space-track gp fetch failed: ${res.status}`);
    const rows = (await res.json()) as GpRow[];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || !row.TLE_LINE1 || !row.TLE_LINE2) {
      cache.set(norad, { data: null, expires: Date.now() + NEG_TTL_MS });
      logger.info({ norad }, "spacetrack: no GP element set on file");
      return null;
    }
    const data: TleData = {
      norad,
      name: row.OBJECT_NAME,
      line1: row.TLE_LINE1,
      line2: row.TLE_LINE2,
      epoch: row.EPOCH.endsWith("Z") ? row.EPOCH : row.EPOCH + "Z",
      incDeg: parseFloat(row.INCLINATION),
      raanDeg: parseFloat(row.RA_OF_ASC_NODE),
      argPerigeeDeg: parseFloat(row.ARG_OF_PERICENTER),
      meanAnomalyDeg: parseFloat(row.MEAN_ANOMALY),
      eccentricity: parseFloat(row.ECCENTRICITY),
      meanMotionRevPerDay: parseFloat(row.MEAN_MOTION),
      fetchedAt: new Date().toISOString(),
    };
    cache.set(norad, { data, expires: Date.now() + TLE_TTL_MS });
    logger.info({ norad, epoch: data.epoch }, "spacetrack: GP element set fetched");
    return data;
  }).finally(() => inflight.delete(norad));

  inflight.set(norad, p);
  return p;
}
