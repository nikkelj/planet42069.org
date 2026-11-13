/**
 * Static launch manifest served from /launches/index.json.
 *
 * Current shape: { methods, references, launches: [...] }.
 * `files.csv` / `files.kml` are the surrogate track (published event times
 * and altitudes). `files.csv_sim` / `files.kml_sim` are the 3DOF sim.
 * A bare array of launches still parses, for manifests published before
 * the object wrapper.
 */

export interface LaunchFiles {
  csv: string | null;
  kml: string | null;
  csvSim: string | null;
  kmlSim: string | null;
}

export interface LaunchMethodNotes {
  csv: string | null;
  csvSim: string | null;
}

/** What the authoritative `t0_utc` instant means. Absent when the manifest does not say. */
export type LaunchTimeKind = "net" | "target" | "window_open";

export interface LaunchEntry {
  slug: string;
  name: string;
  vehicle: string;
  /** ISO-8601 UTC instant from `t0_utc`. Empty when the manifest omitted it. */
  t0Utc: string;
  /** `t0_kind` from the manifest: net, target, or window_open. */
  t0Kind: LaunchTimeKind | null;
  /** Separate window-open instant, when the manifest publishes one besides T-0. */
  windowOpenUtc: string | null;
  /** Separate window-close instant, when the manifest publishes one. */
  windowCloseUtc: string | null;
  status: string;
  /** "upcoming", "recent", or "flown" in the published manifest. */
  phase: string;
  files: LaunchFiles;
  illustrative: boolean;
  method: LaunchMethodNotes;
  referenceIds: string[];
}

export interface MethodBlurb {
  key: "surrogate" | "sim";
  title: string;
  summary: string;
}

export interface LaunchReference {
  id: string;
  title: string;
  url: string | null;
}

export interface LaunchManifest {
  launches: LaunchEntry[];
  methods: MethodBlurb[];
  /** Site path or URL of the long-form note, when the manifest names one. */
  methodsDoc: string | null;
  references: LaunchReference[];
  /** Body of METHODS.md when it could be fetched. Never required for the board. */
  methodsMarkdown: string | null;
}

export type LaunchIndexResult =
  | { ok: true; manifest: LaunchManifest }
  | { ok: false; reason: "unavailable" };

export interface LaunchSections {
  upcoming: LaunchEntry[];
  recent: LaunchEntry[];
}

export function emptyManifest(): LaunchManifest {
  return {
    launches: [],
    methods: [],
    methodsDoc: null,
    references: [],
    methodsMarkdown: null,
  };
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

export function defaultMethodsDocUrl(): string {
  return `${siteBase()}launches/METHODS.md`;
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

export function fileNameFromPath(path: string): string {
  const clean = path.split("?")[0]?.split("#")[0] ?? path;
  const name = clean.split("/").pop();
  return name && name.length > 0 ? name : "download";
}

/**
 * Per-launch download name so files from different launches don't collide,
 * e.g. `starlink-15-16_2026-10-27_trajectory.csv`.
 * Idempotent: a path that already uses that basename is returned unchanged.
 */
export function launchDownloadName(
  launch: { slug: string; t0Utc: string },
  path: string,
): string {
  const base = fileNameFromPath(path);
  const slug = launch.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const date = /^\d{4}-\d{2}-\d{2}/.exec(launch.t0Utc)?.[0] ?? "";
  const prefix = [slug, date].filter(Boolean).join("_");
  if (!prefix || base === prefix || base.startsWith(`${prefix}_`)) return base;
  return `${prefix}_${base}`;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseFiles(value: unknown): LaunchFiles {
  const files =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    csv: asString(files.csv),
    kml: asString(files.kml),
    csvSim: asString(files.csv_sim),
    kmlSim: asString(files.kml_sim),
  };
}

function parseMethod(value: unknown): LaunchMethodNotes {
  if (typeof value === "string") {
    const note = asString(value);
    return { csv: note, csvSim: note };
  }
  if (!value || typeof value !== "object") return { csv: null, csvSim: null };
  const row = value as Record<string, unknown>;
  return {
    csv: asString(row.csv),
    csvSim: asString(row.csv_sim),
  };
}

function parseReferenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    const id = asString(item);
    if (id) ids.push(id);
  }
  return ids;
}

