import assert from "node:assert/strict";
import { nextRecentWatermarkMs } from "../lib/obc/tleArchive";

const NOW = Date.parse("2026-10-12T21:00:00Z");
const since = Date.parse("2026-10-12T20:00:00Z");
const FIVE = 5 * 60_000;

// Cursor follows publish time (CREATION_DATE), minus a 5 min overlap.
assert.equal(
  nextRecentWatermarkMs(since, ["2026-10-12T20:10:00", "2026-10-12T20:41:13"], NOW),
  Date.parse("2026-10-12T20:41:13Z") - FIVE,
);
// Empty response or unparseable dates never move the cursor backward.
assert.equal(nextRecentWatermarkMs(since, [], NOW), since);
assert.equal(nextRecentWatermarkMs(since, [null, "garbage"], NOW), since);
// A future CREATION_DATE (clock skew) clamps to now.
assert.equal(nextRecentWatermarkMs(since, ["2026-10-16T11:26:09"], NOW), NOW - FIVE);
// Regression (2026-10-06): the cursor must not depend on EPOCH at all. A
// future-dated EPOCH used to pin the cursor to now − 5 min forever, and every
// later elset (epoch hours before publish) was skipped. Only CREATION_DATE counts.
const published = "2026-10-12T20:30:00";
assert.equal(nextRecentWatermarkMs(since, [published], NOW), Date.parse(published + "Z") - FIVE);

console.log("tle-recent-watermark: ok");
