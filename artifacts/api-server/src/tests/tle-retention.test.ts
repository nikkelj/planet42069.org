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
  estimatePgCount, estimatePgDistinct, asFiniteNumber,
  utcDayStartMs, newestCoarseDayStartMs, coerceCoarsePruneCursor, advanceCoarsePruneCursor,
  coarseDayThinSql, sqlTemplateText,
} from "../lib/obc/tleArchive";
import { pickNewestElsets, latestElsetBackfillNeedsWork } from "../lib/obc/latestElset";
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
  // MAX(epoch) in the scan window cannot hide a current TLE.
  const now = Date.parse("2026-08-23T15:00:00Z");
  const until = now + ELSET_FUTURE_SLACK_MS;
  const newestEpoch = Date.parse("2026-08-27T11:19:49.514Z");
  check("live newestEpoch is after the scan until bound", newestEpoch > until);
  // Archive status still reports the raw max(epoch). A future newestEpoch is
  // NOT evidence that getLatestElsets dropped its cap — status and scan use
  // different queries.
  check("archive newestEpoch is allowed to be in the future", newestEpoch > now);
}

console.log("Coarse prune walks one UTC day, not the whole horizon");
{
  const coarseBefore = NOW - COARSE_AFTER_DAYS * DAY;
  const horizon = NOW - BACKFILL_HORIZON_DAYS * DAY;
  const leading = newestCoarseDayStartMs(coarseBefore);
  check("leading coarse day is the UTC day before the boundary", leading === utcDayStartMs(coarseBefore - 1));
  check("exact midnight boundary belongs to the previous day",
    newestCoarseDayStartMs(Date.parse("2026-09-16T00:00:00Z")) === Date.parse("2026-09-15T00:00:00Z"));
  const cursor = coerceCoarsePruneCursor(null, horizon, coarseBefore);
  check("missing cursor starts the day behind the leading edge", cursor === leading - DAY);
  check("cursor sitting on the leading edge is pushed behind it",
    coerceCoarsePruneCursor(leading, horizon, coarseBefore) === leading - DAY);
  check("a full budget keeps the backlog on the same day",
    advanceCoarsePruneCursor(cursor, 20_000, 20_000, horizon, coarseBefore) === cursor);
  check("a finished day steps one UTC day backward",
    advanceCoarsePruneCursor(cursor, 0, 20_000, horizon, coarseBefore) === cursor - DAY);
  const floor = utcDayStartMs(horizon);
  check("walking off the horizon wraps behind the leading edge",
    advanceCoarsePruneCursor(floor, 0, 20_000, horizon, coarseBefore) === leading - DAY);
  const thin = sqlTemplateText(coarseDayThinSql(
    new Date(cursor), new Date(cursor + DAY), new Date(horizon), new Date(coarseBefore), 20_000,
  ));
  check("thin SQL bounds the delete to one day", /epoch\s*>=/.test(thin) && /epoch\s*</.test(thin), thin.slice(0, 300));
  check("thin SQL still keeps the newest epoch per norad",
    /row_number\(\)/i.test(thin) && /order by epoch desc, id desc/i.test(thin), thin.slice(0, 400));
  check("thin SQL does not partition the whole coarse span in one window",
    !/date_trunc\(\s*'day'/i.test(thin), thin.slice(0, 200));
}

console.log("Latest-elset pointer keeps the newest epoch per norad");
{
  const older = row(7, NOW - DAY);
  const newer = row(7, NOW);
  const other = row(8, NOW - 2 * DAY);
  const picked = pickNewestElsets([older, other, newer]);
  check("one row per norad", picked.length === 2);
  const kept = picked.find((r) => r.norad === 7);
  check("later epoch wins", kept != null && new Date(kept.epoch as Date).getTime() === NOW);
  check("backfill is unfinished until done", latestElsetBackfillNeedsWork(null, null) === true);
  check("backfill is unfinished while the catalog merge is unseen",
    latestElsetBackfillNeedsWork(
      { cursor: 10, done: true, catalogSeen: null, sweepCursor: -1, sweepFor: null },
      "2026-10-16T00:00:00.000Z",
    ));
  check("backfill is finished once the seen merge matches",
    latestElsetBackfillNeedsWork(
      { cursor: 10, done: true, catalogSeen: "2026-10-16T00:00:00.000Z", sweepCursor: -1, sweepFor: null },
      "2026-10-16T00:00:00.000Z",
    ) === false);
}

console.log("Archive status count estimates (must not seq-scan 5M rows)");
{
  check("asFiniteNumber accepts pg bigint-as-string", asFiniteNumber("5149357") === 5149357);
  check("asFiniteNumber rejects garbage", asFiniteNumber("nope") === null);
  check("reltuples -1 (never ANALYZE) → 0, not a seq-scan fallback", estimatePgCount(-1) === 0);
  check("reltuples 5.1M rounds", estimatePgCount(5149357.4) === 5149357);
  // pg_stats: negative n_distinct is −(fraction distinct)
  check("n_distinct −0.0064 of 5.1M ≈ 33k objects",
    estimatePgDistinct(-0.0064, 5149357) > 30_000 && estimatePgDistinct(-0.0064, 5149357) < 40_000,
    String(estimatePgDistinct(-0.0064, 5149357)));
  check("n_distinct 32928 is used as-is", estimatePgDistinct(32928, 5149357) === 32928);
  check("missing n_distinct → 0 objects rather than count(distinct)", estimatePgDistinct(null, 5149357) === 0);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll TLE retention checks passed");
