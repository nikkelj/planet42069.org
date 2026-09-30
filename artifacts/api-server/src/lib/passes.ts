import * as satellite from "satellite.js";
import type { TleData } from "./tle";
import { interpolateState, type EphemSample } from "./obc/starlinkEphem";

/**
 * Pass prediction over an observer location.
 *
 * A "pass" is a contiguous window where the satellite is above the horizon.
 * `visible` is true when, at some point during the pass, the satellite is
 * above 10° elevation, sunlit (outside Earth's shadow), and the observer's
 * sky is dark (Sun below -6° civil twilight).
 *
 * Positions come from SGP4 (a TLE) or from a SpaceX public ephemeris.
 */

export interface SatPass {
  startTime: string;
  maxTime: string;
  endTime: string;
  maxElevationDeg: number;
  startAzDeg: number;
  maxAzDeg: number;
  endAzDeg: number;
  visible: boolean;
}

const DEG = Math.PI / 180;
const EARTH_R_KM = 6371;
const STEP_MS = 30_000; // coarse scan step
const AU_KM = 149_597_870.7;

/** Low-precision solar position in ECI (km), good to ~0.01 AU direction. */
function sunEci(date: Date): { x: number; y: number; z: number } {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;
  const L = (280.46 + 36000.771 * t) % 360;
  const M = ((357.5291 + 35999.0503 * t) % 360) * DEG;
  const lambda = (L + 1.914666 * Math.sin(M) + 0.019994 * Math.sin(2 * M)) * DEG;
  const eps = (23.43929 - 0.0130042 * t) * DEG;
  const r = (1.000140612 - 0.016708617 * Math.cos(M) - 0.000139589 * Math.cos(2 * M)) * AU_KM;
  return {
    x: r * Math.cos(lambda),
    y: r * Math.sin(lambda) * Math.cos(eps),
    z: r * Math.sin(lambda) * Math.sin(eps),
  };
}

function inEarthShadow(sat: { x: number; y: number; z: number }, sun: { x: number; y: number; z: number }): boolean {
  const sunMag = Math.hypot(sun.x, sun.y, sun.z);
  const ux = sun.x / sunMag, uy = sun.y / sunMag, uz = sun.z / sunMag;
  const dot = sat.x * ux + sat.y * uy + sat.z * uz;
  if (dot >= 0) return false;
  const perp = Math.hypot(sat.x - dot * ux, sat.y - dot * uy, sat.z - dot * uz);
  return perp < EARTH_R_KM;
}

function sunElevationDeg(
  date: Date,
  observerGd: { latitude: number; longitude: number; height: number },
): number {
  const sun = sunEci(date);
  const gmst = satellite.gstime(date);
  const sunEcf = satellite.eciToEcf({ x: sun.x, y: sun.y, z: sun.z }, gmst);
  const look = satellite.ecfToLookAngles(observerGd, sunEcf);
  return look.elevation / DEG;
}

type Sample = { t: number; elev: number; az: number; visible: boolean };
type SampleFn = (t: number, needVisibility: boolean) => Sample | null;

function lookSample(
  t: number,
  needVisibility: boolean,
  eci: { x: number; y: number; z: number } | null | false,
  observerGd: { latitude: number; longitude: number; height: number },
): Sample | null {
  if (!eci) return null;
  const date = new Date(t);
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf(eci, gmst);
  const look = satellite.ecfToLookAngles(observerGd, ecf);
  const elev = look.elevation / DEG;
  let visible = false;
  if (needVisibility && elev > 10) {
    const sun = sunEci(date);
    visible = !inEarthShadow(eci, sun) && sunElevationDeg(date, observerGd) < -6;
  }
  return { t, elev, az: ((look.azimuth / DEG) % 360 + 360) % 360, visible };
}

