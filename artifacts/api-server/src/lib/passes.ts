import * as satellite from "satellite.js";
import type { TleData } from "./tle";

/**
 * SGP4 pass prediction over an observer location.
 *
 * A "pass" is a contiguous window where the satellite is above the horizon.
 * `visible` is true when, at some point during the pass, the satellite is
 * above 10° elevation, sunlit (outside Earth's shadow), and the observer's
 * sky is dark (Sun below -6° civil twilight).
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
  // Julian centuries from J2000
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;
  const L = (280.46 + 36000.771 * t) % 360; // mean longitude, deg
  const M = ((357.5291 + 35999.0503 * t) % 360) * DEG; // mean anomaly
  const lambda = (L + 1.914666 * Math.sin(M) + 0.019994 * Math.sin(2 * M)) * DEG; // ecliptic lon
  const eps = (23.43929 - 0.0130042 * t) * DEG; // obliquity
  const r = (1.000140612 - 0.016708617 * Math.cos(M) - 0.000139589 * Math.cos(2 * M)) * AU_KM;
  return {
    x: r * Math.cos(lambda),
    y: r * Math.sin(lambda) * Math.cos(eps),
    z: r * Math.sin(lambda) * Math.sin(eps),
  };
}

/** Is the satellite (ECI position, km) inside Earth's cylindrical shadow? */
function inEarthShadow(sat: { x: number; y: number; z: number }, sun: { x: number; y: number; z: number }): boolean {
  const sunMag = Math.hypot(sun.x, sun.y, sun.z);
  const ux = sun.x / sunMag, uy = sun.y / sunMag, uz = sun.z / sunMag;
  const dot = sat.x * ux + sat.y * uy + sat.z * uz;
  if (dot >= 0) return false; // on the sunlit side
  const perp = Math.hypot(sat.x - dot * ux, sat.y - dot * uy, sat.z - dot * uz);
  return perp < EARTH_R_KM;
}

/** Sun elevation at the observer, degrees. */
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

  const endMs = start.getTime() + days * 86400_000;
  const passes: SatPass[] = [];

  type Sample = { t: number; elev: number; az: number; visible: boolean };
  const sample = (t: number, needVisibility: boolean): Sample | null => {
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;
    const gmst = satellite.gstime(date);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const look = satellite.ecfToLookAngles(observerGd, ecf);
    const elev = look.elevation / DEG;
    let visible = false;
    if (needVisibility && elev > 10) {
      const sun = sunEci(date);
      visible = !inEarthShadow(pv.position, sun) && sunElevationDeg(date, observerGd) < -6;
    }
    return { t, elev, az: ((look.azimuth / DEG) % 360 + 360) % 360, visible };
  };

  let inPass = false;
  let startSample: Sample | null = null;
  let maxSample: Sample | null = null;
  let prevSample: Sample | null = null;
  let anyVisible = false;

  for (let t = start.getTime(); t <= endMs; t += STEP_MS) {
    const s = sample(t, inPass);
    if (!s) {
      // propagation failed (decayed / bad elset) — bail out with what we have
      break;
    }
    if (!inPass && s.elev > 0) {
      inPass = true;
      startSample = prevSample && prevSample.elev <= 0 ? prevSample : s;
      // refine start with the first above-horizon sample
      startSample = s;
      maxSample = s;
      anyVisible = s.visible;
    } else if (inPass) {
      if (s.elev > (maxSample?.elev ?? -90)) maxSample = s;
      if (s.visible) anyVisible = true;
      if (s.elev <= 0) {
        if (startSample && maxSample && maxSample.elev > 0) {
          passes.push({
            startTime: new Date(startSample.t).toISOString(),
            maxTime: new Date(maxSample.t).toISOString(),
            endTime: new Date(s.t).toISOString(),
            maxElevationDeg: Math.round(maxSample.elev * 10) / 10,
            startAzDeg: Math.round(startSample.az),
            maxAzDeg: Math.round(maxSample.az),
            endAzDeg: Math.round(s.az),
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
