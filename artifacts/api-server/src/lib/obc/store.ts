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

/**
 * Thrown when a request touches the catalog before the background load has
 * finished. Callers should convert this to an HTTP 503 rather than waiting.
 */
export class CatalogLoadingError extends Error {
  constructor() {
    super("OBC catalogue is still loading — please retry in a few seconds");
    this.name = "CatalogLoadingError";
  }
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
    launchTag: o.intlDes?.match(/^(\d{4}-[A-Z0-9]\d{2})/i)?.[1]?.toUpperCase() ?? null,
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

/**
 * Start a background load (or TTL-refresh) of the catalog if one isn't
 * already running.  Does NOT wait for the result — callers that need the
 * data should call getCache() which will either serve the (now-warm or
 * stale) cache or throw CatalogLoadingError if no cache exists yet.
 */
export function primeCache(): void {
  if (inflight) return; // load already in progress — don't start a second one
  const p = loadCatalog()
    .then((c) => {
      if (c.entries.length === 0 && cache && cache.entries.length > 0) return cache;
      if (c.entries.length === 0) {
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
      logger.error({ err }, "obc-store: catalog load failed with no stale cache to fall back on");
      throw err;
    })
    .finally(() => { inflight = null; });
  inflight = p;
  // Prevent an unhandled-rejection warning when the load fails and nobody is
  // currently awaiting `inflight` (e.g. on a failed cold-boot load).  Errors
  // are already logged in the .catch above; getCache() surfaces the failure
  // as a CatalogLoadingError to HTTP callers.
  p.catch(() => undefined);
}

async function getCache(): Promise<CatalogCache> {
  const now = Date.now();
  // Serve the in-memory cache if it's still fresh.
  if (cache && now - cache.loadedAt < CACHE_TTL_MS && cache.entries.length > 0) return cache;

  // If there's no in-flight load yet, start one now (TTL-refresh path).
  if (!inflight) {
    primeCache();
  }

  // If we have a stale-but-non-empty cache, serve it rather than waiting for
  // the refresh to finish (the refresh will update `cache` when it lands).
  if (cache && cache.entries.length > 0) return cache;

  // No cache at all yet — the server just started and the background load is
  // still running. Throw immediately so the caller can return 503 rather than
  // hanging until the full 70 k-row load completes (up to ~4 minutes).
  if (inflight) {
    throw new CatalogLoadingError();
  }

  // inflight was cleared between the primeCache() call and here (load failed
  // before we read inflight). Surface the error.
  throw new Error("OBC catalogue failed to load — check server logs");
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

// ── Test helpers (never call in production code) ──────────────────────────

/** Reset all in-process state.  Unit tests only. */
export function _resetStoreForTest(): void {
  cache = null;
  inflight = null;
}

/** Inject a pre-built cache snapshot.  Unit tests only. */
export function _setCacheForTest(c: CatalogCache | null): void {
  cache = c;
}

/** Inject a pending inflight promise.  Unit tests only. */
export function _setInflightForTest(p: Promise<CatalogCache> | null): void {
  inflight = p;
}

/**
 * Await the current in-flight catalog load, if any.  Unit tests only.
 * Call after invalidateStore() + primeCache() to ensure the cache is fully
 * populated before the first request that needs name-based catalog lookups.
 */
export async function _awaitLoadForTest(): Promise<void> {
  if (inflight) await inflight;
}

export type { CatalogCache };

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