function parseLaunch(item: unknown): LaunchEntry | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const slug = asString(row.slug);
  const name = asString(row.name);
  if (!slug && !name) return null;

  return {
    slug: slug ?? name!,
    name: name ?? slug!,
    vehicle: asString(row.vehicle) ?? "—",
    t0Utc: asString(row.t0_utc) ?? "",
    t0Kind: parseLaunchTimeKind(row.t0_kind),
    windowOpenUtc: asString(row.window_open_utc),
    windowCloseUtc: asString(row.window_close_utc),
    status: asString(row.status) ?? "—",
    phase: asString(row.phase) ?? "",
    files: parseFiles(row.files),
    illustrative: row.illustrative === true,
    method: parseMethod(row.method),
    referenceIds: parseReferenceIds(row.reference_ids),
  };
}

function parseLaunchList(items: unknown[]): LaunchEntry[] {
  const launches: LaunchEntry[] = [];
  for (const item of items) {
    const parsed = parseLaunch(item);
    if (parsed) launches.push(parsed);
  }
  return launches;
}

function parseMethods(value: unknown): { blurbs: MethodBlurb[]; doc: string | null } {
  if (!value || typeof value !== "object") return { blurbs: [], doc: null };
  const row = value as Record<string, unknown>;
  const blurbs: MethodBlurb[] = [];
  for (const key of ["surrogate", "sim"] as const) {
    const entry = row[key];
    if (!entry || typeof entry !== "object") continue;
    const blurb = entry as Record<string, unknown>;
    const title = asString(blurb.title);
    const summary = asString(blurb.summary);
    if (!title && !summary) continue;
    blurbs.push({
      key,
      title: title ?? (key === "surrogate" ? "Surrogate" : "3DOF sim"),
      summary: summary ?? "",
    });
  }
  return { blurbs, doc: asString(row.methods_doc) };
}

function parseReferences(value: unknown): LaunchReference[] {
  if (!Array.isArray(value)) return [];
  const references: LaunchReference[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = asString(row.id);
    const title = asString(row.title);
    if (!id && !title) continue;
    references.push({
      id: id ?? title!,
      title: title ?? id!,
      url: asString(row.url),
    });
  }
  return references;
}

/**
 * Parse a manifest body.
 * An object `{ launches: [...] }` is the current file. A bare array is the
 * previous file and still loads. `[]` and `{ launches: [] }` are empty boards.
 */
