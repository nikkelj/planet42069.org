import { db } from "@workspace/db";
import { obcObjects, obcStarlinkEphem, obcSyncLog } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { invalidateStore } from "./store";

export const STARLINK_MANIFEST_URL =
  "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
export const STARLINK_EPHEM_BASE =
  "https://api.starlink.com/public-files/ephemerides/";

const MANIFEST_LINE =
  /^MEME_(\d+)_([A-Za-z0-9.-]+)_(\d+)_Operational_(\d+)_UNCLASSIFIED\.txt$/;

/** Epoch token YY.. is actually YYYY + DOY + HHMMSS.sss (13+ digits before the dot). */
const EPOCH_TOKEN = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/;

export interface ManifestEntry {
  name: string;
  filename: string;
  seq: number;
  recency: number;
}

export interface EphemSample {
  t: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface ParsedEphemeris {
  filename: string;
  samples: EphemSample[];
  startMs: number;
  stopMs: number;
}

export function stubKey(name: string): string {
  return `SX:${name}`;
}

/** One row per satellite name. Higher recency wins; seq breaks ties. */
export function parseManifest(text: string): ManifestEntry[] {
  const best = new Map<string, ManifestEntry>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = MANIFEST_LINE.exec(line);
    if (!m) continue;
    const entry: ManifestEntry = {
      seq: Number(m[1]),
      name: m[2],
      filename: line,
      recency: Number(m[4]),
    };
    if (!Number.isFinite(entry.seq) || !Number.isFinite(entry.recency) || !entry.name) continue;
    const prev = best.get(entry.name);
    if (
      !prev ||
      entry.recency > prev.recency ||
      (entry.recency === prev.recency && entry.seq > prev.seq)
    ) {
      best.set(entry.name, entry);
    }
  }
  return [...best.values()];
}

export function parseMemeEpoch(token: string): number | null {
  const m = EPOCH_TOKEN.exec(token);
  if (!m) return null;
  const year = Number(m[1]);
  const doy = Number(m[2]);
  const hh = Number(m[3]);
  const mm = Number(m[4]);
  const ss = Number(m[5]);
  if (doy < 1 || doy > 366 || hh > 23 || mm > 59 || ss >= 60) return null;
  const ms = Date.UTC(year, 0, 1, hh, mm, 0, 0) + (doy - 1) * 86400000 + Math.round((ss % 1) * 1000) + Math.floor(ss) * 1000;
  return ms;
}

function parseFloats(line: string): number[] | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) return null;
  const nums = parts.slice(0, 6).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

/**
 * SpaceX MEME text. State vectors are geocentric inertial km and km/s
 * (inclination is stable without an Earth-rate correction). The UVW
 * header labels the covariance frame; those rows are skipped.
 */
export function parseMeme(text: string, filename = ""): ParsedEphemeris {
  const lines = text.split(/\r?\n/);
  const samples: EphemSample[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    const t = parseMemeEpoch(parts[0] ?? "");
    if (t == null) continue;
    // Published files put epoch and state on one line. A split layout is accepted too.
    let nums: number[] | null = null;
    if (parts.length >= 7) {
      nums = parts.slice(1, 7).map(Number);
      if (nums.some((n) => !Number.isFinite(n))) nums = null;
    }
    if (!nums) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j >= lines.length) break;
      nums = parseFloats(lines[j]);
    }
    if (!nums) continue;
    samples.push({ t, x: nums[0], y: nums[1], z: nums[2], vx: nums[3], vy: nums[4], vz: nums[5] });
  }
  if (samples.length < 2) {
    throw new Error("ephemeris has fewer than two state vectors");
  }
  return {
    filename,
    samples,
    startMs: samples[0].t,
    stopMs: samples[samples.length - 1].t,
  };
}

/** Cubic Hermite interpolation. Returns null outside the file span. */
export function interpolateState(samples: EphemSample[], t: number): { x: number; y: number; z: number } | null {
  if (t < samples[0].t || t > samples[samples.length - 1].t) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const dt = b.t - a.t;
  if (dt <= 0) return { x: a.x, y: a.y, z: a.z };
  const u = (t - a.t) / dt;
  const h = dt / 1000; // seconds, so velocity in km/s scales
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return {
    x: h00 * a.x + h10 * h * a.vx + h01 * b.x + h11 * h * b.vx,
    y: h00 * a.y + h10 * h * a.vy + h01 * b.y + h11 * h * b.vy,
    z: h00 * a.z + h10 * h * a.vz + h01 * b.z + h11 * h * b.vz,
  };
}

const CHUNK = 400;