function collectPasses(sample: SampleFn, start: Date, days: number): SatPass[] {
  const endMs = start.getTime() + days * 86400_000;
  const passes: SatPass[] = [];

  const refineCrossing = (belowT: number, aboveT: number): Sample | null => {
    let lo = belowT;
    let hi = aboveT;
    let best: Sample | null = null;
    while (Math.abs(hi - lo) > 1000) {
      const mid = (lo + hi) / 2;
      const s = sample(mid, false);
      if (!s) return best;
      if (s.elev > 0) {
        hi = mid;
        best = s;
      } else {
        lo = mid;
      }
    }
    const t = Math.round(((lo + hi) / 2) / 1000) * 1000;
    return sample(t, false) ?? best;
  };

  const refinePeak = (coarseMax: Sample): Sample => {
    let best = coarseMax;
    const from = Math.round((coarseMax.t - STEP_MS) / 1000) * 1000;
    const to = coarseMax.t + STEP_MS;
    for (let t = from; t <= to; t += 1000) {
      const s = sample(t, false);
      if (s && s.elev > best.elev) best = s;
    }
    return best;
  };

  let inPass = false;
  let startSample: Sample | null = null;
  let maxSample: Sample | null = null;
  let prevSample: Sample | null = null;
  let anyVisible = false;

  for (let t = start.getTime(); t <= endMs; t += STEP_MS) {
    const s = sample(t, inPass);
    if (!s) break;
    if (!inPass && s.elev > 0) {
      inPass = true;
      startSample =
        prevSample && prevSample.elev <= 0
          ? refineCrossing(prevSample.t, s.t) ?? s
          : s;
      maxSample = s;
      anyVisible = s.visible;
    } else if (inPass) {
      if (s.elev > (maxSample?.elev ?? -90)) maxSample = s;
      if (s.visible) anyVisible = true;
      if (s.elev <= 0) {
        if (startSample && maxSample && maxSample.elev > 0) {
          const endSample =
            prevSample && prevSample.elev > 0
              ? refineCrossing(s.t, prevSample.t) ?? s
              : s;
          const peak = refinePeak(maxSample);
          passes.push({
            startTime: new Date(startSample.t).toISOString(),
            maxTime: new Date(peak.t).toISOString(),
            endTime: new Date(endSample.t).toISOString(),
            maxElevationDeg: Math.round(peak.elev * 10) / 10,
            startAzDeg: Math.round(startSample.az),
            maxAzDeg: Math.round(peak.az),
            endAzDeg: Math.round(endSample.az),
            visible: anyVisible,
          });
        }
        inPass = false;
        startSample = null;
        maxSample = null;
        anyVisible = false;
        if (passes.length >= 50) break;
      }
    }
    prevSample = s;
  }

  return passes;
}

export function predictPasses(
  tle: TleData,
  latDeg: number,
  lonDeg: number,
  days: number,
  start = new Date(),
): SatPass[] {
  const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
  const observerGd = {
    latitude: latDeg * DEG,
    longitude: lonDeg * DEG,
    height: 0,
  };
  const sample: SampleFn = (t, needVisibility) => {
    const pv = satellite.propagate(satrec, new Date(t));
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;
    return lookSample(t, needVisibility, pv.position, observerGd);
  };
  return collectPasses(sample, start, days);
}

/**
 * Passes from one SpaceX ephemeris. The scan is clipped to the file span
 * so we never invent a position past the last state vector.
 */
export function predictPassesFromEphemeris(
  samples: EphemSample[],
  latDeg: number,
  lonDeg: number,
  days: number,
  start = new Date(),
): SatPass[] {
  if (samples.length < 2) return [];
  const observerGd = {
    latitude: latDeg * DEG,
    longitude: lonDeg * DEG,
    height: 0,
  };
  const spanStart = samples[0].t;
  const spanStop = samples[samples.length - 1].t;
  const from = new Date(Math.max(start.getTime(), spanStart));
  const windowEnd = start.getTime() + days * 86400_000;
  const coveredMs = Math.min(windowEnd, spanStop) - from.getTime();
  if (coveredMs <= 0) return [];
  const coveredDays = coveredMs / 86400_000;
  const sample: SampleFn = (t, needVisibility) => {
    const eci = interpolateState(samples, t);
    return lookSample(t, needVisibility, eci, observerGd);
  };
  return collectPasses(sample, from, coveredDays);
}