export function parseLaunchIndex(data: unknown): LaunchIndexResult {
  if (Array.isArray(data)) {
    return {
      ok: true,
      manifest: { ...emptyManifest(), launches: parseLaunchList(data) },
    };
  }
  if (!data || typeof data !== "object") return { ok: false, reason: "unavailable" };
  const row = data as Record<string, unknown>;
  if (!Array.isArray(row.launches)) return { ok: false, reason: "unavailable" };
  const methods = parseMethods(row.methods);
  return {
    ok: true,
    manifest: {
      launches: parseLaunchList(row.launches),
      methods: methods.blurbs,
      methodsDoc: methods.doc,
      references: parseReferences(row.references),
      methodsMarkdown: null,
    },
  };
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
 * Recent is latest T-0 first. `flown` is recent even when the client clock
 * is still before that T-0, so a recorded flight never grows a countdown.
 * An unrecognized phase is filed by the clock so a row is never dropped:
 * a future instant joins Upcoming, everything else joins Recent.
 */
export function partitionLaunches(launches: LaunchEntry[], nowMs = Date.now()): LaunchSections {
  const upcoming: LaunchEntry[] = [];
  const recent: LaunchEntry[] = [];
  for (const launch of launches) {
    if (launch.phase === "upcoming") {
      upcoming.push(launch);
    } else if (launch.phase === "recent" || launch.phase === "flown") {
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

/** How many flown (recent/flown) launches the ascent-globe legend keeps, most recent T-0 last. */
export const GLOBE_RECENT_LEGEND_CAP = 5;

/** Upcoming cap if that list would also overflow the legend. Soonest T-0 first. */
export const GLOBE_UPCOMING_LEGEND_CAP = 8;

export interface GlobeLegendLaunch {
  phase: string;
  t0_utc: string;
}

export interface GlobeLegendSelection<T> {
  items: T[];
  omittedFlown: number;
  omittedUpcoming: number;
}

/**
 * Legend-only slice for the ascent globe. Traces stay plotted; this only
 * decides which rows appear in the clickable legend. Flown/recent are
 * capped at the last GLOBE_RECENT_LEGEND_CAP by T-0. Upcoming stays
 * intact unless it exceeds GLOBE_UPCOMING_LEGEND_CAP, in which case the
 * soonest remain. Items stay in chronological T-0 order.
 */
export function selectGlobeLegendLaunches<T extends GlobeLegendLaunch>(
  launches: T[],
  recentCap = GLOBE_RECENT_LEGEND_CAP,
  upcomingCap = GLOBE_UPCOMING_LEGEND_CAP,
): GlobeLegendSelection<T> {
  const flown = launches.filter((l) => l.phase !== "upcoming");
  const upcoming = launches.filter((l) => l.phase === "upcoming");
  flown.sort((a, b) => a.t0_utc.localeCompare(b.t0_utc));
  upcoming.sort((a, b) => a.t0_utc.localeCompare(b.t0_utc));
  const flownShown = flown.slice(-recentCap);
  const upcomingShown = upcoming.slice(0, upcomingCap);
  return {
    items: [...flownShown, ...upcomingShown],
    omittedFlown: flown.length - flownShown.length,
    omittedUpcoming: upcoming.length - upcomingShown.length,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-10-23T07:11:00Z` → `2026-10-23 07:11:00 UTC`. */
export function formatUtc(iso: string): string {
  const ms = timeMs(iso);
  if (ms == null) return "—";
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

const PACIFIC_TZ = "America/Los_Angeles";

/** `2026-11-07T00:48:42Z` → `Fri Nov 6, 4:48:42 pm PST`. */
export function formatPacific(iso: string): string {
  const ms = timeMs(iso);
  if (ms == null) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h12",
    timeZoneName: "short",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const dayPeriod = get("dayPeriod").replace(/\./g, "").toLowerCase();
  return `${get("weekday")} ${get("month")} ${get("day")}, ${get("hour")}:${get("minute")}:${get("second")} ${dayPeriod} ${get("timeZoneName")}`;
}

export function parseLaunchTimeKind(value: unknown): LaunchTimeKind | null {
  const raw = asString(value);
  if (!raw) return null;
  const kind = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (kind === "net" || kind === "no_earlier_than") return "net";
  if (kind === "target" || kind === "targeted") return "target";
  if (kind === "window_open" || kind === "window") return "window_open";
  return null;
}

export function launchTimeKindLabel(kind: LaunchTimeKind | null): string {
  if (kind === "net") return "NET";
  if (kind === "target") return "Target";
  if (kind === "window_open") return "Window opens";
  return "T-0";
}

/** Whole seconds of a span. Days appear only once the span reaches 24h. */
export function formatCountdownSpan(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const hms = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

export interface CivilInstant {
  utc: string;
  pacific: string;
}

export interface LaunchClock {
  mode: "countdown" | "elapsed" | "tbd" | "absolute";
  label: string;
  readout: string;
  utc: string;
  pacific: string;
  windowOpen: CivilInstant | null;
  windowClose: CivilInstant | null;
  notice: string | null;
  /** True when the readout must advance every second. */
  ticking: boolean;
}

type ClockStatus = "success" | "tbd" | "slip" | "hold" | "closed" | "open";

function clockStatus(status: string): ClockStatus {
  const s = status.trim().toLowerCase();
  if (s === "success" || s === "successful") return "success";
  if (s === "tbd" || s === "tba") return "tbd";
  if (s === "slip" || s === "slipped" || s === "scrub" || s === "scrubbed") return "slip";
  if (s === "hold") return "hold";
  if (s === "failure" || s === "failed" || s === "abort" || s === "aborted") return "closed";
  return "open";
}

function civilInstant(iso: string | null): CivilInstant | null {
  if (!iso || timeMs(iso) == null) return null;
  return { utc: formatUtc(iso), pacific: formatPacific(iso) };
}

/** A window instant that is the same moment as T-0 is already the countdown label. */
function distinctInstant(iso: string | null, t0Utc: string): CivilInstant | null {
  const instant = civilInstant(iso);
  if (!instant) return null;
  const ms = timeMs(iso ?? "");
  const t0 = timeMs(t0Utc);
  if (ms != null && t0 != null && ms === t0) return null;
  return instant;
}

function liveNotice(mode: "countdown" | "elapsed", status: ClockStatus): string | null {
  if (mode === "countdown") {
    if (status === "slip") return "Slipped. Counting the current published instant.";
    if (status === "hold") return "Hold. Counting the current published instant.";
    if (status === "closed") return "Not a confirmed liftoff. Counting the current published instant.";
    return null;
  }
  if (status === "slip") return "T-0 passed. Slipped, not marked flown.";
  if (status === "hold") return "T-0 passed. Hold, not marked flown.";
  return "T-0 passed. Not marked flown.";
}

/**
 * Clock for one launch. `t0_utc` is the only countdown target.
 * Success and flown rows stay absolute times: a passed T-0 on an upcoming
 * row counts up and says so, without calling the flight flown.
 */
export function launchClock(launch: LaunchEntry, nowMs: number): LaunchClock {
  const utc = formatUtc(launch.t0Utc);
  const pacific = formatPacific(launch.t0Utc);
  const status = clockStatus(launch.status);
  const ms = timeMs(launch.t0Utc);

  if (launch.phase === "flown" || launch.phase === "recent" || status === "success") {
    return {
      mode: "absolute",
      label: "T-0",
      readout: utc,
      utc,
      pacific,
      windowOpen: null,
      windowClose: null,
      notice: null,
      ticking: false,
    };
  }

  if (status === "tbd" || ms == null) {
    return {
      mode: "tbd",
      label: "TBD",
      readout: "TBD",
      utc,
      pacific,
      windowOpen: null,
      windowClose: null,
      notice: ms == null
        ? "No authoritative T-0 in the manifest."
        : "Published instant is not a fixed liftoff.",
      ticking: false,
    };
  }

  const delta = ms - nowMs;
  const mode = delta >= 0 ? "countdown" : "elapsed";
  const seconds = delta > 0 ? Math.ceil(delta / 1000) : delta === 0 ? 0 : Math.floor(-delta / 1000);
  return {
    mode,
    label: launchTimeKindLabel(launch.t0Kind),
    readout: `${mode === "countdown" ? "T-" : "T+"} ${formatCountdownSpan(seconds)}`,
    utc,
    pacific,
    windowOpen: distinctInstant(launch.windowOpenUtc, launch.t0Utc),
    windowClose: distinctInstant(launch.windowCloseUtc, launch.t0Utc),
    notice: liveNotice(mode, status),
    ticking: true,
  };
}

/** Whether an upcoming row needs a one-second timer. Independent of the current instant. */
export function launchClockIsLive(launch: LaunchEntry): boolean {
  return launchClock(launch, 0).ticking;
}

/** Vite's SPA fallback answers a missing static file with index.html and HTTP 200. */
export function looksLikeHtml(text: string, contentType: string | null): boolean {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml")) return true;
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

export async function loadLaunchIndex(
  fetchImpl: typeof fetch = fetch,
  url: string = launchIndexUrl(),
): Promise<LaunchIndexResult> {
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return { ok: false, reason: "unavailable" };
    const text = await response.text();
    if (!text.trim()) return { ok: true, manifest: emptyManifest() };
    try {
      return parseLaunchIndex(JSON.parse(text) as unknown);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function loadMethodsMarkdown(
  fetchImpl: typeof fetch,
  url: string,
): Promise<string | null> {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    if (looksLikeHtml(text, response.headers.get("content-type"))) return null;
    return text;
  } catch {
    return null;
  }
}

/** Load the manifest, then the methods note when that file is actually present. */
export async function loadLaunchDesk(
  fetchImpl: typeof fetch = fetch,
): Promise<LaunchIndexResult> {
  const index = await loadLaunchIndex(fetchImpl);
  if (!index.ok) return index;
  const docUrl = publicAssetHref(index.manifest.methodsDoc) ?? defaultMethodsDocUrl();
  const markdown = await loadMethodsMarkdown(fetchImpl, docUrl);
  if (!markdown) return index;
  return { ok: true, manifest: { ...index.manifest, methodsMarkdown: markdown } };
}
