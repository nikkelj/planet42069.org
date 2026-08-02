/**
 * DB integration test for the stale conjunction-track case-reopen path in
 * persistEvents (src/lib/rpod/scan.ts).
 *
 * A conjunction/docked case whose window lapsed (status "stale" via
 * markStaleEvents) must NOT split its history across two case numbers when
 * the same pair is re-flagged:
 *  - a stale conjunction case re-detected within CONJUNCTION_REOPEN_WINDOW_MS
 *    is REACTIVATED: same event id goes active, reopenCount=1,
 *    lastReopenedAt set, members replaced
 *  - the lapsed spell is archived into closed_spells (start=firstDetectedAt,
 *    lastSeenAt/endedAt = pre-reopen lastSeenAt — stale rows have no endedAt)
 *  - a stale DOCKED case is also matched (kinds are interchangeable on the
 *    conjunction track)
 *  - a stale case last seen OUTSIDE the reopen window is left alone; the
 *    incoming cluster opens a fresh case
 *  - a non-matching pair never reopens someone else's stale case
 *
 * Seeds temporary rows (NORADs in the 99999xxx test range) and always
 * cleans up after itself.
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { db, pool } from "@workspace/db";
import { rpodEvents, rpodEventMembers } from "@workspace/db/schema";
import { inArray, eq } from "drizzle-orm";
import { persistEvents } from "../lib/rpod/scan";
import { CONJUNCTION_REOPEN_WINDOW_MS } from "../lib/rpod/retire";
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

const PAIR = [99999301, 99999302];
const DOCKED_PAIR = [99999303, 99999304];
const EXPIRED_PAIR = [99999305, 99999306];
const FRESH_PAIR = [99999307, 99999308];
const ALL_NORADS = [...PAIR, ...DOCKED_PAIR, ...EXPIRED_PAIR, ...FRESH_PAIR];

function makeCluster(members: number[], nowMs: number, minRangeKm = 8.4, relVelKmS = 0.12): ClusteredEvent {
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

async function seedStale(kind: "conjunction" | "docked", pair: number[], lastSeenAt: Date, nowMs: number) {
  const [row] = await db.insert(rpodEvents).values({
    status: "stale", kind,
    windowStart: new Date(nowMs - 10 * 86400_000),
    windowEnd: new Date(nowMs - 9 * 86400_000),
    tca: new Date(nowMs - 9.5 * 86400_000),
    minRangeKm: kind === "docked" ? 0.1 : 5.5,
    relVelKmS: kind === "docked" ? 0.001 : 0.2,
    memberCount: 2,
    lastSeenAt,
  }).returning({ id: rpodEvents.id });
  await db.insert(rpodEventMembers).values(pair.map((norad) => ({ eventId: row.id, norad })));
  return row.id;
}

async function eventIdsForNorads(norads: number[]): Promise<number[]> {
  const rows = await db.select({ id: rpodEvents.id }).from(rpodEvents)
    .innerJoin(rpodEventMembers, eq(rpodEventMembers.eventId, rpodEvents.id))
    .where(inArray(rpodEventMembers.norad, norads));
  return [...new Set(rows.map((r) => r.id))];
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const cleanupIds: number[] = [];

  const staleLastSeen = new Date(nowMs - 5 * 86400_000); // inside the 30d window
  const expiredLastSeen = new Date(nowMs - CONJUNCTION_REOPEN_WINDOW_MS - 86400_000); // outside

  const staleId = await seedStale("conjunction", PAIR, staleLastSeen, nowMs);
  const dockedId = await seedStale("docked", DOCKED_PAIR, staleLastSeen, nowMs);
  const expiredId = await seedStale("conjunction", EXPIRED_PAIR, expiredLastSeen, nowMs);
  cleanupIds.push(staleId, dockedId, expiredId);

  const [seeded] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, staleId));
  const firstDetectedAt = seeded.firstDetectedAt;

  try {
    console.log("Reopen: stale conjunction case re-detected within the window");
    await persistEvents([makeCluster(PAIR, nowMs)], "conjunction");

    const ids = await eventIdsForNorads(PAIR);
    check("no new case number for the re-detected pair",
      ids.length === 1 && ids[0] === staleId, JSON.stringify(ids));
    const [row] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, staleId));
    check("same event id is active again", row?.status === "active", `status=${row?.status}`);
    check("reopenCount bumped to 1", row?.reopenCount === 1, `reopenCount=${row?.reopenCount}`);
    check("lastReopenedAt is set", row?.lastReopenedAt != null);
    check("endedAt stays null", row?.endedAt == null, `endedAt=${String(row?.endedAt)}`);
    check("stats updated to the new geometry",
      row?.minRangeKm === 8.4 && row?.relVelKmS === 0.12,
      `minRange=${row?.minRangeKm} relVel=${row?.relVelKmS}`);
    const members = await db.select().from(rpodEventMembers).where(eq(rpodEventMembers.eventId, staleId));
    check("members replaced (exactly the incoming pair)",
      members.length === 2 && PAIR.every((n) => members.some((m) => m.norad === n)),
      JSON.stringify(members.map((m) => m.norad)));

    const spells = row?.closedSpells ?? [];
    check("lapsed spell archived into closed_spells", spells.length === 1, JSON.stringify(spells));
    check("archived spell start = firstDetectedAt",
      spells[0]?.start === firstDetectedAt.toISOString(),
      `${spells[0]?.start} vs ${firstDetectedAt.toISOString()}`);
    check("archived spell lastSeenAt = pre-reopen lastSeenAt",
      spells[0]?.lastSeenAt === staleLastSeen.toISOString(),
      `${spells[0]?.lastSeenAt} vs ${staleLastSeen.toISOString()}`);
    check("archived spell endedAt falls back to lastSeenAt (stale rows have no endedAt)",
      spells[0]?.endedAt === staleLastSeen.toISOString(),
      `${spells[0]?.endedAt} vs ${staleLastSeen.toISOString()}`);

    console.log("Reopen: stale DOCKED case also matches the conjunction track");
    await persistEvents([makeCluster(DOCKED_PAIR, nowMs, 0.2, 0.005)], "conjunction");
    const dockedIds = await eventIdsForNorads(DOCKED_PAIR);
    check("docked stale case reactivated under the same id",
      dockedIds.length === 1 && dockedIds[0] === dockedId, JSON.stringify(dockedIds));
    const [dockedRow] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, dockedId));
    check("reactivated docked case is active", dockedRow?.status === "active", `status=${dockedRow?.status}`);
    check("docked geometry keeps kind=docked", dockedRow?.kind === "docked", `kind=${dockedRow?.kind}`);

    console.log("Window edge: stale case last seen OUTSIDE the window opens a fresh case");
    await persistEvents([makeCluster(EXPIRED_PAIR, nowMs)], "conjunction");
    const expIds = await eventIdsForNorads(EXPIRED_PAIR);
    check("expired stale case NOT reopened — fresh id issued",
      expIds.length === 2 && expIds.includes(expiredId), JSON.stringify(expIds));
    const freshId = expIds.find((i) => i !== expiredId);
    if (freshId != null) cleanupIds.push(freshId);
    const [expRow] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, expiredId));
    check("expired case left stale and untouched",
      expRow?.status === "stale" && expRow?.reopenCount === 0,
      `status=${expRow?.status} reopenCount=${expRow?.reopenCount}`);

    console.log("Non-matching pair: never reopens someone else's stale case");
    await persistEvents([makeCluster(FRESH_PAIR, nowMs)], "conjunction");
    const freshIds = await eventIdsForNorads(FRESH_PAIR);
    check("unrelated pair gets a brand-new case", freshIds.length === 1 && !cleanupIds.includes(freshIds[0]),
      JSON.stringify(freshIds));
    cleanupIds.push(...freshIds);
    const [freshRow] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, freshIds[0]));
    check("brand-new case starts with reopenCount=0", freshRow?.reopenCount === 0,
      `reopenCount=${freshRow?.reopenCount}`);
  } finally {
    if (cleanupIds.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, cleanupIds)); // members cascade
    // Safety net: remove any leftover test rows keyed by our NORAD range.
    const leftovers = await eventIdsForNorads(ALL_NORADS);
    if (leftovers.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, leftovers));
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll RPOD stale-reopen persistence checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
