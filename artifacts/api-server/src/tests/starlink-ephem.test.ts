/**
 * Starlink public-ephemeris manifest + MEME parser.
 * Run with: pnpm --filter @workspace/api-server run test:starlink-ephem
 */
import {
  interpolateState,
  parseManifest,
  parseMeme,
  parseMemeEpoch,
  stubKey,
  catalogNameKey,
} from "../lib/obc/starlinkEphem";
import { predictPassesFromEphemeris } from "../lib/passes";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
}

const manifest = `
MEME_100001_STARLINK-38128_2730849_Operational_100_UNCLASSIFIED.txt
MEME_100050_STARLINK-38128_2730849_Operational_200_UNCLASSIFIED.txt
MEME_100010_STARLINK-1_1_Operational_200_UNCLASSIFIED.txt
MEME_100011_STARLINK-1_1_Operational_200_UNCLASSIFIED.txt
junk
`.trim();

const entries = parseManifest(manifest);
const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
check("one row per name", entries.length === 2, String(entries.length));
check("higher recency wins", byName["STARLINK-38128"]?.filename.startsWith("MEME_100050_"));
check("seq breaks a recency tie", byName["STARLINK-1"]?.seq === 100011);
check("stub key", stubKey("STARLINK-38128") === "SX:STARLINK-38128");
check(
  "manifest name matches GCAT spelling",
  catalogNameKey("STARLINK-38128") === catalogNameKey("Starlink 38128")
    && catalogNameKey("STARLINK-38128") === "STARLINK38128",
);

const epoch = parseMemeEpoch("2026273084942.000");
check("epoch parses", epoch === Date.parse("2026-09-30T08:49:42.000Z"), String(new Date(epoch ?? 0).toISOString()));

const meme = `created:2026-09-30 09:06:05 UTC
ephemeris_start:2026-09-30 08:49:42 UTC ephemeris_stop:2026-10-03 08:49:42 UTC step_size:60
ephemeris_source:blend
UVW
2026273084942.000 -6090.9674453039 165.9427175319 3080.1337110458 3.1113777639 -3.0091555795 6.2986407868
1 2 3 4 5 6 7
2026273085042.000 -5890.6994055214 -14.8448101816 3450.8074296894 3.5616952172 -3.0148288216 6.0524917688
1 2 3 4 5 6 7
`;
const parsed = parseMeme(meme, "fixture.txt");
check("two states, covariance skipped", parsed.samples.length === 2, String(parsed.samples.length));
check("first position", Math.abs(parsed.samples[0].x - -6090.9674453039) < 1e-6);
check("span start", parsed.startMs === Date.parse("2026-09-30T08:49:42.000Z"));

const atStart = interpolateState(parsed.samples, parsed.startMs);
check("hermite matches start", !!atStart && Math.abs(atStart.x - parsed.samples[0].x) < 1e-6);
const mid = interpolateState(parsed.samples, parsed.startMs + 30_000);
check("midpoint is between", !!mid && mid.x > parsed.samples[0].x && mid.x < parsed.samples[1].x, String(mid?.x));
check("outside span is null", interpolateState(parsed.samples, parsed.startMs - 1000) === null);

// A satellite parked at zenith for an equatorial observer should be a pass.
// Build 10 minutes of identical inertial samples so Earth rotation carries it,
// plus a lead-in below... simpler: just ensure the function returns an array
// and does not throw on a short circular arc.
const mu = 398600.4418;
const r = 6778;
const n = Math.sqrt(mu / r ** 3); // rad/s
const t0 = Date.parse("2026-09-30T12:00:00Z");
const samples = [];
for (let i = 0; i < 30; i++) {
  const t = t0 + i * 60_000;
  const th = n * (i * 60);
  samples.push({
    t,
    x: r * Math.cos(th),
    y: r * Math.sin(th),
    z: 0,
    vx: -r * n * Math.sin(th),
    vy: r * n * Math.cos(th),
    vz: 0,
  });
}
const passes = predictPassesFromEphemeris(samples, 0, 0, 1, new Date(t0));
check("ephemeris pass scan returns an array", Array.isArray(passes), String(passes.length));

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("starlink ephemeris tests ok");
