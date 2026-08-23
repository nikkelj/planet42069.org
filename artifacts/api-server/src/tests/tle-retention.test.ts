/**
 * Tests for TLE archive retention bounds (src/lib/obc/tleArchive.ts):
 *  - sampleRows keeps 6h resolution inside the recent window and coarsens
 *    to one elset per object per UTC day beyond COARSE_AFTER_DAYS
 *  - latest-wins within a bin, per object
 *  - backfillHorizonMs matches the configured BACKFILL_HORIZON_DAYS
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import {
  sampleRows, backfillHorizonMs, BACKFILL_HORIZON_DAYS, COARSE_AFTER_DAYS, ELSET_FUTURE_SLACK_MS,
} from "../lib/obc/tleArchive";
import type { InsertObcTleHistory } from "@workspace/db/schema";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function row(norad: number, epochMs: number): InsertObcTleHistory {
  return {
    norad,
    epoch: new Date(epochMs),
    line1: "1", line2: "2",
    incDeg: 53, raanDeg: 100, eccentricity: 0.0001,
    argPerigeeDeg: 0, meanAnomalyDeg: 0, meanMotionRevPerDay: 15.5,
    bstar: null, source: "backfill",
  };
}

const NOW = Date.parse("2026-08-02T00:00:00Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;

console.log("Recent window keeps 6h bins");
{
  // 4 elsets across one recent UTC day, one per 6h bin → all 4 kept
  const base = NOW - 2 * DAY;
  const rows = [0, 6, 12, 18].map((h) => row(1, base + h * HOUR));
  const out = sampleRows(rows, NOW);
  check("one row per 6h bin survives in the recent window", out.length === 4, `got ${out.length}`);

  // two elsets in the same 6h bin → latest wins
  const dup = sampleRows([row(1, base + HOUR), row(1, base + 2 * HOUR)], NOW);
  check("latest wins within a 6h bin", dup.length === 1 && new Date(dup[0].epoch as Date).getTime() === base + 2 * HOUR);
}

console.log("Old data coarsens to one per object per day");
{
  const base = NOW - (COARSE_AFTER_DAYS + 10) * DAY;
  const rows = [0, 6, 12, 18].map((h) => row(1, base + h * HOUR));
  const out = sampleRows(rows, NOW);
  check(`beyond ${COARSE_AFTER_DAYS}d, 4 same-day elsets collapse to 1`, out.length === 1, `got ${out.length}`);
  check("the newest of the day is kept", new Date(out[0].epoch as Date).getTime() === base + 18 * HOUR);

  // different objects are never merged
  const multi = sampleRows([row(1, base), row(2, base)], NOW);
  check("coarse bins are per-object", multi.length === 2);

  // rows straddling the coarse boundary use their own bin sizes
  const straddle = sampleRows(
    [row(3, NOW - (COARSE_AFTER_DAYS + 1) * DAY), row(3, NOW - (COARSE_AFTER_DAYS - 1) * DAY)],
    NOW,
  );
  check("boundary straddle keeps both sides", straddle.length === 2);
}

console.log("Backfill horizon");
{
  check("horizon = now − configured days", backfillHorizonMs(NOW) === NOW - BACKFILL_HORIZON_DAYS * DAY);
  check("horizon days configured and positive", Number.isFinite(BACKFILL_HORIZON_DAYS) && BACKFILL_HORIZON_DAYS > 0);
}

console.log("RPOD latest-elset epoch window");
{
  check("future slack is 6 hours", ELSET_FUTURE_SLACK_MS === 6 * HOUR);
  // space-track multi-day objects publish epochs days ahead (live newestEpoch
  // 2026-08-27 while now is 2026-08-23). Those must sit outside untilMs so
  // DISTINCT ON (norad) ORDER BY epoch DESC cannot hide a current TLE.
  const now = Date.parse("2026-08-23T15:00:00Z");
  const until = now + ELSET_FUTURE_SLACK_MS;
  const newestEpoch = Date.parse("2026-08-27T11:19:49.514Z");
  check("live newestEpoch is after the scan until bound", newestEpoch > until);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll TLE retention checks passed");
