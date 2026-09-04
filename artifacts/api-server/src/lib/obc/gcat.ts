import { logger } from "../logger";

const SATCAT_URL = "https://planet4589.org/space/gcat/tsv/cat/satcat.tsv";
const LAUNCH_URL = "https://planet4589.org/space/gcat/tsv/launch/launch.tsv";

/**
 * Per-file abort. Replit autoscale CPU can stall while buffering the ~20 MB
 * satcat + ~14 MB launch TSVs; 60s was not enough for a dual parallel pull.
 */
export const GCAT_FETCH_TIMEOUT_MS = 180_000;
export const GCAT_MIN_BYTES = 100_000;
export const GCAT_SATCAT_URL = SATCAT_URL;
export const GCAT_LAUNCH_URL = LAUNCH_URL;

export type GcatFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

async function fetchText(url: string, fetchImpl: GcatFetch, label: string): Promise<string> {
  logger.info({ url, timeoutMs: GCAT_FETCH_TIMEOUT_MS, label }, "gcat: fetching");
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": "planet42069-space-report/1.0" },
      signal: AbortSignal.timeout(GCAT_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const ms = Date.now() - t0;
    throw new Error(`gcat fetch aborted/failed after ${ms}ms (${label}, ${url}): ${String(err)}`);
  }
  if (!res.ok) throw new Error(`gcat fetch failed: ${res.status} ${res.statusText} (${url})`);
  const contentLength = res.headers.get("content-length");
  logger.info(
    { url, status: res.status, contentLength, label, headerMs: Date.now() - t0 },
    "gcat: reading body",
  );
  const text = await res.text();
  const ms = Date.now() - t0;
  logger.info({ url, bytes: text.length, ms, label }, "gcat: fetch complete");
  if (text.length < GCAT_MIN_BYTES) {
    throw new Error(`gcat response suspiciously small: ${text.length} bytes (${url})`);
  }
  return text;
}

/**
 * Pull both GCAT TSVs sequentially. Parallel ~33 MB downloads on autoscale
 * compete for CPU/memory and both tend to abort at the shared timeout.
 */
export async function fetchGcatCatalog(
  fetchImpl: GcatFetch = (url, init) => fetch(url, init),
): Promise<{ satTsv: string; launchTsv: string }> {
  const satTsv = await fetchText(SATCAT_URL, fetchImpl, "satcat");
  const launchTsv = await fetchText(LAUNCH_URL, fetchImpl, "launch");
  return { satTsv, launchTsv };
}

export const fetchGcatSatcatTsv = (): Promise<string> =>
  fetchText(SATCAT_URL, (url, init) => fetch(url, init), "satcat");
export const fetchGcatLaunchTsv = (): Promise<string> =>
  fetchText(LAUNCH_URL, (url, init) => fetch(url, init), "launch");
