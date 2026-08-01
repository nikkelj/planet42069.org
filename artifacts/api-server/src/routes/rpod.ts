import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { rpodEvents, rpodEventMembers, obcTleHistory, obcSyncLog } from "@workspace/db/schema";
import { eq, desc, asc, inArray, sql, and, type SQL } from "drizzle-orm";
import { getSatcat } from "../lib/satcat";
import { getArchiveStatus } from "../lib/obc/tleArchive";
import { getTle } from "../lib/tle";

const router: IRouter = Router();

interface MemberInfo {
  norad: number;
  name: string | null;
  owner: string | null;
  state: string | null;
  objectClass: string | null;
  opOrbit: string | null;
  ldate: string | null;
  minRangeKm: number | null;
  relVelKmS: number | null;
}

async function catalogLookup(): Promise<Map<number, { name: string; owner: string | null; state: string | null; objectClass: string | null; opOrbit: string | null; ldate: string | null }>> {
  const map = new Map<number, { name: string; owner: string | null; state: string | null; objectClass: string | null; opOrbit: string | null; ldate: string | null }>();
  try {
    const entries = await getSatcat();
    for (const e of entries) {
      if (e.satno != null) {
        map.set(e.satno, {
          name: e.name, owner: e.owner, state: e.state,
          objectClass: e.objectClass, opOrbit: e.opOrbit, ldate: e.ldate,
        });
      }
    }
  } catch {
    // catalog not ready — members degrade to NORAD-only rows
  }
  return map;
}

