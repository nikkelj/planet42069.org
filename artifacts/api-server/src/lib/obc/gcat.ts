import { logger } from "../logger";

const SATCAT_URL = "https://planet4589.org/space/gcat/tsv/cat/satcat.tsv";
const LAUNCH_URL = "https://planet4589.org/space/gcat/tsv/launch/launch.tsv";
const FETCH_TIMEOUT_MS = 60_000;

async function fetchText(url: string): Promise<string> {
  logger.info({ url }, "gcat: fetching");
  const res = await fetch(url, {
    headers: { "User-Agent": "planet42069-space-report/1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gcat fetch failed: ${res.status} ${res.statusText} (${url})`);
  const text = await res.text();
  if (text.length < 100_000) throw new Error(`gcat response suspiciously small: ${text.length} bytes (${url})`);
  return text;
}

export const fetchGcatSatcatTsv = (): Promise<string> => fetchText(SATCAT_URL);
export const fetchGcatLaunchTsv = (): Promise<string> => fetchText(LAUNCH_URL);
