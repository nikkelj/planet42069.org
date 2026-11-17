import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchEntry } from "./launch";
import type { SatcatEntry } from "./satcat";

/**
 * Sourced provisional payload masses for launches GCAT has not yet given a
 * payload mass. Checked in as data/provisional-manifest.json plus one calc
 * markdown per entry. A row retires (drops out of every total) once the
 * catalog lists object-class P mass for that launch.
 *
 * The Falcon-median estimator stays Falcon-only. A manifest row and that
 * estimator never both count the same launch.
 */

export type SiteClass = "capeCanaveral" | "vandenberg" | "starbase" | "other";

export type MassBasis = "published" | "estimated";
export type InputKind = "published" | "derived" | "editorial";

export interface CalcInput {
  name: string;
  value: string;
  kind: InputKind;
  source: string;
}

export interface ManifestCalc {
  title: string;
  formula: string;
  inputs: CalcInput[];
  resultKg: number;
  rangeKg: [number, number];
  markdownPath: string;
}

export interface ManifestMatch {
  ldate: string;
  lvFamilyIncludes: string;
  launchTag?: string | null;
  payloadNameIncludes?: string | null;
  siteHints?: string[];
}

export interface ManifestEntry {
  id: string;
  launchDate: string;
  launchDateTimeUtc: string;
  vehicle: string;
  lvFamilyIncludes: string;
  site: string;
  siteClass: SiteClass;
  payloadName: string;
  payloadCount: number;
  perSatMassKg: number;
  perSatLowKg: number;
  perSatHighKg: number;
  massKg: number;
  massLowKg: number;
  massHighKg: number;
  basis: MassBasis;
  sourceUrls: string[];
  note: string;
  calc: ManifestCalc;
  match: ManifestMatch;
}

export interface ProvisionalEntry extends ManifestEntry {
  retired: boolean;
  cataloguedMassKg: number;
  /** Full calc markdown, so the site can publish the write-up with the numbers. */
  markdown: string;
}

export interface ProvisionalManifest {
  calculatedOn: string;
  timezone: string;
  entries: ProvisionalEntry[];
  /** Booked kg still in the totals (retired rows contribute 0). */
  activeMassKg: number;
  note: string;
}

export interface PendingLaunch {
  ldate: string;
  siteClass: SiteClass;
  estMassKg: number;
}

const PENDING_WINDOW_DAYS = 45;
const FALLBACK_KG = 14000; // typical current Starlink batch, Falcon only
const SITE_CLASSES: readonly SiteClass[] = ["capeCanaveral", "vandenberg", "starbase", "other"];
const BASES: readonly MassBasis[] = ["published", "estimated"];
const KINDS: readonly InputKind[] = ["published", "derived", "editorial"];

const RETIRE_NOTE =
  "Entries are replaced automatically once GCAT lists a payload mass for the launch (object class P, mass > 0). Retired rows stay on this manifest with retired=true and are excluded from every total. Starship is never given the Falcon-median estimate.";

export function classifySite(site: string | null): SiteClass {
  const s = (site ?? "").toUpperCase();
  if (s === "CC" || s.startsWith("KSC")) return "capeCanaveral";
  if (s.startsWith("VSFB") || s.startsWith("VAFB")) return "vandenberg";
  // GCAT codes Boca Chica / Starbase as "BC". Keep it out of "other".
  if (
    s === "BC" ||
    s.startsWith("BC ") ||
    s.startsWith("BC-") ||
    s.startsWith("BC/") ||
    s.includes("STARBASE") ||
    s.includes("BOCA")
  ) {
    return "starbase";
  }
  return "other";
}

function dataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../data"), // src/lib -> api-server/data (tsx, tests)
    join(here, "../data"),
    join(here, "data"), // bundled dist/index.mjs -> dist/data
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "provisional-manifest.json"))) return dir;
  }
  throw new Error(
    `provisional-manifest.json not found (looked in ${candidates.join(", ")})`,
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function needString(obj: Record<string, unknown>, key: string, id: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`provisional manifest ${id}: ${key} must be a non-empty string`);
  }
  return v;
}