// ── list ────────────────────────────────────────────────────────────────────
router.get("/rpod/events", async (req, res): Promise<void> => {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const status = req.query.status ? String(req.query.status) : undefined;
  const kind = req.query.kind ? String(req.query.kind) : undefined;
  const sortField = String(req.query.sort ?? "tca");
  const order = String(req.query.order ?? "desc") === "asc" ? asc : desc;

  const sortCol =
    sortField === "minRangeKm" ? rpodEvents.minRangeKm :
    sortField === "relVelKmS" ? rpodEvents.relVelKmS :
    sortField === "memberCount" ? rpodEvents.memberCount :
    rpodEvents.tca;

  const conditions: SQL[] = [];
  if (status === "active" || status === "stale" || status === "ended") conditions.push(eq(rpodEvents.status, status));
  if (kind === "conjunction" || kind === "coplanar") conditions.push(eq(rpodEvents.kind, kind));
  const where: SQL | undefined = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(rpodEvents).where(where).orderBy(order(sortCol), desc(rpodEvents.id))
      .limit(limit).offset((page - 1) * limit),
    db.select({ total: sql<number>`count(*)::int` }).from(rpodEvents).where(where),
  ]);

  const memberRows = rows.length
    ? await db.select().from(rpodEventMembers).where(inArray(rpodEventMembers.eventId, rows.map((r) => r.id)))
    : [];
  const lookup = await catalogLookup();

  const byEvent = new Map<number, MemberInfo[]>();
  for (const m of memberRows) {
    const meta = lookup.get(m.norad);
    const arr = byEvent.get(m.eventId) ?? [];
    arr.push({
      norad: m.norad,
      name: meta?.name ?? null,
      owner: meta?.owner ?? null,
      state: meta?.state ?? null,
      objectClass: meta?.objectClass ?? null,
      opOrbit: meta?.opOrbit ?? null,
      ldate: meta?.ldate ?? null,
      minRangeKm: m.minRangeKm,
      relVelKmS: m.relVelKmS,
    });
    byEvent.set(m.eventId, arr);
  }

  res.json({
    data: rows.map((r) => ({
      id: r.id,
      status: r.status,
      kind: r.kind,
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd.toISOString(),
      tca: r.tca.toISOString(),
      minRangeKm: r.minRangeKm,
      relVelKmS: r.relVelKmS,
      memberCount: r.memberCount,
      widenedScan: r.widenedScan,
      firstDetectedAt: r.firstDetectedAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      updatedAt: r.updatedAt.toISOString(),
      members: (byEvent.get(r.id) ?? []).sort((a, b) => a.norad - b.norad),
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

// ── detail (with TLEs for the 3D plot) ─────────────────────────────────────
router.get("/rpod/events/:id", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid event id" }); return; }
  const [row] = await db.select().from(rpodEvents).where(eq(rpodEvents.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "event not found" }); return; }

  const memberRows = await db.select().from(rpodEventMembers).where(eq(rpodEventMembers.eventId, id));
  const lookup = await catalogLookup();

  // Latest archived elset per member for orbit plotting (fall back to the
  // live per-object TLE cache when the archive has none).
  const members = await Promise.all(memberRows.map(async (m) => {
    const meta = lookup.get(m.norad);
    const [archived] = await db
      .select()
      .from(obcTleHistory)
      .where(eq(obcTleHistory.norad, m.norad))
      .orderBy(desc(obcTleHistory.epoch))
      .limit(1);

    let tle = null;
    if (archived) {
      tle = {
        line1: archived.line1, line2: archived.line2,
        epoch: archived.epoch.toISOString(),
        incDeg: archived.incDeg, raanDeg: archived.raanDeg, eccentricity: archived.eccentricity,
        argPerigeeDeg: archived.argPerigeeDeg, meanAnomalyDeg: archived.meanAnomalyDeg,
        meanMotionRevPerDay: archived.meanMotionRevPerDay,
      };
    } else {
      const live = await getTle(m.norad).catch(() => null);
      if (live) {
        tle = {
          line1: live.line1, line2: live.line2, epoch: live.epoch,
          incDeg: live.incDeg, raanDeg: live.raanDeg, eccentricity: live.eccentricity,
          argPerigeeDeg: live.argPerigeeDeg, meanAnomalyDeg: live.meanAnomalyDeg,
          meanMotionRevPerDay: live.meanMotionRevPerDay,
        };
      }
    }
    return {
      norad: m.norad,
      name: meta?.name ?? null,
      owner: meta?.owner ?? null,
      state: meta?.state ?? null,
      objectClass: meta?.objectClass ?? null,
      opOrbit: meta?.opOrbit ?? null,
      ldate: meta?.ldate ?? null,
      minRangeKm: m.minRangeKm,
      relVelKmS: m.relVelKmS,
      tle,
    };
  }));

  res.json({
    id: row.id,
    status: row.status,
    kind: row.kind,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    tca: row.tca.toISOString(),
    minRangeKm: row.minRangeKm,
    relVelKmS: row.relVelKmS,
    memberCount: row.memberCount,
    widenedScan: row.widenedScan,
    firstDetectedAt: row.firstDetectedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    members: members.sort((a, b) => a.norad - b.norad),
  });
});

// ── archive status ─────────────────────────────────────────────────────────
router.get("/rpod/status", async (_req, res): Promise<void> => {
  const [archive, [lastScan]] = await Promise.all([
    getArchiveStatus(),
    db.select({ finishedAt: obcSyncLog.finishedAt, status: obcSyncLog.status, rowCount: obcSyncLog.rowCount })
      .from(obcSyncLog)
      .where(eq(obcSyncLog.source, "rpod-scan"))
      .orderBy(desc(obcSyncLog.finishedAt))
      .limit(1),
  ]);
  const [{ active }] = await db
    .select({ active: sql<number>`count(*)::int` })
    .from(rpodEvents)
    .where(eq(rpodEvents.status, "active"));
  res.json({
    archive,
    activeEvents: active,
    lastScanAt: lastScan ? lastScan.finishedAt.toISOString() : null,
    lastScanStatus: lastScan?.status ?? null,
    lastScanEvents: lastScan?.rowCount ?? null,
  });
});

export default router;
