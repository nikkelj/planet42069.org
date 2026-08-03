/**
 * DB integration test for the coplanar case-reopen path in persistEvents
 * (src/lib/rpod/scan.ts).
 *
 * The pure reopen decision (selectReopenCandidate) is unit-tested elsewhere;
 * this exercises the real database path against the dev DB:
 *  - an "ended" coplanar case whose pair closes ranks again is REACTIVATED:
 *    same event id goes active, reopenCount=1, lastReopenedAt set,
 *    endedAt cleared, members replaced
 *  - the completed shadowing spell is archived into closed_spells at reopen
 *    time (start = firstDetectedAt or previous reopen, lastSeenAt, endedAt)
 *  - a SECOND reopen appends a second spell entry instead of overwriting
 *  - GET /rpod/events/:id reconstructs the full per-spell interval list,
 *    including synthesizing a first spell for legacy rows reopened before
 *    spell recording existed (reopenCount > stored spells)
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
import type { Server } from "node:http";
import { persistEvents } from "../lib/rpod/scan";
import type { ClusteredEvent } from "../lib/rpod/screen";
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

  // Read back the seeded row for its DB-assigned firstDetectedAt.
  const [seeded] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, ended.id));
  const firstDetectedAt = seeded.firstDetectedAt;
  const seededLastSeenAt = seeded.lastSeenAt;

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("no ephemeral port");
  const base = `http://127.0.0.1:${addr.port}/api`;

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

    console.log("Spell archive: first reopen captures the completed spell");
    const spells1 = row?.closedSpells ?? [];
    check("closed_spells has exactly one archived spell", spells1.length === 1, JSON.stringify(spells1));
    check("archived spell start = firstDetectedAt",
      spells1[0]?.start === firstDetectedAt.toISOString(),
      `${spells1[0]?.start} vs ${firstDetectedAt.toISOString()}`);
    check("archived spell lastSeenAt = pre-reopen lastSeenAt",
      spells1[0]?.lastSeenAt === seededLastSeenAt.toISOString(),
      `${spells1[0]?.lastSeenAt} vs ${seededLastSeenAt.toISOString()}`);
    check("archived spell endedAt = pre-reopen endedAt",
      spells1[0]?.endedAt === endedAt.toISOString(),
      `${spells1[0]?.endedAt} vs ${endedAt.toISOString()}`);

    console.log("Second reopen: appends a second spell instead of overwriting");
    const firstReopenedAt = row!.lastReopenedAt!;
    const secondEndedAt = new Date(nowMs - 86400_000); // re-ended a day ago, inside the window
    const secondLastSeenAt = row!.lastSeenAt; // refreshed by the first reopen
    await db.update(rpodEvents)
      .set({ status: "ended", endedAt: secondEndedAt })
      .where(eq(rpodEvents.id, ended.id));

    await persistEvents([makeCluster(PAIR, nowMs)], "coplanar");

    const [row2] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, ended.id));
    check("second reopen bumps reopenCount to 2", row2?.reopenCount === 2, `reopenCount=${row2?.reopenCount}`);
    const spells2 = row2?.closedSpells ?? [];
    check("closed_spells now has two entries", spells2.length === 2, JSON.stringify(spells2));
    check("first archived spell is preserved unchanged",
      JSON.stringify(spells2[0]) === JSON.stringify(spells1[0]),
      `${JSON.stringify(spells2[0])} vs ${JSON.stringify(spells1[0])}`);
    check("second spell start = first reopen timestamp",
      spells2[1]?.start === firstReopenedAt.toISOString(),
      `${spells2[1]?.start} vs ${firstReopenedAt.toISOString()}`);
    check("second spell lastSeenAt = lastSeenAt from first spell's run",
      spells2[1]?.lastSeenAt === secondLastSeenAt.toISOString(),
      `${spells2[1]?.lastSeenAt} vs ${secondLastSeenAt.toISOString()}`);
    check("second spell endedAt = second ending",
      spells2[1]?.endedAt === secondEndedAt.toISOString(),
      `${spells2[1]?.endedAt} vs ${secondEndedAt.toISOString()}`);

    console.log("Detail endpoint: reconstructs closed spells + current spell");
    type Spell = { start: string; lastSeenAt: string | null; endedAt: string | null };
    const detailRes = await fetch(`${base}/rpod/events/${ended.id}`);
    check("detail endpoint responds 200", detailRes.ok, `got ${detailRes.status}`);
    const detail = (await detailRes.json()) as { spells: Spell[]; reopenCount: number };
    check("detail lists 3 spells (2 closed + current)", detail.spells?.length === 3,
      JSON.stringify(detail.spells));
    // Normalize key order — jsonb round-trips reorder object keys.
    const norm = (s: { start: string; lastSeenAt: string | null; endedAt: string | null }[]) =>
      JSON.stringify(s.map((x) => [x.start, x.lastSeenAt, x.endedAt]));
    check("detail spells 1+2 match the stored archive",
      norm(detail.spells?.slice(0, 2) ?? []) === norm(spells2),
      `${norm(detail.spells?.slice(0, 2) ?? [])} vs ${norm(spells2)}`);
    check("current spell starts at the second reopen",
      detail.spells?.[2]?.start === row2!.lastReopenedAt!.toISOString(),
      `${detail.spells?.[2]?.start} vs ${row2!.lastReopenedAt!.toISOString()}`);
    check("current spell is open-ended (endedAt null)", detail.spells?.[2]?.endedAt === null,
      String(detail.spells?.[2]?.endedAt));

    console.log("Detail endpoint: legacy row synthesis (reopenCount > stored spells)");
    const legacyReopenedAt = new Date(nowMs - 2 * 86400_000);
    const [legacy] = await db.insert(rpodEvents).values({
      status: "active", kind: "coplanar",
      windowStart: new Date(nowMs - 3600_000), windowEnd: new Date(nowMs + 3600_000),
      tca: new Date(nowMs), minRangeKm: 55, relVelKmS: 0.01, memberCount: 2,
      reopenCount: 1, lastReopenedAt: legacyReopenedAt, // reopened before spell recording existed
    }).returning({ id: rpodEvents.id, firstDetectedAt: rpodEvents.firstDetectedAt });
    cleanupIds.push(legacy.id);
    await db.insert(rpodEventMembers).values([
      { eventId: legacy.id, norad: PAIR[0], minRangeKm: 55, relVelKmS: 0.01 },
      { eventId: legacy.id, norad: PAIR[1], minRangeKm: 55, relVelKmS: 0.01 },
    ]);

    const legacyRes = await fetch(`${base}/rpod/events/${legacy.id}`);
    check("legacy detail responds 200", legacyRes.ok, `got ${legacyRes.status}`);
    const legacyDetail = (await legacyRes.json()) as { spells: Spell[] };
    check("legacy row synthesizes 2 spells", legacyDetail.spells?.length === 2,
      JSON.stringify(legacyDetail.spells));
    check("synthesized first spell starts at firstDetectedAt",
      legacyDetail.spells?.[0]?.start === legacy.firstDetectedAt.toISOString(),
      `${legacyDetail.spells?.[0]?.start} vs ${legacy.firstDetectedAt.toISOString()}`);
    check("synthesized first spell has null lastSeenAt", legacyDetail.spells?.[0]?.lastSeenAt === null,
      String(legacyDetail.spells?.[0]?.lastSeenAt));
    check("synthesized first spell ends at the reopen timestamp",
      legacyDetail.spells?.[0]?.endedAt === legacyReopenedAt.toISOString(),
      `${legacyDetail.spells?.[0]?.endedAt} vs ${legacyReopenedAt.toISOString()}`);
    check("legacy current spell starts at the reopen timestamp",
      legacyDetail.spells?.[1]?.start === legacyReopenedAt.toISOString(),
      `${legacyDetail.spells?.[1]?.start} vs ${legacyReopenedAt.toISOString()}`);

    console.log("Non-matching cluster: gets a brand-new event id");
    // Reset the seeded case back to ended so it is again reopen-eligible;
    // a DIFFERENT pair must not reactivate it.
    await db.update(rpodEvents)
      .set({ status: "ended", endedAt, reopenCount: 0, lastReopenedAt: null, closedSpells: [] })
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
