/**
 * API contract test for the "REOPENED ONLY" repeat-offender filter on
 * GET /api/rpod/events (reopened=true → reopen_count > 0).
 *
 * Guards against the filter mixing first-time cases in with repeat
 * offenders (or hiding genuine repeat offenders):
 *  - reopened=true returns only events with reopenCount > 0
 *  - omitting the param returns all events (first-time + reopened)
 *  - reopened=true combines correctly with status and kind filters
 *  - pagination totals stay consistent under the filter
 *
 * Seeds temporary rows into the dev database (NORADs in the 99998xxx test
 * range) and always cleans up after itself. Starts the real express app on
 * an ephemeral port and exercises it over HTTP.
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { db, pool } from "@workspace/db";
import { rpodEvents, rpodEventMembers } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import type { Server } from "node:http";
import app from "../app";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TEST_NORADS = [99998001, 99998002];
// A third NORAD attached only to some events, so q=<norad> selects a subset.
const EXTRA_NORAD = 99998003;
// A search string that can't match any catalog name or NORAD.
const NO_MATCH_Q = "zz-no-such-satellite-name-zz";

interface EventRow {
  id: number;
  kind: string;
  status: string;
  reopenCount: number;
  [k: string]: unknown;
}

interface SeedSpec {
  status: "active" | "stale" | "ended";
  kind: "conjunction" | "coplanar" | "docked";
  reopenCount: number;
  extraMember?: boolean; // also gets EXTRA_NORAD as a member
}

// Mix of first-time (reopenCount 0) and repeat-offender (reopenCount > 0)
// events across statuses and kinds so combined filters are exercised.
const SPECS: SeedSpec[] = [
  { status: "active", kind: "conjunction", reopenCount: 0 },
  { status: "active", kind: "conjunction", reopenCount: 1, extraMember: true },
  { status: "active", kind: "coplanar", reopenCount: 0 },
  { status: "active", kind: "coplanar", reopenCount: 3 },
  { status: "ended", kind: "conjunction", reopenCount: 0, extraMember: true },
  { status: "ended", kind: "conjunction", reopenCount: 2 },
  { status: "ended", kind: "coplanar", reopenCount: 1 },
  { status: "stale", kind: "docked", reopenCount: 0 },
];

async function seed(): Promise<Map<number, SeedSpec>> {
  const now = new Date("2026-08-01T00:00:00Z");
  const later = new Date("2026-08-01T06:00:00Z");
  const byId = new Map<number, SeedSpec>();
  for (const spec of SPECS) {
    const [row] = await db.insert(rpodEvents).values({
      status: spec.status, kind: spec.kind,
      windowStart: now, windowEnd: later, tca: now,
      minRangeKm: 10, relVelKmS: 0.05, memberCount: 2,
      reopenCount: spec.reopenCount,
      lastReopenedAt: spec.reopenCount > 0 ? now : null,
      endedAt: spec.status === "ended" ? later : null,
    }).returning({ id: rpodEvents.id });
    await db.insert(rpodEventMembers).values([
      { eventId: row.id, norad: TEST_NORADS[0], minRangeKm: 10, relVelKmS: 0.05 },
      { eventId: row.id, norad: TEST_NORADS[1], minRangeKm: 10, relVelKmS: 0.05 },
      ...(spec.extraMember
        ? [{ eventId: row.id, norad: EXTRA_NORAD, minRangeKm: 10, relVelKmS: 0.05 }]
        : []),
    ]);
    byId.set(row.id, spec);
  }
  return byId;
}

async function main(): Promise<void> {
  const seeded = await seed();
  const seededIds = [...seeded.keys()];

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("no ephemeral port");
  const base = `http://127.0.0.1:${addr.port}/api`;

  const fetchEvents = async (qs: string): Promise<{ data: EventRow[]; total: number; page: number; pages: number }> => {
    const res = await fetch(`${base}/rpod/events${qs}`);
    if (!res.ok) throw new Error(`GET /rpod/events${qs} → ${res.status}`);
    return (await res.json()) as { data: EventRow[]; total: number; page: number; pages: number };
  };

  // Restrict assertions to our seeded rows so pre-existing events don't interfere.
  const seededIn = (rows: EventRow[]): EventRow[] => rows.filter((e) => seeded.has(e.id));
  const seededRepeatIds = seededIds.filter((id) => seeded.get(id)!.reopenCount > 0);
  const seededFirstTimeIds = seededIds.filter((id) => seeded.get(id)!.reopenCount === 0);

  try {
    console.log("reopened=true basic contract");
    {
      const all = await fetchEvents("?limit=1000");
      const allIds = new Set(all.data.map((e) => e.id));
      check("omitting reopened returns first-time cases too",
        seededFirstTimeIds.every((id) => allIds.has(id)));
      check("omitting reopened returns repeat offenders too",
        seededRepeatIds.every((id) => allIds.has(id)));

      const reopened = await fetchEvents("?limit=200&reopened=true");
      check("reopened=true returns only reopenCount > 0 rows (globally)",
        reopened.data.every((e) => e.reopenCount > 0),
        JSON.stringify(reopened.data.filter((e) => e.reopenCount === 0).map((e) => e.id)));
      const reopenedIds = new Set(reopened.data.map((e) => e.id));
      check("reopened=true includes every seeded repeat offender",
        seededRepeatIds.every((id) => reopenedIds.has(id)),
        JSON.stringify(seededRepeatIds.filter((id) => !reopenedIds.has(id))));
      check("reopened=true excludes every seeded first-time case",
        seededFirstTimeIds.every((id) => !reopenedIds.has(id)),
        JSON.stringify(seededFirstTimeIds.filter((id) => reopenedIds.has(id))));

      // A non-"true" value must not activate the filter.
      const bogus = await fetchEvents("?limit=200&reopened=false");
      check("reopened=false is treated as no filter", bogus.total === all.total,
        `${bogus.total} != ${all.total}`);
    }

    console.log("reopened=true combined with status/kind filters");
    {
      const combos: { qs: string; match: (s: SeedSpec) => boolean }[] = [
        { qs: "&status=active", match: (s) => s.status === "active" },
        { qs: "&status=ended", match: (s) => s.status === "ended" },
        { qs: "&kind=conjunction", match: (s) => s.kind === "conjunction" },
        { qs: "&kind=coplanar", match: (s) => s.kind === "coplanar" },
        { qs: "&status=ended&kind=conjunction", match: (s) => s.status === "ended" && s.kind === "conjunction" },
      ];
      for (const { qs, match } of combos) {
        const res = await fetchEvents(`?limit=1000&reopened=true${qs}`);
        const got = new Set(seededIn(res.data).map((e) => e.id));
        const expected = seededIds.filter((id) => {
          const s = seeded.get(id)!;
          return s.reopenCount > 0 && match(s);
        });
        const unexpected = seededIds.filter((id) => got.has(id) && !expected.includes(id));
        check(`reopened=true${qs} returns exactly the matching repeat offenders`,
          expected.every((id) => got.has(id)) && unexpected.length === 0,
          `missing=${JSON.stringify(expected.filter((id) => !got.has(id)))} extra=${JSON.stringify(unexpected)}`);
        check(`reopened=true${qs} rows all have reopenCount > 0`,
          res.data.every((e) => e.reopenCount > 0));
      }
    }

    console.log("reopened=true combined with q= name/NORAD search");
    {
      // q=<EXTRA_NORAD>: only the two extra-member events match by NORAD;
      // combined with reopened=true, only the repeat offender must remain.
      const res = await fetchEvents(`?limit=1000&reopened=true&q=${EXTRA_NORAD}`);
      const got = new Set(seededIn(res.data).map((e) => e.id));
      const expected = seededIds.filter((id) => {
        const s = seeded.get(id)!;
        return s.reopenCount > 0 && s.extraMember === true;
      });
      const unexpected = seededIds.filter((id) => got.has(id) && !expected.includes(id));
      check("reopened=true&q=<norad> returns exactly the matching repeat offenders",
        expected.every((id) => got.has(id)) && unexpected.length === 0,
        `missing=${JSON.stringify(expected.filter((id) => !got.has(id)))} extra=${JSON.stringify(unexpected)}`);
      check("reopened=true&q=<norad> rows all have reopenCount > 0",
        res.data.every((e) => e.reopenCount > 0),
        JSON.stringify(res.data.filter((e) => e.reopenCount === 0).map((e) => e.id)));
      check("reopened=true&q=<norad> excludes seeded first-time cases with that member",
        seededIds.every((id) => seeded.get(id)!.reopenCount > 0 || !got.has(id)));

      // Same q without the filter must include the first-time extra-member event,
      // proving the reopened filter (not the search) is what excluded it above.
      const noFilter = await fetchEvents(`?limit=1000&q=${EXTRA_NORAD}`);
      const noFilterIds = new Set(seededIn(noFilter.data).map((e) => e.id));
      const firstTimeExtra = seededIds.filter((id) => {
        const s = seeded.get(id)!;
        return s.reopenCount === 0 && s.extraMember === true;
      });
      check("q=<norad> without reopened includes first-time extra-member events",
        firstTimeExtra.every((id) => noFilterIds.has(id)));

      // q on the shared NORAD combined with reopened=true must equal the plain
      // reopened set (for seeded rows) — the search must not drop repeat offenders.
      const shared = await fetchEvents(`?limit=1000&reopened=true&q=${TEST_NORADS[0]}`);
      const sharedIds = new Set(seededIn(shared.data).map((e) => e.id));
      check("reopened=true&q=<shared norad> includes every seeded repeat offender",
        seededRepeatIds.every((id) => sharedIds.has(id)),
        JSON.stringify(seededRepeatIds.filter((id) => !sharedIds.has(id))));
      check("reopened=true&q=<shared norad> excludes seeded first-time cases",
        seededFirstTimeIds.every((id) => !sharedIds.has(id)));

      // Empty-match case: a q with no catalog or NORAD hits returns zero rows
      // under the filter (and reports a zero total).
      const empty = await fetchEvents(`?limit=1000&reopened=true&q=${encodeURIComponent(NO_MATCH_Q)}`);
      check("reopened=true with no-match q returns zero rows", empty.data.length === 0,
        `${empty.data.length} rows`);
      check("reopened=true with no-match q reports total=0", empty.total === 0,
        `total=${empty.total}`);
    }

    console.log("Pagination totals under reopened=true");
    {
      const full = await fetchEvents("?limit=200&reopened=true");
      check("total is at least the number of seeded repeat offenders",
        full.total >= seededRepeatIds.length, `${full.total} < ${seededRepeatIds.length}`);

      // Walk all pages with a small limit and confirm the union matches total.
      const limit = 2;
      const first = await fetchEvents(`?limit=${limit}&page=1&reopened=true`);
      const collected: EventRow[] = [...first.data];
      for (let p = 2; p <= first.pages; p++) {
        const pageRes = await fetchEvents(`?limit=${limit}&page=${p}&reopened=true`);
        check(`page ${p} reports the same total`, pageRes.total === first.total,
          `${pageRes.total} != ${first.total}`);
        collected.push(...pageRes.data);
      }
      check("paged union size equals total", collected.length === first.total,
        `${collected.length} != ${first.total}`);
      const uniq = new Set(collected.map((e) => e.id));
      check("no duplicate rows across pages", uniq.size === collected.length);
      check("every paged row has reopenCount > 0", collected.every((e) => e.reopenCount > 0));
      check("paged union contains all seeded repeat offenders",
        seededRepeatIds.every((id) => uniq.has(id)));
      check("paged union contains no seeded first-time cases",
        seededFirstTimeIds.every((id) => !uniq.has(id)));
    }
  } finally {
    if (seededIds.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, seededIds)); // members cascade
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll reopened-filter checks passed");
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
