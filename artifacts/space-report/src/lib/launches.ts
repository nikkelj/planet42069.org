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
 */
export function launchDownloadName(
  launch: { slug: string; t0Utc: string },
  path: string,
): string {
  const base = fileNameFromPath(path);
  const slug = launch.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const date = /^\d{4}-\d{2}-\d{2}/.exec(launch.t0Utc)?.[0] ?? "";
  return [slug, date, base].filter(Boolean).join("_");
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