function needNumber(obj: Record<string, unknown>, key: string, id: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`provisional manifest ${id}: ${key} must be a finite number`);
  }
  return v;
}

function parseEntry(raw: unknown, index: number): ManifestEntry {
  if (!isRecord(raw)) throw new Error(`provisional manifest entry ${index} is not an object`);
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : `#${index}`;
  const basis = needString(raw, "basis", id);
  if (!BASES.includes(basis as MassBasis)) {
    throw new Error(`provisional manifest ${id}: basis must be published or estimated`);
  }
  const siteClass = needString(raw, "siteClass", id);
  if (!SITE_CLASSES.includes(siteClass as SiteClass)) {
    throw new Error(`provisional manifest ${id}: unknown siteClass ${siteClass}`);
  }
  if (!Array.isArray(raw.sourceUrls) || raw.sourceUrls.some((u) => typeof u !== "string" || !u.trim())) {
    throw new Error(`provisional manifest ${id}: sourceUrls must be a non-empty string array`);
  }
  if (!isRecord(raw.calc)) throw new Error(`provisional manifest ${id}: calc missing`);
  if (!Array.isArray(raw.calc.inputs) || raw.calc.inputs.length === 0) {
    throw new Error(`provisional manifest ${id}: calc.inputs missing`);
  }
  const inputs: CalcInput[] = raw.calc.inputs.map((item, i) => {
    if (!isRecord(item)) throw new Error(`provisional manifest ${id}: input ${i} is not an object`);
    const kind = needString(item, "kind", id);
    if (!KINDS.includes(kind as InputKind)) {
      throw new Error(`provisional manifest ${id}: input ${i} kind must be published, derived, or editorial`);
    }
    return {
      name: needString(item, "name", id),
      value: needString(item, "value", id),
      kind: kind as InputKind,
      source: needString(item, "source", id),
    };
  });
  const range = raw.calc.rangeKg;
  if (!Array.isArray(range) || range.length !== 2 || range.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new Error(`provisional manifest ${id}: calc.rangeKg must be [low, high]`);
  }
  if (!isRecord(raw.match)) throw new Error(`provisional manifest ${id}: match missing`);
  const launchTag = raw.match.launchTag;
  if (launchTag != null && typeof launchTag !== "string") {
    throw new Error(`provisional manifest ${id}: match.launchTag must be a string`);
  }
  const payloadNameIncludes = raw.match.payloadNameIncludes;
  if (payloadNameIncludes != null && typeof payloadNameIncludes !== "string") {
    throw new Error(`provisional manifest ${id}: match.payloadNameIncludes must be a string`);
  }
  const siteHints = raw.match.siteHints;
  if (siteHints != null && (!Array.isArray(siteHints) || siteHints.some((h) => typeof h !== "string"))) {
    throw new Error(`provisional manifest ${id}: match.siteHints must be a string array`);
  }
  return {
    id: needString(raw, "id", id),
    launchDate: needString(raw, "launchDate", id),
    launchDateTimeUtc: needString(raw, "launchDateTimeUtc", id),
    vehicle: needString(raw, "vehicle", id),
    lvFamilyIncludes: needString(raw, "lvFamilyIncludes", id),
    site: needString(raw, "site", id),
    siteClass: siteClass as SiteClass,
    payloadName: needString(raw, "payloadName", id),
    payloadCount: needNumber(raw, "payloadCount", id),
    perSatMassKg: needNumber(raw, "perSatMassKg", id),
    perSatLowKg: needNumber(raw, "perSatLowKg", id),
    perSatHighKg: needNumber(raw, "perSatHighKg", id),
    massKg: needNumber(raw, "massKg", id),
    massLowKg: needNumber(raw, "massLowKg", id),
    massHighKg: needNumber(raw, "massHighKg", id),
    basis: basis as MassBasis,
    sourceUrls: raw.sourceUrls as string[],
    note: needString(raw, "note", id),
    calc: {
      title: needString(raw.calc, "title", id),
      formula: needString(raw.calc, "formula", id),
      inputs,
      resultKg: needNumber(raw.calc, "resultKg", id),
      rangeKg: [range[0] as number, range[1] as number],
      markdownPath: needString(raw.calc, "markdownPath", id),
    },
    match: {
      ldate: needString(raw.match, "ldate", id),
      lvFamilyIncludes: needString(raw.match, "lvFamilyIncludes", id),
      launchTag: launchTag ?? null,
      payloadNameIncludes: payloadNameIncludes ?? null,
      siteHints: siteHints ?? [],
    },
  };
}

