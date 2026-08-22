/**
 * Satellite scanner: given observer location + time, identify which catalogued
 * satellites were near a specified sky region.
 *
 * Usage:
 *   pnpm exec tsx src/scripts/sat-scan.ts
 */

import { pool } from "@workspace/db";
import * as satellite from "satellite.js";

// ── Observation parameters ──────────────────────────────────────────────────
const OBS_TIME = new Date("2026-08-15T02:59:33Z");

// Port Stanley, Ontario  (42.6734°N, 81.2089°W, ~183 m)
const OBS_LAT_DEG = 42.6734;
const OBS_LON_DEG = -81.2089;
const OBS_ALT_M = 183;

// Estimated sky position of the object (Draco / Cygnus-Lyra junction).
// From constellation overlay: object is near Draco head, RA~17h30m, Dec~+55°.
// At Port Stanley at 02:59:33 UTC, LST ≈ 18h03m → object ≈ Az 335°, El 77°.
// We search a cone around this point.
const TARGET_AZ_DEG = 335;
const TARGET_EL_DEG = 77;
const SEARCH_RADIUS_DEG = 15; // ±15° cone for top candidates

// ── Helpers ─────────────────────────────────────────────────────────────────
const DEG = Math.PI / 180;

function toRad(d: number) { return d * DEG; }
function toDeg(r: number) { return r / DEG; }

/** Great-circle angular separation between two az/el points (degrees). */
function angularSep(az1: number, el1: number, az2: number, el2: number): number {
  const a1 = toRad(el1), a2 = toRad(el2);
  const daz = toRad(az2 - az1);
  const cos = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(daz);
  return toDeg(Math.acos(Math.max(-1, Math.min(1, cos))));
}

/** Gaussian-style match score: 1.0 at 0° sep, falls off with sigma = radius/2 */
function matchScore(sepDeg: number, radiusDeg: number): number {
  const sigma = radiusDeg / 2;
  return Math.exp(-(sepDeg * sepDeg) / (2 * sigma * sigma));
}

