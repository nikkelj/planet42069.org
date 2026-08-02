/**
 * API contract test for the RPOD events endpoints (src/routes/rpod.ts).
 *
 * Locks in the conjunction-vs-coplanar "kind" contract so the UI's
 * SHADOWING/CONJUNCTION badges and the kind filter can't silently regress:
 *  - GET /api/rpod/events returns a `kind` field on every row
 *  - `kind=conjunction` / `kind=coplanar` filter correctly
 *  - an unknown `kind` value is ignored (no filter applied)
 *  - GET /api/rpod/events/:id returns `kind` on the detail payload
 *
 * Seeds temporary rows into the dev database (NORADs in the 99999xxx test
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

const TEST_NORADS = [99999001, 99999002, 99999003, 99999004];

interface EventRow {
  id: number;
  kind: string;
  status: string;
  members: { norad: number; minRangeKm: number | null }[];
  [k: string]: unknown;
}

async function seed(): Promise<{ conjunctionId: number; coplanarId: number; dockedId: number; durationIds: { short: number; medium: number; long: number } }> {
  const now = new Date("2026-08-01T00:00:00Z");
  const later = new Date("2026-08-01T06:00:00Z");
  const [conj] = await db.insert(rpodEvents).values({
    status: "active", kind: "conjunction",
    windowStart: now, windowEnd: later, tca: now,
    minRangeKm: 4.2, relVelKmS: 0.05, memberCount: 2,
  }).returning({ id: rpodEvents.id });
  const [cop] = await db.insert(rpodEvents).values({
    status: "active", kind: "coplanar",
    windowStart: now, windowEnd: later, tca: now,
    minRangeKm: 175, relVelKmS: 0.02, memberCount: 2,
  }).returning({ id: rpodEvents.id });
  const [dock] = await db.insert(rpodEvents).values({
    status: "active", kind: "docked",
    windowStart: now, windowEnd: later, tca: now,
    minRangeKm: 0.05, relVelKmS: 0.001, memberCount: 2,
  }).returning({ id: rpodEvents.id });
  await db.insert(rpodEventMembers).values([
    { eventId: conj.id, norad: TEST_NORADS[0], minRangeKm: 4.2, relVelKmS: 0.05 },
    { eventId: conj.id, norad: TEST_NORADS[1], minRangeKm: 4.2, relVelKmS: 0.05 },
    { eventId: cop.id, norad: TEST_NORADS[2], minRangeKm: 175, relVelKmS: 0.02 },
    { eventId: cop.id, norad: TEST_NORADS[3], minRangeKm: 175, relVelKmS: 0.02 },
    { eventId: dock.id, norad: TEST_NORADS[0], minRangeKm: 0.05, relVelKmS: 0.001 },
    { eventId: dock.id, norad: TEST_NORADS[1], minRangeKm: 0.05, relVelKmS: 0.001 },
  ]);
  // Duration-sort fixtures: three ended events with identical tca/status/kind
  // but observation spans of 1h, 3h, and 12h — so ordering by
  // (lastSeenAt - firstDetectedAt) is unambiguous.
  const mkSpan = async (hours: number): Promise<number> => {
    const first = new Date("2026-07-15T00:00:00Z");
    const last = new Date(first.getTime() + hours * 3600_000);
    const [row] = await db.insert(rpodEvents).values({
      status: "ended", kind: "coplanar",
      windowStart: now, windowEnd: later, tca: now,
      minRangeKm: 50, relVelKmS: 0.01, memberCount: 2,
      firstDetectedAt: first, lastSeenAt: last, endedAt: last,
    }).returning({ id: rpodEvents.id });
    await db.insert(rpodEventMembers).values([
      { eventId: row.id, norad: TEST_NORADS[2], minRangeKm: 50, relVelKmS: 0.01 },
      { eventId: row.id, norad: TEST_NORADS[3], minRangeKm: 50, relVelKmS: 0.01 },
    ]);
    return row.id;
  };
  const short = await mkSpan(1);
  const medium = await mkSpan(3);
  const long = await mkSpan(12);

  return { conjunctionId: conj.id, coplanarId: cop.id, dockedId: dock.id, durationIds: { short, medium, long } };
}

async function cleanup(ids: number[]): Promise<void> {
  if (ids.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, ids)); // members cascade
}

async function main(): Promise<void> {
  const { conjunctionId, coplanarId, dockedId, durationIds } = await seed();
  const seededIds = [conjunctionId, coplanarId, dockedId, durationIds.short, durationIds.medium, durationIds.long];

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("no ephemeral port");
  const base = `http://127.0.0.1:${addr.port}/api`;

  const fetchEvents = async (qs: string): Promise<{ data: EventRow[]; total: number }> => {
    const res = await fetch(`${base}/rpod/events${qs}`);
    if (!res.ok) throw new Error(`GET /rpod/events${qs} → ${res.status}`);
    return (await res.json()) as { data: EventRow[]; total: number };
  };

  try {
    console.log("List endpoint: kind field & filtering");
    {
      // Unfiltered list (large limit so seeded rows appear regardless of others).
      const all = await fetchEvents("?limit=200");
      check("every listed event carries a kind field",
        all.data.every((e) => e.kind === "conjunction" || e.kind === "coplanar" || e.kind === "docked"),
        JSON.stringify([...new Set(all.data.map((e) => e.kind))]));
      const ids = new Set(all.data.map((e) => e.id));
      check("seeded conjunction visible without filter", ids.has(conjunctionId));
      check("seeded coplanar visible without filter", ids.has(coplanarId));

      const conjOnly = await fetchEvents("?limit=200&kind=conjunction");
      check("kind=conjunction returns only conjunctions",
        conjOnly.data.length > 0 && conjOnly.data.every((e) => e.kind === "conjunction"));
      const conjIds = new Set(conjOnly.data.map((e) => e.id));
      check("kind=conjunction includes seeded conjunction", conjIds.has(conjunctionId));
      check("kind=conjunction excludes seeded coplanar", !conjIds.has(coplanarId));

      const copOnly = await fetchEvents("?limit=200&kind=coplanar");
      check("kind=coplanar returns only coplanar events",
        copOnly.data.length > 0 && copOnly.data.every((e) => e.kind === "coplanar"));
      const copIds = new Set(copOnly.data.map((e) => e.id));
      check("kind=coplanar includes seeded shadowing case", copIds.has(coplanarId));
      check("kind=coplanar excludes seeded conjunction", !copIds.has(conjunctionId));

      const dockOnly = await fetchEvents("?limit=200&kind=docked");
      check("kind=docked returns only docked stacks",
        dockOnly.data.length > 0 && dockOnly.data.every((e) => e.kind === "docked"));
      const dockIds = new Set(dockOnly.data.map((e) => e.id));
      check("kind=docked includes seeded docked stack", dockIds.has(dockedId));
      check("kind=docked excludes seeded conjunction", !dockIds.has(conjunctionId));
      check("kind=conjunction excludes seeded docked stack", !conjIds.has(dockedId));

      check("filtered totals partition the unfiltered total",
        conjOnly.total + copOnly.total + dockOnly.total === all.total,
        `${conjOnly.total} + ${copOnly.total} + ${dockOnly.total} != ${all.total}`);

      // Unknown kind values must be ignored, not silently match nothing.
      const bogus = await fetchEvents("?limit=200&kind=nonsense");
      check("unknown kind value is ignored (no filter)", bogus.total === all.total,
        `${bogus.total} != ${all.total}`);
    }

    console.log("Detail endpoint: kind field");
    {
      for (const [id, expected] of [[conjunctionId, "conjunction"], [coplanarId, "coplanar"], [dockedId, "docked"]] as const) {
        const res = await fetch(`${base}/rpod/events/${id}`);
        check(`detail ${expected} responds 200`, res.ok, `got ${res.status}`);
        const body = (await res.json()) as EventRow;
        check(`detail ${expected} carries kind="${expected}"`, body.kind === expected, `got ${body.kind}`);
        check(`detail ${expected} lists both members`,
          Array.isArray(body.members) && body.members.length === 2,
          JSON.stringify(body.members?.map((m) => m.norad)));
      }
    }
    console.log("List endpoint: sort=duration (lastSeenAt - firstDetectedAt)");
    {
      const durIds = [durationIds.short, durationIds.medium, durationIds.long];
      const orderOf = (rows: EventRow[]): number[] =>
        rows.map((e) => e.id).filter((id) => durIds.includes(id));

      const ascRes = await fetchEvents("?limit=200&sort=duration&order=asc");
      check("sort=duration asc orders short → medium → long",
        JSON.stringify(orderOf(ascRes.data)) === JSON.stringify([durationIds.short, durationIds.medium, durationIds.long]),
        JSON.stringify(orderOf(ascRes.data)));

      const descRes = await fetchEvents("?limit=200&sort=duration&order=desc");
      check("sort=duration desc orders long → medium → short",
        JSON.stringify(orderOf(descRes.data)) === JSON.stringify([durationIds.long, durationIds.medium, durationIds.short]),
        JSON.stringify(orderOf(descRes.data)));

      // Global sanity: entire asc result is non-decreasing in observed span.
      const spanMs = (e: EventRow): number =>
        new Date(String(e.lastSeenAt)).getTime() - new Date(String(e.firstDetectedAt)).getTime();
      check("sort=duration asc is globally non-decreasing",
        ascRes.data.every((e, i) => i === 0 || spanMs(e) >= spanMs(ascRes.data[i - 1])));
      check("sort=duration desc is globally non-increasing",
        descRes.data.every((e, i) => i === 0 || spanMs(e) <= spanMs(descRes.data[i - 1])));

      // As a secondary field: the three fixtures share status=ended, so with
      // sort=status the tie among them must be broken by sort2=duration.
      const sec = await fetchEvents("?limit=200&status=ended&sort=status&order=asc&sort2=duration&order2=asc");
      check("sort2=duration asc breaks ties short → medium → long",
        JSON.stringify(orderOf(sec.data)) === JSON.stringify([durationIds.short, durationIds.medium, durationIds.long]),
        JSON.stringify(orderOf(sec.data)));
      const secDesc = await fetchEvents("?limit=200&status=ended&sort=status&order=asc&sort2=duration&order2=desc");
      check("sort2=duration desc breaks ties long → medium → short",
        JSON.stringify(orderOf(secDesc.data)) === JSON.stringify([durationIds.long, durationIds.medium, durationIds.short]),
        JSON.stringify(orderOf(secDesc.data)));
    }
  } finally {
    await cleanup(seededIds);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll RPOD API contract checks passed");
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
