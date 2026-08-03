/**
 * DB integration test for the docked<->conjunction kind-flip path in
 * persistEvents + reclassifyDockedEvents (src/lib/rpod/scan.ts).
 *
 * A stack that flips between "docked" (near-zero range AND near-zero
 * relative velocity) and "conjunction" must keep the SAME case number:
 *  - an active conjunction re-persisted with docked geometry
 *    (minRange <= 0.5 km, relVel <= 0.01 km/s) updates the SAME event id
 *    with kind="docked" — no new row
 *  - the reverse flip (docked -> conjunction when geometry widens) also
 *    updates in place
 *  - the reclassifyDockedEvents() sweep relabels stored rows in both
 *    directions without touching ids
 *
 * Seeds temporary rows (NORADs in the 99999xxx test range) and always
 * cleans up after itself.
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { db, pool } from "@workspace/db";
import { rpodEvents, rpodEventMembers } from "@workspace/db/schema";
import { inArray, eq } from "drizzle-orm";
import { persistEvents, reclassifyDockedEvents, DOCKED_MAX_RANGE_KM, DOCKED_MAX_RELVEL_KM_S } from "../lib/rpod/scan";
import type { ClusteredEvent } from "../lib/rpod/screen";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const PAIR = [99999201, 99999202];

function makeCluster(members: number[], nowMs: number, minRangeKm: number, relVelKmS: number): ClusteredEvent {
  const [a, b] = members;
  const pair = { a, b, minRangeKm, relVelKmS, tcaMs: nowMs };
  return {
    members,
    pairs: [pair],
    minRangeKm,
    relVelKmS,
    tcaMs: nowMs,
    windowStartMs: nowMs - 3600_000,
    windowEndMs: nowMs + 3600_000,
    hitCap: false,
  };
}

async function eventIdsForPair(): Promise<number[]> {
  const rows = await db.select({ id: rpodEvents.id }).from(rpodEvents)
    .innerJoin(rpodEventMembers, eq(rpodEventMembers.eventId, rpodEvents.id))
    .where(inArray(rpodEventMembers.norad, PAIR));
  return [...new Set(rows.map((r) => r.id))];
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const cleanupIds: number[] = [];

  // Seed: an ACTIVE conjunction case for PAIR (clearly non-docked geometry).
  const [conj] = await db.insert(rpodEvents).values({
    status: "active", kind: "conjunction",
    windowStart: new Date(nowMs - 3600_000), windowEnd: new Date(nowMs + 3600_000),
    tca: new Date(nowMs), minRangeKm: 4.2, relVelKmS: 0.05, memberCount: 2,
  }).returning({ id: rpodEvents.id });
  cleanupIds.push(conj.id);
  await db.insert(rpodEventMembers).values([
    { eventId: conj.id, norad: PAIR[0], minRangeKm: 4.2, relVelKmS: 0.05 },
    { eventId: conj.id, norad: PAIR[1], minRangeKm: 4.2, relVelKmS: 0.05 },
  ]);

  try {
    console.log("Flip 1: active conjunction re-persisted with docked geometry");
    // Exactly at the docked thresholds — boundary values must count as docked.
    await persistEvents([makeCluster(PAIR, nowMs, DOCKED_MAX_RANGE_KM, DOCKED_MAX_RELVEL_KM_S)], "conjunction");

    let ids = await eventIdsForPair();
    check("no new row opened on conjunction -> docked flip",
      ids.length === 1 && ids[0] === conj.id, JSON.stringify(ids));
    let [row] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, conj.id));
    check("same event id now carries kind=\"docked\"", row?.kind === "docked", `kind=${row?.kind}`);
    check("event stays active", row?.status === "active", `status=${row?.status}`);
    check("stats updated to the docked geometry",
      row?.minRangeKm === DOCKED_MAX_RANGE_KM && row?.relVelKmS === DOCKED_MAX_RELVEL_KM_S,
      `minRange=${row?.minRangeKm} relVel=${row?.relVelKmS}`);
    let members = await db.select().from(rpodEventMembers).where(eq(rpodEventMembers.eventId, conj.id));
    check("members preserved across the flip",
      members.length === 2 && PAIR.every((n) => members.some((m) => m.norad === n)),
      JSON.stringify(members.map((m) => m.norad)));

    console.log("Flip 2: docked case re-persisted with widened geometry");
    await persistEvents([makeCluster(PAIR, nowMs, 3.7, 0.08)], "conjunction");

    ids = await eventIdsForPair();
    check("no new row opened on docked -> conjunction flip",
      ids.length === 1 && ids[0] === conj.id, JSON.stringify(ids));
    [row] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, conj.id));
    check("same event id flipped back to kind=\"conjunction\"", row?.kind === "conjunction", `kind=${row?.kind}`);
    check("stats updated to the widened geometry",
      row?.minRangeKm === 3.7 && row?.relVelKmS === 0.08,
      `minRange=${row?.minRangeKm} relVel=${row?.relVelKmS}`);
    members = await db.select().from(rpodEventMembers).where(eq(rpodEventMembers.eventId, conj.id));
    check("members preserved across the reverse flip",
      members.length === 2 && PAIR.every((n) => members.some((m) => m.norad === n)),
      JSON.stringify(members.map((m) => m.norad)));

    console.log("Sweep: reclassifyDockedEvents relabels stored rows in place");
    // Simulate a row whose stored stats qualify as docked but whose label is
    // stale (e.g. created before docked labeling existed).
    await db.update(rpodEvents)
      .set({ kind: "conjunction", minRangeKm: 0.05, relVelKmS: 0.001 })
      .where(eq(rpodEvents.id, conj.id));
    await reclassifyDockedEvents();
    [row] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, conj.id));
    check("sweep relabels conjunction -> docked when stats qualify", row?.kind === "docked", `kind=${row?.kind}`);

    // Now the reverse: label says docked but stats say otherwise.
    await db.update(rpodEvents)
      .set({ minRangeKm: 2.1, relVelKmS: 0.001 }) // range disqualifies
      .where(eq(rpodEvents.id, conj.id));
    await reclassifyDockedEvents();
    [row] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, conj.id));
    check("sweep relabels docked -> conjunction when range widens", row?.kind === "conjunction", `kind=${row?.kind}`);

    await db.update(rpodEvents)
      .set({ kind: "docked", minRangeKm: 0.05, relVelKmS: 0.02 }) // relVel disqualifies
      .where(eq(rpodEvents.id, conj.id));
    await reclassifyDockedEvents();
    [row] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, conj.id));
    check("sweep relabels docked -> conjunction when relVel rises", row?.kind === "conjunction", `kind=${row?.kind}`);

    ids = await eventIdsForPair();
    check("sweep never changes the case id", ids.length === 1 && ids[0] === conj.id, JSON.stringify(ids));
  } finally {
    if (cleanupIds.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, cleanupIds)); // members cascade
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll RPOD docked-flip persistence checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