/** Format az/el nicely */
function fmtAzEl(az: number, el: number) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  const dir = dirs[Math.round(az / 22.5) % 16];
  return `Az ${az.toFixed(1)}° (${dir}), El ${el.toFixed(1)}°`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== SATELLITE SCANNER ===");
  console.log(`Observer : Port Stanley, ON  (${OBS_LAT_DEG}°N, ${Math.abs(OBS_LON_DEG)}°W, ${OBS_ALT_M}m)`);
  console.log(`Time     : ${OBS_TIME.toISOString()}`);
  console.log(`Target   : Az ${TARGET_AZ_DEG}°, El ${TARGET_EL_DEG}° (Draco region, from constellation overlay)`);
  console.log(`Search   : ±${SEARCH_RADIUS_DEG}° cone around target\n`);

  // Query best TLE per object within ±2 days of observation
  const client = await pool.connect();
  let rows: Array<{norad: number; line1: string; line2: string; epoch: Date; age_hours: number; name: string | null; sat_state: string | null; intl_des: string | null}>;
  try {
    const res = await client.query(`
      WITH ranked AS (
        SELECT 
          h.norad, h.line1, h.line2, h.epoch,
          ABS(EXTRACT(EPOCH FROM (h.epoch - $1::timestamptz)) / 3600) AS age_hours,
          ROW_NUMBER() OVER (
            PARTITION BY h.norad
            ORDER BY ABS(EXTRACT(EPOCH FROM (h.epoch - $1::timestamptz))) ASC
          ) AS rn
        FROM obc_tle_history h
        WHERE h.epoch BETWEEN $1::timestamptz - INTERVAL '3 days'
                           AND $1::timestamptz + INTERVAL '3 days'
      )
      SELECT 
        r.norad, r.line1, r.line2,
        r.epoch, r.age_hours,
        o.name, o.sat_state, o.intl_des
      FROM ranked r
      LEFT JOIN obc_objects o ON o.norad = r.norad
      WHERE r.rn = 1
        AND r.age_hours < 72
    `, [OBS_TIME]);
    rows = res.rows;
  } finally {
    client.release();
  }

  console.log(`TLEs loaded: ${rows.length} objects (±72h epoch window)`);

  // Observer geodetic position for satellite.js
  const obsGd = {
    latitude:  toRad(OBS_LAT_DEG),
    longitude: toRad(OBS_LON_DEG),
    height:    OBS_ALT_M / 1000, // km
  };

  const results: Array<{
    norad: number; name: string | null; intlDes: string | null; satState: string | null;
    az: number; el: number; rangekm: number; sepDeg: number; score: number;
    ageHours: number; epoch: string;
  }> = [];

  let propagationErrors = 0;

  for (const row of rows) {
    try {
      const satrec = satellite.twoline2satrec(row.line1, row.line2);
      if (satrec.error !== 0) continue;

      const pv = satellite.propagate(satrec, OBS_TIME);
      if (!pv || !pv.position || typeof pv.position === "boolean") continue;

      const gmst = satellite.gstime(OBS_TIME);
      const ecf  = satellite.eciToEcf(pv.position as satellite.EciVec3<number>, gmst);
      const lookAngles = satellite.ecfToLookAngles(obsGd, ecf);

      const azDeg = toDeg(lookAngles.azimuth);
      const elDeg = toDeg(lookAngles.elevation);
      const rangekm = lookAngles.rangeSat;

      if (elDeg < 5) continue; // below horizon or barely visible

      const sepDeg = angularSep(TARGET_AZ_DEG, TARGET_EL_DEG, azDeg, elDeg);
      const score = matchScore(sepDeg, SEARCH_RADIUS_DEG);

      results.push({
        norad: row.norad,
        name: row.name ?? null,
        intlDes: row.intl_des ?? null,
        satState: row.sat_state ?? null,
        az: azDeg, el: elDeg,
        rangekm,
        sepDeg,
        score,
        ageHours: parseFloat(String(row.age_hours)),
        epoch: row.epoch.toISOString(),
      });
    } catch {
      propagationErrors++;
    }
  }

  // Sort by angular separation (closest first)
  results.sort((a, b) => a.sepDeg - b.sepDeg);

  console.log(`\nObjects above horizon: ${results.length}`);
  console.log(`Propagation errors:    ${propagationErrors}\n`);

  // ── Report top candidates ───────────────────────────────────────────────
  const TOP_N = 20;
  const near = results.slice(0, TOP_N);

  console.log(`=== TOP ${TOP_N} CANDIDATES (by angular separation from target) ===\n`);

  // Identify Falcon 9 second stages / rocket bodies
  const f9Markers = ["falcon", "f9", "starlink", "spacex", "sx", "1998-067", "2026-"];
  const isF9Related = (r: typeof results[0]) => {
    const haystack = [r.name ?? "", r.intlDes ?? ""].join(" ").toLowerCase();
    return f9Markers.some(m => haystack.includes(m));
  };

  let rank = 1;
  for (const r of near) {
    const f9flag = isF9Related(r) ? " 🚀[F9/SL related]" : "";
    const stateStr = r.satState ? ` [${r.satState}]` : "";
    const pct = (r.score * 100).toFixed(0);
    console.log(`#${rank++}  NORAD ${r.norad}${stateStr}${f9flag}`);
    console.log(`    Name   : ${r.name ?? "(unknown)"}`);
    console.log(`    IntlDes: ${r.intlDes ?? "—"}   TLE age: ${r.ageHours.toFixed(1)}h`);
    console.log(`    Position: ${fmtAzEl(r.az, r.el)}   Range: ${(r.rangekm).toFixed(0)} km`);
    console.log(`    Sep from target: ${r.sepDeg.toFixed(2)}°   Match score: ${pct}%`);
    console.log();
  }

  // ── Falcon 9 second stages in ALL visible objects ─────────────────────
  const allF9 = results.filter(isF9Related);
  if (allF9.length > 0) {
    console.log(`\n=== ALL F9/STARLINK/SPACEX OBJECTS VISIBLE (${allF9.length} total) ===\n`);
    for (const r of allF9.slice(0, 30)) {
      console.log(`  NORAD ${r.norad}  ${(r.name ?? "").padEnd(40)} ${fmtAzEl(r.az, r.el).padEnd(45)} Sep: ${r.sepDeg.toFixed(1)}°`);
    }
  }

  // ── Best overall match assessment ────────────────────────────────────
  console.log("\n=== ASSESSMENT ===\n");
  const best = results[0];
  if (best) {
    const pct = (best.score * 100).toFixed(0);
    const confidence = best.sepDeg < 5 ? "HIGH" : best.sepDeg < 10 ? "MEDIUM" : best.sepDeg < 20 ? "LOW" : "VERY LOW";
    console.log(`Best match: NORAD ${best.norad} (${best.name ?? "unknown"})`);
    console.log(`  IntlDes : ${best.intlDes ?? "—"}`);
    console.log(`  Position: ${fmtAzEl(best.az, best.el)}`);
    console.log(`  Sep     : ${best.sepDeg.toFixed(2)}° from estimated target`);
    console.log(`  Score   : ${pct}%  (confidence: ${confidence})`);
  }

  // Note about the spiral
  console.log("\nNOTE: The expanding spiral/cloud in the image is the signature");
  console.log("of a Falcon 9 second-stage propellant dump/deorbit burn venting.");
  console.log("This pattern is created when the spent stage vents residual LOX/RP-1");
  console.log("propellants, which freeze and scatter sunlight from below the horizon.");
  console.log("COSPAR international designator '2026-XXX-B' = second stage (rocket body).");

  await pool.end();
}

main().catch((err) => {
  console.error("Scanner failed:", err);
  process.exit(1);
});
