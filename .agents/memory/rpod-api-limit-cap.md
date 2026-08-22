---
name: RPOD API limit cap and test pagination
description: The /rpod/events route caps the limit parameter; tests using small limits fail when the dev DB accumulates too many events.
---

# RPOD API limit cap and test pagination

The `GET /api/rpod/events` route caps the `limit` query param (raised from 200 → 1000 in August 2026). Tests that check whether a seeded event "appears in the unfiltered list" must request a limit large enough to cover all events in the dev DB.

**Why:** The dev DB accumulates real RPOD events over time. Tests seed events with historical TCAs (e.g. Aug 1 2026). Default TCA-desc sort puts those events near the tail. When the DB exceeds the limit cap, seeded events fall off the page — the test sees an empty or partial list and falsely reports the seeded event missing, while kind-filtered queries (which have fewer results) still find it.

**How to apply:** Any test that does an "unfiltered" fetch and then checks that seeded events are present should request `?limit=1000` (or a suitably large number). Tests that compare filtered subsets (kind=, status=, reopened=) are fine at smaller limits because they pull fewer rows. If new pagination tests appear and start failing intermittently, check whether the dev DB has grown past the limit cap.

Files involved:
- `artifacts/api-server/src/routes/rpod.ts` — cap is `Math.min(1000, ...)` on line ~44
- `artifacts/api-server/src/tests/rpod-api.test.ts` — unfiltered fetch uses `?limit=1000`
- `artifacts/api-server/src/tests/rpod-reopened-filter.test.ts` — unfiltered fetch uses `?limit=1000`
