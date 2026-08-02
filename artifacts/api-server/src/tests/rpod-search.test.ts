/**
 * Regression test for the RPOD event search (GET /api/rpod/events?q=).
 *
 * The q parameter resolves names to NORAD ids via the in-memory satcat
 * catalog, then filters events by member NORAD. This locks in:
 *  - numeric NORAD query matches only events containing that member
 *  - case-insensitive name substring matching (name and plName)
 *  - a no-match query returns zero rows, not everything
 *  - q combines with kind= and status= filters (AND semantics)
 *
 * Seeds temporary catalog rows into obc_objects (ZZQ… names, NORADs in the
 * 99999xxx test range) plus rpod events, invalidates the in-memory catalog
 * cache, exercises the real express app over HTTP, then cleans up.
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { db, pool } from "@workspace/db";
import { rpodEvents, rpodEventMembers, obcObjects } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import type { Server } from "node:http";
import app from "../app";
import { invalidateStore } from "../lib/obc/store";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Unique, collision-proof test identities.
const N = { alpha: 99999011, bravo: 99999012, charlie: 99999013, delta: 99999014 };
const TEST_NORADS = Object.values(N);
const TEST_KEYS = TEST_NORADS.map((n) => `ZZQTEST-${n}`);

interface EventRow {
  id: number;
  kind: string;
  status: string;
  members: { norad: number }[];
  [k: string]: unknown;
}

async function seed(): Promise<{ conjId: number; copId: number }> {
  await db.insert(obcObjects).values([
    { key: `ZZQTEST-${N.alpha}`, norad: N.alpha, name: "ZZQALPHASAT 1", plName: "ZZQ Alpha Payload" },
    { key: `ZZQTEST-${N.bravo}`, norad: N.bravo, name: "ZZQBRAVOSAT 2", plName: null },
    { key: `ZZQTEST-${N.charlie}`, norad: N.charlie, name: "ZZQCHARLIESAT 3", plName: null },
    { key: `ZZQTEST-${N.delta}`, norad: N.delta, name: "ZZQDELTASAT 4", plName: null },
  ]);

  const now = new Date("2026-08-01T00:00:00Z");
  const later = new Date("2026-08-01T06:00:00Z");
  const [conj] = await db.insert(rpodEvents).values({
    status: "active", kind: "conjunction",
    windowStart: now, windowEnd: later, tca: now,
    minRangeKm: 3.1, relVelKmS: 0.04, memberCount: 2,
  }).returning({ id: rpodEvents.id });
  const [cop] = await db.insert(rpodEvents).values({
    status: "ended", kind: "coplanar",
    windowStart: now, windowEnd: later, tca: now, endedAt: later,
    minRangeKm: 150, relVelKmS: 0.01, memberCount: 2,
  }).returning({ id: rpodEvents.id });
  await db.insert(rpodEventMembers).values([
    { eventId: conj.id, norad: N.alpha, minRangeKm: 3.1, relVelKmS: 0.04 },
    { eventId: conj.id, norad: N.bravo, minRangeKm: 3.1, relVelKmS: 0.04 },
    { eventId: cop.id, norad: N.charlie, minRangeKm: 150, relVelKmS: 0.01 },
    { eventId: cop.id, norad: N.delta, minRangeKm: 150, relVelKmS: 0.01 },
  ]);
  return { conjId: conj.id, copId: cop.id };
}

async function cleanup(ids: number[]): Promise<void> {
  if (ids.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, ids)); // members cascade
  await db.delete(obcObjects).where(inArray(obcObjects.key, TEST_KEYS));
  invalidateStore();
}

async function main(): Promise<void> {
  const { conjId, copId } = await seed();
  const seededIds = [conjId, copId];
  invalidateStore(); // force the next getSatcat() to see the seeded rows

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
  const idsOf = (r: { data: EventRow[] }) => new Set(r.data.map((e) => e.id));

  try {
    console.log("Numeric NORAD query");
    {
      const r = await fetchEvents(`?limit=200&q=${N.alpha}`);
      check("q=<norad> finds the containing event", idsOf(r).has(conjId));
      check("q=<norad> excludes unrelated seeded event", !idsOf(r).has(copId));
      check("q=<norad> matches only events with that member",
        r.data.every((e) => e.members.some((m) => m.norad === N.alpha)),
        JSON.stringify(r.data.map((e) => e.id)));
    }

    console.log("Name substring query (case-insensitive)");
    {
      const r = await fetchEvents("?limit=200&q=zzqBRAVO");
      check("mixed-case substring finds the event", idsOf(r).has(conjId));
      check("substring match excludes non-matching event", !idsOf(r).has(copId));

      const both = await fetchEvents("?limit=200&q=ZZQ");
      check("shared prefix matches both seeded events",
        idsOf(both).has(conjId) && idsOf(both).has(copId));

      const pl = await fetchEvents("?limit=200&q=alpha payload");
      check("plName substring also matches", idsOf(pl).has(conjId));
    }

    console.log("No-match query returns empty, not everything");
    {
      const r = await fetchEvents("?limit=200&q=xq77nosuchsatname77");
      check("total is 0", r.total === 0, `total=${r.total}`);
      check("data is empty", r.data.length === 0, `${r.data.length} rows`);

      // Numeric with no catalog/member match must also be empty.
      const num = await fetchEvents("?limit=200&q=99999999");
      check("unmatched numeric NORAD returns zero rows", num.total === 0, `total=${num.total}`);
    }

    console.log("q combined with kind/status filters");
    {
      const conjOnly = await fetchEvents("?limit=200&q=ZZQ&kind=conjunction");
      check("q+kind=conjunction keeps the conjunction", idsOf(conjOnly).has(conjId));
      check("q+kind=conjunction drops the coplanar", !idsOf(conjOnly).has(copId));

      const copOnly = await fetchEvents("?limit=200&q=ZZQ&kind=coplanar");
      check("q+kind=coplanar keeps the coplanar", idsOf(copOnly).has(copId));
      check("q+kind=coplanar drops the conjunction", !idsOf(copOnly).has(conjId));

      const active = await fetchEvents("?limit=200&q=ZZQ&status=active");
      check("q+status=active keeps the active event", idsOf(active).has(conjId));
      check("q+status=active drops the ended event", !idsOf(active).has(copId));

      const ended = await fetchEvents("?limit=200&q=ZZQ&status=ended");
      check("q+status=ended keeps the ended event", idsOf(ended).has(copId));
      check("q+status=ended drops the active event", !idsOf(ended).has(conjId));

      const none = await fetchEvents("?limit=200&q=zzqBRAVO&kind=coplanar");
      check("q matching only a conjunction + kind=coplanar is empty",
        none.total === 0, `total=${none.total}`);
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
  console.log("\nAll RPOD search checks passed");
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