async function logSync(status: "success" | "error", startedAt: Date, rowCount: number | null, error?: string) {
  try {
    await db.insert(obcSyncLog).values({
      source: "starlink-ephem",
      status,
      rowCount,
      error: error ? error.slice(0, 2000) : null,
      startedAt,
    });
  } catch (err) {
    logger.error({ err }, "starlink-ephem: failed to write sync log");
  }
}

let inFlight: Promise<{ indexed: number; stubs: number }> | null = null;

/**
 * Pull the manifest only. Index the newest file per satellite and insert
 * catalog stubs for names the Bureau does not have yet. File bodies are
 * not downloaded here.
 */
export function syncStarlinkManifest(): Promise<{ indexed: number; stubs: number }> {
  if (inFlight) return inFlight;
  inFlight = doSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSync(): Promise<{ indexed: number; stubs: number }> {
  const startedAt = new Date();
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS obc_starlink_ephem (
        name text PRIMARY KEY,
        filename text NOT NULL,
        seq integer NOT NULL,
        recency integer NOT NULL,
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    const res = await fetch(STARLINK_MANIFEST_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const entries = parseManifest(await res.text());
    if (entries.length === 0) throw new Error("manifest parsed empty");

    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      await db
        .insert(obcStarlinkEphem)
        .values(chunk.map((e) => ({ name: e.name, filename: e.filename, seq: e.seq, recency: e.recency })))
        .onConflictDoUpdate({
          target: obcStarlinkEphem.name,
          set: {
            filename: sql`case when excluded.recency > ${obcStarlinkEphem.recency} or (excluded.recency = ${obcStarlinkEphem.recency} and excluded.seq >= ${obcStarlinkEphem.seq}) then excluded.filename else ${obcStarlinkEphem.filename} end`,
            seq: sql`case when excluded.recency > ${obcStarlinkEphem.recency} or (excluded.recency = ${obcStarlinkEphem.recency} and excluded.seq >= ${obcStarlinkEphem.seq}) then excluded.seq else ${obcStarlinkEphem.seq} end`,
            recency: sql`case when excluded.recency > ${obcStarlinkEphem.recency} then excluded.recency else ${obcStarlinkEphem.recency} end`,
            updatedAt: sql`now()`,
          },
        });
    }

    // A real catalog row (GCAT or space-track) supersedes the stub.
    await db.execute(sql`
      DELETE FROM obc_objects a
      WHERE a.key LIKE 'SX:%'
        AND EXISTS (
          SELECT 1 FROM obc_objects b
          WHERE b.key <> a.key AND upper(b.name) = upper(a.name)
        )
    `);

    const inserted = await db.execute(sql`
      INSERT INTO obc_objects (
        key, name, owner, state, object_class, obj_type, op_orbit, sat_state,
        in_gcat, in_spacetrack, mass_estimated, updated_at
      )
      SELECT
        'SX:' || e.name, e.name, 'SpaceX', 'US', 'P', 'PAY', 'LEO', 'O',
        false, false, false, now()
      FROM obc_starlink_ephem e
      WHERE NOT EXISTS (
        SELECT 1 FROM obc_objects o WHERE upper(o.name) = upper(e.name)
      )
    `);

    const stubs = inserted.rowCount ?? 0;
    invalidateStore();
    await logSync("success", startedAt, entries.length);
    logger.info({ indexed: entries.length, stubs }, "starlink-ephem: manifest indexed");
    return { indexed: entries.length, stubs };
  } catch (err) {
    await logSync("error", startedAt, null, String(err));
    logger.error({ err: String(err) }, "starlink-ephem: manifest sync failed");
    throw err;
  }
}

const fileCache = new Map<string, { at: number; parsed: ParsedEphemeris }>();
const CACHE_MS = 15 * 60_000;

export async function filenameForName(name: string): Promise<string | null> {
  const rows = await db
    .select({ filename: obcStarlinkEphem.filename })
    .from(obcStarlinkEphem)
    .where(sql`upper(${obcStarlinkEphem.name}) = upper(${name})`)
    .limit(1);
  return rows[0]?.filename ?? null;
}

export async function catalogNameForNorad(norad: number): Promise<string | null> {
  const rows = await db
    .select({ name: obcObjects.name })
    .from(obcObjects)
    .where(sql`${obcObjects.norad} = ${norad}`)
    .limit(1);
  return rows[0]?.name ?? null;
}

export async function loadEphemerisForName(name: string): Promise<ParsedEphemeris | null> {
  const filename = await filenameForName(name);
  if (!filename) return null;
  const hit = fileCache.get(filename);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.parsed;
  const url = STARLINK_EPHEM_BASE + encodeURIComponent(filename);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`ephemeris HTTP ${res.status} for ${filename}`);
  const parsed = parseMeme(await res.text(), filename);
  fileCache.set(filename, { at: Date.now(), parsed });
  return parsed;
}
