/**
 * Static launch manifest served from /launches/index.json.
 *
 * Each entry carries: slug, name, vehicle, t0_utc, status,
 * phase ("upcoming" | "recent"), files.csv, files.kml, illustrative,
 * plus optional confidence and sources. This desk only displays the
 * fields the board needs; extra keys are ignored.
 */

export interface LaunchFiles {
  csv: string | null;
  kml: string | null;
}

export interface LaunchEntry {
  slug: string;
  name: string;
  vehicle: string;
  /** ISO-8601 UTC instant from `t0_utc`. Empty when the manifest omitted it. */
  t0Utc: string;
  status: string;
  /** "upcoming" or "recent" in the published manifest. */
  phase: string;
  files: LaunchFiles;
  illustrative: boolean;
}

export type LaunchIndexResult =
  | { ok: true; launches: LaunchEntry[] }
  | { ok: false; reason: "unavailable" };

export interface LaunchSections {
  upcoming: LaunchEntry[];
  recent: LaunchEntry[];
}

function siteBase(): string {
  const base = import.meta.env.BASE_URL;
  if (typeof base !== "string" || base.length === 0) return "/";
  return base.endsWith("/") ? base : `${base}/`;
}

/** Public URL of the static manifest, respecting the Vite base path. */
export function launchIndexUrl(): string {
  return `${siteBase()}launches/index.json`;
}

/**
 * Turn a manifest path (`/launches/.../trajectory.csv`) into a same-origin
 * href under the site base. Absolute http(s) URLs pass through.
 */
export function publicAssetHref(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${siteBase()}${trimmed.replace(/^\/+/, "")}`;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseLaunch(item: unknown): LaunchEntry | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const slug = asString(row.slug);
  const name = asString(row.name);
  if (!slug && !name) return null;

  const files =
    row.files && typeof row.files === "object"
      ? (row.files as Record<string, unknown>)
      : {};

  return {
    slug: slug ?? name!,
    name: name ?? slug!,
    vehicle: asString(row.vehicle) ?? "—",
    t0Utc: asString(row.t0_utc) ?? "",
    status: asString(row.status) ?? "—",
    phase: asString(row.phase) ?? "",
    files: {
      csv: asString(files.csv),
      kml: asString(files.kml),
    },
    illustrative: row.illustrative === true,
  };
}

/** Parse a manifest body. An array (including `[]`) is a successful read. */
export function parseLaunchIndex(data: unknown): LaunchIndexResult {
  if (!Array.isArray(data)) return { ok: false, reason: "unavailable" };
  const launches: LaunchEntry[] = [];
  for (const item of data) {
    const parsed = parseLaunch(item);
    if (parsed) launches.push(parsed);
  }
  return { ok: true, launches };
}

function timeMs(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function compareByTime(a: LaunchEntry, b: LaunchEntry, direction: "asc" | "desc"): number {
  const am = timeMs(a.t0Utc);
  const bm = timeMs(b.t0Utc);
  if (am == null && bm == null) return 0;
  if (am == null) return 1;
  if (bm == null) return -1;
  return direction === "asc" ? am - bm : bm - am;
}

/**
 * Split the manifest into the two boards. Upcoming is soonest NET first.
 * Recent is latest T-0 first. An unrecognized phase is filed by the clock
 * so a row is never dropped: a future instant joins Upcoming, everything
 * else joins Recent.
 */
export function partitionLaunches(launches: LaunchEntry[], nowMs = Date.now()): LaunchSections {
  const upcoming: LaunchEntry[] = [];
  const recent: LaunchEntry[] = [];
  for (const launch of launches) {
    if (launch.phase === "upcoming") {
      upcoming.push(launch);
    } else if (launch.phase === "recent") {
      recent.push(launch);
    } else {
      const ms = timeMs(launch.t0Utc);
      if (ms != null && ms > nowMs) upcoming.push(launch);
      else recent.push(launch);
    }
  }
  upcoming.sort((a, b) => compareByTime(a, b, "asc"));
  recent.sort((a, b) => compareByTime(a, b, "desc"));
  return { upcoming, recent };
}

/** `2026-10-23T07:11:00Z` → `2026-10-23 07:11:00 UTC`. */
export function formatUtc(iso: string): string {
  const ms = timeMs(iso);
  if (ms == null) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

export async function loadLaunchIndex(
  fetchImpl: typeof fetch = fetch,
  url: string = launchIndexUrl(),
): Promise<LaunchIndexResult> {
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return { ok: false, reason: "unavailable" };
    const text = await response.text();
    if (!text.trim()) return { ok: true, launches: [] };
    try {
      return parseLaunchIndex(JSON.parse(text) as unknown);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
