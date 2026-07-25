import { db } from "@workspace/db";
import { obcObjects, obcLaunches, obcSyncLog } from "@workspace/db/schema";
import { desc, eq, and } from "drizzle-orm";
import { logger } from "../logger";
import type { SatcatEntry } from "../satcat";
import type { LaunchEntry } from "../launch";

const CACHE_TTL_MS = 10 * 60 * 1000; // in-memory catalog cache

interface CatalogCache {
  entries: SatcatEntry[];
  launchMap: Map<string, LaunchEntry>;
  loadedAt: number;
}

let cache: CatalogCache | null = null;
let inflight: Promise<CatalogCache> | null = null;

export function invalidateStore(): void {
  cache = null;
}

async function loadCatalog(): Promise<CatalogCache> {
  const t0 = Date.now();

  // Never serve a partial catalog: rows appear incrementally during the
  // initial sync (chunked upserts), so gate on a completed merge instead of
  // merely non-empty tables. After the first successful merge this check
  // always passes, because syncs upsert and never delete.
  const merged = await db
    .select({ id: obcSyncLog.id })
    .from(obcSyncLog)
    .where(and(eq(obcSyncLog.source, "merge"), eq(obcSyncLog.status, "success")))
    .limit(1);
  if (merged.length === 0) {
    throw new Error("OBC catalogue not ready — initial sync has not completed yet");
  }

  const [objects, launches] = await Promise.all([
    db.select().from(obcObjects),
    db.select().from(obcLaunches),
  ]);

  const entries: SatcatEntry[] = objects.map((o) => ({
    jcat: o.jcat ?? o.key,
    satno: o.norad,
    name: o.name,
    plName: o.plName,
    ldate: o.ldate,
    lv: o.lv,
    lvFamily: o.lvFamily,
    site: o.site,
    owner: o.owner,
    state: o.state,
    objectClass: o.objectClass,
    objType: o.objType,
    opOrbit: o.opOrbit,
    satState: o.satState,
    massKg: o.massKg,
    massEstimated: o.massEstimated,
    apogeeKm: o.apogeeKm,
    perigeeKm: o.perigeeKm,
    incDeg: o.incDeg,
    periodMin: null,
    decayDate: o.decayDate,
    gunterType: o.gunterType,
    gunterNation: o.gunterNation,
    gunterOperator: o.gunterOperator,
    gunterContractors: o.gunterContractors,
    gunterUrl: o.gunterUrl,
    gunterTitle: o.gunterTitle,
    gunterRetrievedAt: o.gunterRetrievedAt?.toISOString() ?? null,
  }));

  const launchMap = new Map<string, LaunchEntry>();
  for (const l of launches) {
    launchMap.set(l.launchTag, {
      launchTag: l.launchTag, lv: l.lv, lvFamily: l.lvFamily,
      site: l.site, ldate: l.ldate, orbital: l.orbital,
    });
  }

  logger.info(
    { objects: entries.length, launches: launchMap.size, ms: Date.now() - t0 },
    "obc-store: catalog loaded from DB",
  );
  return { entries, launchMap, loadedAt: Date.now() };
}

async function getCache(): Promise<CatalogCache> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS && cache.entries.length > 0) return cache;
  if (inflight) return inflight;
  inflight = loadCatalog()
    .then((c) => {
      // Keep serving the old cache if the DB is (still) empty
      if (c.entries.length === 0 && cache && cache.entries.length > 0) return cache;
      if (c.entries.length === 0) {
        // Defensive: merge logged success but tables are empty.
        throw new Error("OBC catalogue is empty — initial sync has not completed yet");
      }
      cache = c;
      return c;
    })
    .catch((err) => {
      if (cache) {
        logger.warn({ err }, "obc-store: DB load failed, serving stale cache");
        return cache;
      }
      throw err;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export async function getSatcatFromStore(): Promise<SatcatEntry[]> {
  return (await getCache()).entries;
}

export async function getLaunchMapFromStore(): Promise<Map<string, LaunchEntry>> {
  return (await getCache()).launchMap;
}

/** Seconds since the in-memory catalog was loaded from the DB; -1 if not loaded. */
export function getStoreCacheAge(): number {
  if (!cache) return -1;
  return Math.floor((Date.now() - cache.loadedAt) / 1000);
}

export interface ObcFreshness {
  gcatSyncedAt: string | null;
  spacetrackSyncedAt: string | null;
  mergeSyncedAt: string | null;
  gunterSyncedAt: string | null;
}

/** Latest successful sync per source, ISO timestamps. */
export async function getFreshness(): Promise<ObcFreshness> {
  const latest = async (source: string): Promise<string | null> => {
    const rows = await db
      .select({ finishedAt: obcSyncLog.finishedAt })
      .from(obcSyncLog)
      .where(and(eq(obcSyncLog.source, source), eq(obcSyncLog.status, "success")))
      .orderBy(desc(obcSyncLog.finishedAt))
      .limit(1);
    return rows[0]?.finishedAt?.toISOString() ?? null;
  };
  const [gcat, spacetrack, merge, gunter] = await Promise.all([
    latest("gcat"), latest("spacetrack"), latest("merge"), latest("gunter"),
  ]);
  return { gcatSyncedAt: gcat, spacetrackSyncedAt: spacetrack, mergeSyncedAt: merge, gunterSyncedAt: gunter };
}