export function loadManifestEntries(): { calculatedOn: string; timezone: string; entries: ManifestEntry[] } {
  const dir = dataDir();
  const raw = JSON.parse(readFileSync(join(dir, "provisional-manifest.json"), "utf8")) as unknown;
  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    throw new Error("provisional-manifest.json must be an object with an entries array");
  }
  return {
    calculatedOn: typeof raw.calculatedOn === "string" ? raw.calculatedOn : "",
    timezone: typeof raw.timezone === "string" ? raw.timezone : "",
    entries: raw.entries.map((e, i) => parseEntry(e, i)),
  };
}

function readCalcMarkdown(markdownPath: string): string {
  const abs = join(dataDir(), markdownPath);
  if (!existsSync(abs)) throw new Error(`provisional calc markdown missing: ${markdownPath}`);
  return readFileSync(abs, "utf8");
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function siteHintsMatch(site: string | null, hints: string[] | undefined): boolean {
  if (!hints || hints.length === 0) return false;
  const s = (site ?? "").trim().toUpperCase();
  if (!s) return false;
  return hints.some((h) => {
    const hint = h.trim().toUpperCase();
    if (!hint) return false;
    // Short site codes must match as a token, not as a substring of another code.
    if (hint.length <= 3) {
      return s === hint || s.startsWith(`${hint} `) || s.startsWith(`${hint}-`) || s.startsWith(`${hint}/`);
    }
    return s.includes(hint);
  });
}

function familyMatches(lvFamily: string | null | undefined, lv: string | null | undefined, needle: string): boolean {
  const fam = `${norm(lvFamily)} ${norm(lv)}`;
  const want = norm(needle);
  return want.length > 0 && fam.includes(want);
}

/**
 * A catalog object belongs to this manifest launch.
 * launchTag, when present, is the whole match (plus object class P).
 * Otherwise require ldate AND vehicle AND a site hint — never the date alone.
 */
export function objectMatchesManifest(e: SatcatEntry, match: ManifestMatch): boolean {
  if (e.objectClass !== "P") return false;
  const tag = norm(match.launchTag);
  if (tag) return norm(e.launchTag) === tag;
  if (!e.ldate || e.ldate !== match.ldate) return false;
  if (!familyMatches(e.lvFamily, e.lv, match.lvFamilyIncludes)) return false;
  if (!siteHintsMatch(e.site, match.siteHints)) return false;
  const nameNeedle = norm(match.payloadNameIncludes);
  if (nameNeedle) {
    const name = `${norm(e.name)} ${norm(e.plName)}`;
    if (!name.includes(nameNeedle)) return false;
  }
  return true;
}

/** Same identity rule, against the launch registry rather than a catalog object. */
export function launchMatchesManifest(l: LaunchEntry, match: ManifestMatch): boolean {
  const tag = norm(match.launchTag);
  if (tag) return norm(l.launchTag) === tag;
  if (!l.ldate || l.ldate !== match.ldate) return false;
  if (!familyMatches(l.lvFamily, l.lv, match.lvFamilyIncludes)) return false;
  return siteHintsMatch(l.site, match.siteHints);
}

export function launchCoveredByManifest(l: LaunchEntry, entries: ManifestEntry[]): boolean {
  return entries.some((e) => launchMatchesManifest(l, e.match));
}

export function cataloguedPayloadMassKg(data: SatcatEntry[], entry: ManifestEntry): number {
  let sum = 0;
  for (const e of data) {
    if (!objectMatchesManifest(e, entry.match)) continue;
    sum += e.massKg ?? 0;
  }
  return sum;
}

export function annotateManifest(data: SatcatEntry[], entries: ManifestEntry[]): ProvisionalEntry[] {
  return entries.map((entry) => {
    const cataloguedMassKg = cataloguedPayloadMassKg(data, entry);
    return {
      ...entry,
      cataloguedMassKg,
      retired: cataloguedMassKg > 0,
      markdown: "",
    };
  });
}

/**
 * Load the checked-in manifest and retire any entry whose launch already has
 * catalogued payload mass. Retired entries stay in `entries` (retired: true)
 * and are omitted from `activeMassKg`.
 */
export function getProvisionalManifest(data: SatcatEntry[]): ProvisionalManifest {
  const file = loadManifestEntries();
  const entries = annotateManifest(data, file.entries).map((entry) => ({
    ...entry,
    markdown: readCalcMarkdown(entry.calc.markdownPath),
  }));
  const activeMassKg = entries.reduce((s, e) => s + (e.retired ? 0 : e.massKg), 0);
  return {
    calculatedOn: file.calculatedOn,
    timezone: file.timezone,
    entries,
    activeMassKg,
    note: RETIRE_NOTE,
  };
}

export function activeProvisional(manifest: ProvisionalManifest): ProvisionalEntry[] {
  return manifest.entries.filter((e) => !e.retired);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Falcon orbital launches inside the lag window with zero catalogued Falcon
 * payload mass. Starship is never estimated here. A launch that appears in
 * the provisional manifest is skipped so the two series cannot both count it.
 */
export function selectPendingFalcon(
  data: SatcatEntry[],
  launches: Iterable<LaunchEntry>,
  now: number,
  manifestEntries: ManifestEntry[],
): PendingLaunch[] {
  const launchList = [...launches];
  const launchByTag = new Map(launchList.map((l) => [l.launchTag, l]));
  const windowStart = now - PENDING_WINDOW_DAYS * 24 * 3600 * 1000;

  const tagMass = new Map<string, number>();
  const dateSiteMass = new Map<string, number>();
  for (const e of data) {
    if (e.objectClass !== "P" || !e.ldate) continue;
    if (!(e.lvFamily ?? "").toLowerCase().includes("falcon")) continue;
    const mass = e.massKg ?? 0;
    if (e.launchTag) {
      tagMass.set(e.launchTag, (tagMass.get(e.launchTag) ?? 0) + mass);
    } else {
      const key = `${e.ldate}|${classifySite(e.site)}`;
      dateSiteMass.set(key, (dateSiteMass.get(key) ?? 0) + mass);
    }
  }

  const perClass: Record<SiteClass, number[]> = {
    capeCanaveral: [],
    vandenberg: [],
    starbase: [],
    other: [],
  };
  const all: number[] = [];
  for (const [tag, mass] of tagMass) {
    if (mass <= 0) continue;
    const l = launchByTag.get(tag);
    if (!l?.ldate) continue;
    const t = Date.parse(l.ldate);
    if (Number.isFinite(t) && now - t <= 365 * 24 * 3600 * 1000) {
      const cls = classifySite(l.site);
      perClass[cls].push(mass);
      all.push(mass);
    }
  }
  const estFor = (cls: SiteClass): number => median(perClass[cls]) ?? median(all) ?? FALLBACK_KG;

  const pending: PendingLaunch[] = [];
  for (const l of launchList) {
    // Falcon only. A Falcon-median figure for Starship cargo is the wrong vehicle.
    if (!l.orbital || !l.ldate || !(l.lvFamily ?? "").toLowerCase().includes("falcon")) continue;
    const t = Date.parse(l.ldate);
    if (!Number.isFinite(t) || t < windowStart || t > now) continue;
    const cls = classifySite(l.site);
    if ((tagMass.get(l.launchTag) ?? 0) > 0) continue;
    if ((dateSiteMass.get(`${l.ldate}|${cls}`) ?? 0) > 0) continue;
    if (launchCoveredByManifest(l, manifestEntries)) continue;
    pending.push({ ldate: l.ldate, siteClass: cls, estMassKg: estFor(cls) });
  }
  return pending;
}
