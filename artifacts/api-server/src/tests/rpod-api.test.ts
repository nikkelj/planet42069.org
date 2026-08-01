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

async function seed(): Promise<{ conjunctionId: number; coplanarId: number }> {
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
  await db.insert(rpodEventMembers).values([
    { eventId: conj.id, norad: TEST_NORADS[0], minRangeKm: 4.2, relVelKmS: 0.05 },
    { eventId: conj.id, norad: TEST_NORADS[1], minRangeKm: 4.2, relVelKmS: 0.05 },
    { eventId: cop.id, norad: TEST_NORADS[2], minRangeKm: 175, relVelKmS: 0.02 },
    { eventId: cop.id, norad: TEST_NORADS[3], minRangeKm: 175, relVelKmS: 0.02 },
  ]);
  return { conjunctionId: conj.id, coplanarId: cop.id };
}

async function cleanup(ids: number[]): Promise<void> {
  if (ids.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, ids)); // members cascade
}

async function main(): Promise<void> {
  const { conjunctionId, coplanarId } = await seed();
  const seededIds = [conjunctionId, coplanarId];

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
        all.data.every((e) => e.kind === "conjunction" || e.kind === "coplanar"),
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

      check("filtered totals partition the unfiltered total",
        conjOnly.total + copOnly.total === all.total,
        `${conjOnly.total} + ${copOnly.total} != ${all.total}`);

      // Unknown kind values must be ignored, not silently match nothing.
      const bogus = await fetchEvents("?limit=200&kind=nonsense");
      check("unknown kind value is ignored (no filter)", bogus.total === all.total,
        `${bogus.total} != ${all.total}`);
    }

    console.log("Detail endpoint: kind field");
    {
      for (const [id, expected] of [[conjunctionId, "conjunction"], [coplanarId, "coplanar"]] as const) {
        const res = await fetch(`${base}/rpod/events/${id}`);
        check(`detail ${expected} responds 200`, res.ok, `got ${res.status}`);
        const body = (await res.json()) as EventRow;
        check(`detail ${expected} carries kind="${expected}"`, body.kind === expected, `got ${body.kind}`);
        check(`detail ${expected} lists both members`,
          Array.isArray(body.members) && body.members.length === 2,
          JSON.stringify(body.members?.map((m) => m.norad)));
      }
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
