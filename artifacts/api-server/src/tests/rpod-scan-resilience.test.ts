/**
 * Regression tests for the 2026-08-25 RPOD scan/status outage:
 *  - GET /api/rpod/status must not seq-scan obc_tle_history (live timed out
 *    at 25s / 0 bytes; a retry took 59s while /rpod/events was 0.26s)
 *  - lastScanError is returned so ops can see why lastScanStatus=error
 *    without logs (obc_sync_log.error was stored but never selected)
 *  - persistEvents continues after one event's transaction fails, instead
 *    of marking the whole hourly scan as error
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { db, pool } from "@workspace/db";
import { rpodEvents, rpodEventMembers } from "@workspace/db/schema";
import { inArray, eq } from "drizzle-orm";
import type { Server } from "node:http";
import app from "../app";
import { persistEvents, formatRpodScanStatus } from "../lib/rpod/scan";
import { getArchiveStatus, clearArchiveStatusCache } from "../lib/obc/tleArchive";
import type { ClusteredEvent } from "../lib/rpod/screen";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const GOOD_PAIR = [99999401, 99999402];
/** Beyond PostgreSQL integer (32-bit); member insert must fail the transaction. */
const OVERFLOW_PAIR = [3_000_000_000, 3_000_000_001];

function makeCluster(members: number[], nowMs: number): ClusteredEvent {
  const [a, b] = members;
  return {
    members,
    pairs: [{ a, b, minRangeKm: 8.5, relVelKmS: 0.04, tcaMs: nowMs }],
    minRangeKm: 8.5, relVelKmS: 0.04, tcaMs: nowMs,
    windowStartMs: nowMs - 3600_000,
    windowEndMs: nowMs + 3600_000,
    hitCap: false,
  };
}

async function dbReachable(): Promise<boolean> {
  if (!process.env["DATABASE_URL"]) return false;
  try {
    const client = await pool.connect();
    client.release();
    return true;
  } catch (err) {
    console.log(`  (database unreachable: ${String(err).slice(0, 120)})`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log("formatRpodScanStatus exposes the stored error reason");
  {
    const errRow = {
      finishedAt: new Date("2026-08-25T14:23:49.275Z"),
      status: "error",
      rowCount: null,
      error: "error: timeout exceeded when trying to connect",
    };
    const mapped = formatRpodScanStatus(errRow);
    check("error status includes lastScanError", mapped.lastScanError === errRow.error);
    check("error status keeps lastScanEvents null", mapped.lastScanEvents === null);
    check("error status timestamp is ISO", mapped.lastScanAt === "2026-08-25T14:23:49.275Z");
    const ok = formatRpodScanStatus({
      finishedAt: new Date("2026-08-25T13:21:27.000Z"),
      status: "success",
      rowCount: 6,
      error: null,
    });
    check("success status has null lastScanError", ok.lastScanError === null);
    check("missing row → all nulls", formatRpodScanStatus(null).lastScanStatus === null);
  }

  if (!(await dbReachable())) {
    console.log("Skipping persist/status DB checks (DATABASE_URL not reachable)");
    if (failures > 0) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nAll RPOD scan-resilience checks passed");
    return;
  }

  const nowMs = Date.now();
  const cleanupIds: number[] = [];
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("no ephemeral port");
  const base = `http://127.0.0.1:${addr.port}/api`;

  try {
    console.log("persistEvents: one bad event must not abort the rest");
    {
      let threw = false;
      let result: Awaited<ReturnType<typeof persistEvents>> | null = null;
      try {
        result = await persistEvents(
          [makeCluster(OVERFLOW_PAIR, nowMs), makeCluster(GOOD_PAIR, nowMs)],
          "conjunction",
        );
      } catch (err) {
        threw = true;
        check("persistEvents did not throw on one bad event", false, String(err));
      }
      check("persistEvents did not throw on one bad event", !threw);
      check("bad event is recorded in errors (not silent)", (result?.errors.length ?? 0) >= 1,
        JSON.stringify(result?.errors));
      check("good event still inserted", result?.inserted.length === 1,
        JSON.stringify(result?.inserted));
      if (result?.inserted[0]) cleanupIds.push(result.inserted[0].eventId);
      if (result?.inserted[0]) {
        const members = await db.select().from(rpodEventMembers)
          .where(eq(rpodEventMembers.eventId, result.inserted[0].eventId));
        check("good event kept both members", members.length === 2, JSON.stringify(members.map((m) => m.norad)));
      }
    }

    console.log("GET /rpod/status is fast and returns lastScanError");
    {
      clearArchiveStatusCache();
      const t0 = Date.now();
      const archive = await getArchiveStatus();
      const archiveMs = Date.now() - t0;
      check("getArchiveStatus returns in <8s (no 5M-row seq scan)", archiveMs < 8_000, `took ${archiveMs}ms`);
      check("archive status has numeric counts", Number.isFinite(archive.totalRows) && Number.isFinite(archive.objects));
      check("newestEpoch is ISO or null", archive.newestEpoch == null || !Number.isNaN(Date.parse(archive.newestEpoch)));

      const t1 = Date.now();
      const res = await fetch(`${base}/rpod/status`);
      const statusMs = Date.now() - t1;
      check("GET /rpod/status responds 200", res.ok, String(res.status));
      check("GET /rpod/status returns in <8s", statusMs < 8_000, `took ${statusMs}ms`);
      const body = (await res.json()) as {
        archive: { totalRows: number; newestEpoch: string | null };
        activeEvents: number;
        lastScanAt: string | null;
        lastScanStatus: string | null;
        lastScanEvents: number | null;
        lastScanError: string | null;
      };
      check("status payload includes lastScanError key", "lastScanError" in body);
      check("lastScanError is string or null", body.lastScanError === null || typeof body.lastScanError === "string");
      check("activeEvents is a number", Number.isFinite(body.activeEvents));
    }
  } finally {
    if (cleanupIds.length) await db.delete(rpodEvents).where(inArray(rpodEvents.id, cleanupIds));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll RPOD scan-resilience checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
