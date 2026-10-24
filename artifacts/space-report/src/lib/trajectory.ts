/**
 * Ascent trajectory CSVs published under /launches/{slug}/.
 * Comment lines start with #. Columns used here: elapsed_s, utc_iso,
 * lat_deg, lon_deg, altitude_km, and the ECEF position when present.
 */

import { looksLikeHtml } from "@/lib/launches";

/** WGS-84 equatorial radius. Scene units are this many kilometres. */
export const EARTH_RADIUS_KM = 6378.137;

export const TRACK_COLORS = {
  surrogate: "#ffb020",
  sim: "#3dfff5",
} as const;

export type TrackId = keyof typeof TRACK_COLORS;

export interface TrajectorySample {
  elapsedS: number;
  utcIso: string;
  latDeg: number;
  lonDeg: number;
  altitudeKm: number;
  xEcefKm: number;
  yEcefKm: number;
  zEcefKm: number;
}

export interface LonLatBox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

function wrapLon(lon: number): number {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function sphericalEcef(latDeg: number, lonDeg: number, altitudeKm: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const r = EARTH_RADIUS_KM + altitudeKm;
  const cl = Math.cos(lat);
  return [r * cl * Math.cos(lon), r * cl * Math.sin(lon), r * Math.sin(lat)];
}

/** Parse a trajectory CSV. HTML (the SPA fallback) and headerless text are rejected. */
export function parseTrajectoryCsv(text: string): TrajectorySample[] | null {
  if (!text.trim() || looksLikeHtml(text, null)) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length < 2) return null;

  const header = lines[0]!.split(",").map((cell) => cell.trim());
  const col = (name: string) => header.indexOf(name);
  const iLat = col("lat_deg");
  const iLon = col("lon_deg");
  const iAlt = col("altitude_km");
  if (iLat < 0 || iLon < 0 || iAlt < 0) return null;
  const iElapsed = col("elapsed_s");
  const iUtc = col("utc_iso");
  const iX = col("x_ecef_km");
  const iY = col("y_ecef_km");
  const iZ = col("z_ecef_km");

  const samples: TrajectorySample[] = [];
  for (let row = 1; row < lines.length; row++) {
    const cells = lines[row]!.split(",");
    const lat = Number(cells[iLat]);
    const lon = Number(cells[iLon]);
    const alt = Number(cells[iAlt]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) continue;
    if (Math.abs(lat) > 90) continue;
    const elapsed = iElapsed >= 0 ? Number(cells[iElapsed]) : (row - 1) * 5;
    const x = iX >= 0 ? Number(cells[iX]) : NaN;
    const y = iY >= 0 ? Number(cells[iY]) : NaN;
    const z = iZ >= 0 ? Number(cells[iZ]) : NaN;
    const ecef = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
      ? [x, y, z] as [number, number, number]
      : sphericalEcef(lat, wrapLon(lon), alt);
    samples.push({
      elapsedS: Number.isFinite(elapsed) ? elapsed : (row - 1) * 5,
      utcIso: iUtc >= 0 ? (cells[iUtc] ?? "").trim() : "",
      latDeg: lat,
      lonDeg: wrapLon(lon),
      altitudeKm: alt,
      xEcefKm: ecef[0],
      yEcefKm: ecef[1],
      zEcefKm: ecef[2],
    });
  }
  return samples.length >= 2 ? samples : null;
}

export async function loadTrajectoryCsv(
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<TrajectorySample[] | null> {
  try {
    const response = await fetchImpl(url, { signal, headers: { Accept: "text/csv, text/plain, */*" } });
    if (!response.ok) return null;
    const text = await response.text();
    if (looksLikeHtml(text, response.headers.get("content-type"))) return null;
    return parseTrajectoryCsv(text);
  } catch {
    return null;
  }
}

/** Break the ground track where it crosses the antimeridian. */
export function splitAtDateline(samples: TrajectorySample[]): TrajectorySample[][] {
  const segments: TrajectorySample[][] = [];
  let current: TrajectorySample[] = [];
  for (const sample of samples) {
    const prev = current[current.length - 1];
    if (prev && Math.abs(sample.lonDeg - prev.lonDeg) > 180) {
      if (current.length) segments.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length) segments.push(current);
  return segments;
}

/** Equirectangular window around the track. A dateline crossing keeps the whole world. */
export function groundTrackBox(samples: TrajectorySample[]): LonLatBox {
  const crosses = samples.some((sample, i) => {
    const prev = samples[i - 1];
    return prev != null && Math.abs(sample.lonDeg - prev.lonDeg) > 180;
  });
  if (crosses || samples.length === 0) {
    return { minLon: -180, maxLon: 180, minLat: -90, maxLat: 90 };
  }
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const sample of samples) {
    minLon = Math.min(minLon, sample.lonDeg);
    maxLon = Math.max(maxLon, sample.lonDeg);
    minLat = Math.min(minLat, sample.latDeg);
    maxLat = Math.max(maxLat, sample.latDeg);
  }
  const spanLon = Math.max(12, maxLon - minLon);
  const spanLat = Math.max(12, maxLat - minLat);
  const padLon = Math.max(4, spanLon * 0.2);
  const padLat = Math.max(4, spanLat * 0.25);
  return {
    minLon: Math.max(-180, minLon - padLon),
    maxLon: Math.min(180, maxLon + padLon),
    minLat: Math.max(-90, minLat - padLat),
    maxLat: Math.min(90, maxLat + padLat),
  };
}

/** Linear sample at an elapsed time. Clamps to the ends of the track. */
export function sampleAt(samples: TrajectorySample[], elapsedS: number): TrajectorySample | null {
  if (samples.length === 0) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (elapsedS <= first.elapsedS) return first;
  if (elapsedS >= last.elapsedS) return last;
  let hi = 1;
  while (hi < samples.length && samples[hi]!.elapsedS < elapsedS) hi += 1;
  const b = samples[hi] ?? last;
  const a = samples[hi - 1] ?? first;
  const span = b.elapsedS - a.elapsedS;
  const t = span > 0 ? (elapsedS - a.elapsedS) / span : 0;
  const lerp = (p: number, q: number) => p + (q - p) * t;
  let lonA = a.lonDeg;
  let lonB = b.lonDeg;
  if (lonB - lonA > 180) lonA += 360;
  if (lonA - lonB > 180) lonB += 360;
  return {
    elapsedS,
    utcIso: t < 0.5 ? a.utcIso : b.utcIso,
    latDeg: lerp(a.latDeg, b.latDeg),
    lonDeg: wrapLon(lerp(lonA, lonB)),
    altitudeKm: lerp(a.altitudeKm, b.altitudeKm),
    xEcefKm: lerp(a.xEcefKm, b.xEcefKm),
    yEcefKm: lerp(a.yEcefKm, b.yEcefKm),
    zEcefKm: lerp(a.zEcefKm, b.zEcefKm),
  };
}

export function maxElapsed(tracks: TrajectorySample[][]): number {
  let max = 0;
  for (const samples of tracks) {
    const last = samples[samples.length - 1];
    if (last) max = Math.max(max, last.elapsedS);
  }
  return max;
}

export function maxAltitude(tracks: TrajectorySample[][]): number {
  let max = 1;
  for (const samples of tracks) {
    for (const sample of samples) max = Math.max(max, sample.altitudeKm);
  }
  return max;
}
