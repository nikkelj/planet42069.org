/**
 * DB integration test for the coplanar case-reopen path in persistEvents
 * (src/lib/rpod/scan.ts).
 *
 * The pure reopen decision (selectReopenCandidate) is unit-tested elsewhere;
 * this exercises the real database path against the dev DB:
 *  - an "ended" coplanar case whose pair closes ranks again is REACTIVATED:
 *    same event id goes active, reopenCount=1, lastReopenedAt set,
 *    endedAt cleared, members replaced
 *  - a cluster that does NOT match the ended case gets a fresh event id
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

const PAIR = [99999101, 99999102];
const OTHER_PAIR = [99999103, 99999104];
const ALL_NORADS = [...PAIR, ...OTHER_PAIR];

function makeCluster(members: number[], nowMs: number): ClusteredEvent {
  const [a, b] = members;
  const pair = { a, b, minRangeKm: 42.5, relVelKmS: 0.015, tcaMs: nowMs };
  return {
    members,
    pairs: [pair],
    minRangeKm: pair.minRangeKm,
    relVelKmS: pair.relVelKmS,
    tcaMs: nowMs,
    windowStartMs: nowMs - 3600_000,
    windowEndMs: nowMs + 3600_000,
    hitCap: false,
  };
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const endedAt = new Date(nowMs - 3 * 86400_000); // well inside the 90-day reopen window
  const cleanupIds: number[] = [];

  // Seed: an ENDED coplanar case for PAIR.
  const [ended] = await db.insert(rpodEvents).values({
    status: "ended", kind: "coplanar",
    windowStart: new Date(nowMs - 30 * 86400_000),
    windowEnd: new Date(nowMs - 4 * 86400_000),
    tca: new Date(nowMs - 5 * 86400_000),
    minRangeKm: 60, relVelKmS: 0.01, memberCount: 2,
    endedAt,
    lastSeenAt: new Date(nowMs - 4 * 86400_000),
  }).returning({ id: rpodEvents.id });
  cleanupIds.push(ended.id);
  await db.insert(rpodEventMembers).values([
    { eventId: ended.id, norad: PAIR[0], minRangeKm: 60, relVelKmS: 0.01 },
    { eventId: ended.id, norad: PAIR[1], minRangeKm: 60, relVelKmS: 0.01 },
  ]);

  try {
    console.log("Reopen path: matching cluster reactivates the ended case");
    await persistEvents([makeCluster(PAIR, nowMs)], "coplanar");

    const [row] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, ended.id));
    check("ended case still exists under the same id", row != null);
    check("same event id is active again", row?.status === "active", `status=${row?.status}`);
    check("reopenCount bumped to 1", row?.reopenCount === 1, `reopenCount=${row?.reopenCount}`);
    check("lastReopenedAt is set", row?.lastReopenedAt != null);
    check("endedAt cleared", row?.endedAt == null, `endedAt=${String(row?.endedAt)}`);
    check("lastSeenAt refreshed", row != null && row.lastSeenAt.getTime() > nowMs - 60_000);

    const members = await db.select().from(rpodEventMembers).where(eq(rpodEventMembers.eventId, ended.id));
    check("members replaced (exactly the incoming pair)",
      members.length === 2 && PAIR.every((n) => members.some((m) => m.norad === n)),
      JSON.stringify(members.map((m) => m.norad)));

    // No duplicate case opened for the same pair.
    const dupes = await db.select({ id: rpodEvents.id }).from(rpodEvents)
      .innerJoin(rpodEventMembers, eq(rpodEventMembers.eventId, rpodEvents.id))
      .where(inArray(rpodEventMembers.norad, PAIR));
    const dupeIds = new Set(dupes.map((d) => d.id));
    check("no fresh case opened for the reopened pair", dupeIds.size === 1 && dupeIds.has(ended.id),
      JSON.stringify([...dupeIds]));

    console.log("Non-matching cluster: gets a brand-new event id");
    // Reset the seeded case back to ended so it is again reopen-eligible;
    // a DIFFERENT pair must not reactivate it.
    await db.update(rpodEvents)
      .set({ status: "ended", endedAt, reopenCount: 0, lastReopenedAt: null })
      .where(eq(rpodEvents.id, ended.id));

    await persistEvents([makeCluster(OTHER_PAIR, nowMs)], "coplanar");

    const [after] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, ended.id));
    check("unrelated cluster leaves the ended case ended", after?.status === "ended", `status=${after?.status}`);
    check("unrelated cluster does not bump reopenCount", after?.reopenCount === 0, `reopenCount=${after?.reopenCount}`);

    const fresh = await db.select({ id: rpodEvents.id, status: rpodEvents.status, reopenCount: rpodEvents.reopenCount })
      .from(rpodEvents)
      .innerJoin(rpodEventMembers, eq(rpodEventMembers.eventId, rpodEvents.id))
      .where(inArray(rpodEventMembers.norad, OTHER_PAIR));
    const freshIds = [...new Set(fresh.map((f) => f.id))];
    cleanupIds.push(...freshIds);
    check("non-matching cluster opened exactly one fresh case", freshIds.length === 1, JSON.stringify(freshIds));
    check("fresh case has a different id", freshIds.length === 1 && freshIds[0] !== ended.id);
    check("fresh case is active with reopenCount=0",
      fresh.length > 0 && fresh.every((f) => f.status === "active" && f.reopenCount === 0));
  } finally {
    // Belt-and-braces cleanup: by tracked ids AND by test norad range.
    const byMember = await db.select({ id: rpodEventMembers.eventId }).from(rpodEventMembers)
      .where(inArray(rpodEventMembers.norad, ALL_NORADS));
    const ids = [...new Set([...cleanupIds, ...byMember.map((r) => r.id)])];
    if (ids.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, ids)); // members cascade
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll RPOD reopen persistence checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
