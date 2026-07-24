import { db } from "@workspace/db";
import { obcObjects, obcLaunches, obcSyncLog, type InsertObcObject } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { fetchGcatSatcatTsv, fetchGcatLaunchTsv } from "./gcat";
import { fetchSpacetrackSatcat, type SpacetrackRow } from "./spacetrack";
import { parseTsv, type SatcatRawEntry } from "../satcat";
import { parseLaunchTsv, type LaunchEntry } from "../launch";
import { buildMassModel, type EstimatableRow } from "./estimate";
import { invalidateStore } from "./store";

const CHUNK = 400;

let syncInFlight: Promise<void> | null = null;

async function logSync(source: string, status: "success" | "error", startedAt: Date, rowCount: number | null, error?: string) {
  try {
    await db.insert(obcSyncLog).values({
      source, status, rowCount,
      error: error ? error.slice(0, 2000) : null,
      startedAt,
    });
  } catch (err) {
    logger.error({ err }, "obc-sync: failed to write sync log");
  }
}

function stClassToGcat(objType: string | null): string {
  switch ((objType ?? "").toUpperCase()) {
    case "PAYLOAD": return "P";
    case "ROCKET BODY": return "R";
    case "DEBRIS": return "D";
    default: return "U";
  }
}

function stNum(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Per-field precedence rules for the upsert
 * ─────────────────────────────────────────
 * Rows are keyed per source: GCAT rows use the JCAT key, space-track-only
 * rows use "ST<norad>", so a conflict is always "same source family updating
 * its own row" — except that GCAT rows already carry space-track gap-fill
 * values merged in at row-build time (apogee/perigee/inc/decay/intlDes).
 *
 * Authoritative-source rules:
 *  - Identity/classification fields (jcat, norad, name, plName, objectClass,
 *    objType) and mass fields: always taken from the incoming row (the
 *    incoming row is rebuilt from scratch each sync, including estimates).
 *  - Lifecycle/orbit/attribution fields (intlDes, ldate, lv, lvFamily, site,
 *    owner, state, opOrbit, satState, apogee, perigee, inc, decayDate):
 *      * If the incoming row is GCAT-sourced (excluded.in_gcat), GCAT is
 *        authoritative for that row: the incoming value OVERWRITES the stored
 *        one, including clearing it back to NULL when upstream corrects a
 *        wrong value. (Space-track gap-fill already happened at merge time,
 *        so a NULL here means neither source currently asserts a value.)
 *      * If the incoming row is space-track-only but the STORED row is also
 *        space-track-only (not in_gcat), space-track is authoritative for its
 *        own rows and likewise overwrites/clears.
 *      * Otherwise (space-track row landing on a GCAT-enriched row — cannot
 *        happen with current keying, kept for safety): space-track only fills
 *        gaps via coalesce and never clears GCAT-provided values.
 */
const AUTHORITATIVE = sql`(excluded.in_gcat or not ${obcObjects.inGcat})`;

function precedence(column: string) {
  const col = sql.raw(`excluded.${column}`);
  const existing = sql.raw(`obc_objects.${column}`);
  return sql`case when ${AUTHORITATIVE} then ${col} else coalesce(${col}, ${existing}) end`;
}

export async function upsertObjects(rows: InsertObcObject[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db
      .insert(obcObjects)
      .values(chunk)
      .onConflictDoUpdate({
        target: obcObjects.key,
        set: {
          jcat: sql`excluded.jcat`,
          norad: sql`excluded.norad`,
          intlDes: precedence("intl_des"),
          name: sql`excluded.name`,
          plName: sql`excluded.pl_name`,
          ldate: precedence("ldate"),
          lv: precedence("lv"),
          lvFamily: precedence("lv_family"),
          site: precedence("site"),
          owner: precedence("owner"),
          state: precedence("state"),
          objectClass: sql`excluded.object_class`,
          objType: sql`excluded.obj_type`,
          opOrbit: precedence("op_orbit"),
          satState: precedence("sat_state"),
          massKg: sql`excluded.mass_kg`,
          massEstimated: sql`excluded.mass_estimated`,
          massEstMethod: sql`excluded.mass_est_method`,
          apogeeKm: precedence("apogee_km"),
          perigeeKm: precedence("perigee_km"),
          incDeg: precedence("inc_deg"),
          decayDate: precedence("decay_date"),
          inGcat: sql`${obcObjects.inGcat} or excluded.in_gcat`,
          inSpacetrack: sql`${obcObjects.inSpacetrack} or excluded.in_spacetrack`,
          updatedAt: sql`now()`,
        },
      });
  }
}

/**
 * Full sync: GCAT satcat+launch, space-track satcat, merge, estimate, upsert.
 * Each source is isolated — one failing does not abort the other.
 * Concurrent callers share the same in-flight run.
 */
export function runObcSync(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function doSync(): Promise<void> {
  logger.info("obc-sync: starting");

  // ── 1. GCAT ───────────────────────────────────────────────────────────
  let gcatEntries: SatcatRawEntry[] | null = null;
  let launchMap: Map<string, LaunchEntry> | null = null;
  {
    const started = new Date();
    try {
      const [satTsv, launchTsv] = await Promise.all([fetchGcatSatcatTsv(), fetchGcatLaunchTsv()]);
      launchMap = parseLaunchTsv(launchTsv);
      gcatEntries = parseTsv(satTsv);
      // Enrich lv/site from launch map
      for (const e of gcatEntries) {
        const l = e.launchTag ? launchMap.get(e.launchTag) : undefined;
        if (l) { e.lv = l.lv; e.lvFamily = l.lvFamily; e.site = l.site; }
      }
      // Persist launches
      const launchRows = Array.from(launchMap.values());
      for (let i = 0; i < launchRows.length; i += CHUNK) {
        const chunk = launchRows.slice(i, i + CHUNK).map((l) => ({
          launchTag: l.launchTag, lv: l.lv, lvFamily: l.lvFamily,
          site: l.site, ldate: l.ldate, orbital: l.orbital,
        }));
        await db.insert(obcLaunches).values(chunk).onConflictDoUpdate({
          target: obcLaunches.launchTag,
          set: {
            lv: sql`excluded.lv`, lvFamily: sql`excluded.lv_family`,
            site: sql`excluded.site`, ldate: sql`excluded.ldate`,
            orbital: sql`excluded.orbital`,
          },
        });
      }
      await logSync("gcat", "success", started, gcatEntries.length);
      logger.info({ objects: gcatEntries.length, launches: launchMap.size }, "obc-sync: gcat ok");
    } catch (err) {
      await logSync("gcat", "error", started, null, String(err));
      logger.warn({ err }, "obc-sync: gcat failed");
    }
  }

  // ── 2. space-track ────────────────────────────────────────────────────
  let stRows: SpacetrackRow[] | null = null;
  {
    const started = new Date();
    try {
      stRows = await fetchSpacetrackSatcat();
      await logSync("spacetrack", "success", started, stRows.length);
    } catch (err) {
      await logSync("spacetrack", "error", started, null, String(err));
      logger.warn({ err }, "obc-sync: spacetrack failed");
    }
  }

  if (!gcatEntries && !stRows) {
    throw new Error("obc-sync: both sources failed; catalog unchanged");
  }

  // ── 3. merge ──────────────────────────────────────────────────────────
  const started = new Date();
  const rows: InsertObcObject[] = [];
  const gcatNorads = new Set<number>();
  const stByNorad = new Map<number, SpacetrackRow>();
  if (stRows) {
    for (const r of stRows) {
      const n = parseInt(r.NORAD_CAT_ID, 10);
      if (Number.isFinite(n)) stByNorad.set(n, r);
    }
  }

  if (gcatEntries) {
    for (const e of gcatEntries) {
      if (e.satno != null) gcatNorads.add(e.satno);
      const st = e.satno != null ? stByNorad.get(e.satno) : undefined;
      rows.push({
        key: e.jcat,
        jcat: e.jcat,
        norad: e.satno,
        intlDes: st?.OBJECT_ID ?? null,
        name: e.name,
        plName: e.plName,
        ldate: e.ldate,
        lv: e.lv, lvFamily: e.lvFamily, site: e.site,
        owner: e.owner, state: e.state,
        objectClass: e.objectClass, objType: e.objType,
        opOrbit: e.opOrbit, satState: e.satState,
        massKg: e.massKg, massEstimated: false, massEstMethod: null,
        apogeeKm: e.apogeeKm ?? stNum(st?.APOGEE ?? null),
        perigeeKm: e.perigeeKm ?? stNum(st?.PERIGEE ?? null),
        incDeg: e.incDeg ?? stNum(st?.INCLINATION ?? null),
        decayDate: e.decayDate ?? (st?.DECAY || null),
        inGcat: true,
        inSpacetrack: st != null,
      });
    }
  } else {
    // GCAT fetch failed — remember which norads we already have so we
    // don't duplicate them as ST rows.
    const existing = await db.select({ norad: obcObjects.norad }).from(obcObjects);
    for (const r of existing) if (r.norad != null) gcatNorads.add(r.norad);
  }

  // space-track-only objects (GCAT hasn't cataloged them yet)
  if (stRows) {
    for (const [norad, st] of stByNorad) {
      if (gcatNorads.has(norad)) continue;
      const cls = stClassToGcat(st.OBJECT_TYPE);
      rows.push({
        key: `ST${norad}`,
        jcat: null,
        norad,
        intlDes: st.OBJECT_ID,
        name: st.OBJECT_NAME ?? `OBJECT ${norad}`,
        plName: null,
        ldate: st.LAUNCH || null,
        lv: null, lvFamily: null, site: st.SITE || null,
        owner: null, state: st.COUNTRY || null,
        objectClass: cls, objType: cls,
        opOrbit: null,
        satState: st.DECAY ? "D" : (st.CURRENT === "Y" ? "O?" : null),
        massKg: null, massEstimated: false, massEstMethod: null,
        apogeeKm: stNum(st.APOGEE),
        perigeeKm: stNum(st.PERIGEE),
        incDeg: stNum(st.INCLINATION),
        decayDate: st.DECAY || null,
        inGcat: false,
        inSpacetrack: true,
      });
    }
  }

  // ── 4. mass estimation ────────────────────────────────────────────────
  const modelSource: EstimatableRow[] = gcatEntries
    ? gcatEntries.map((e) => ({
        name: e.name, objectClass: e.objectClass, lvFamily: e.lvFamily,
        massKg: e.massKg, massEstimated: false,
      }))
    : (await db
        .select({
          name: obcObjects.name, objectClass: obcObjects.objectClass,
          lvFamily: obcObjects.lvFamily, massKg: obcObjects.massKg,
          massEstimated: obcObjects.massEstimated,
        })
        .from(obcObjects));
  const model = buildMassModel(modelSource);

  let estimated = 0;
  for (const r of rows) {
    if (r.massKg != null && r.massKg > 0) continue;
    const est = model.estimate({
      name: r.name, objectClass: r.objectClass ?? null,
      lvFamily: r.lvFamily ?? null, massKg: null, massEstimated: false,
    });
    if (est) {
      r.massKg = Math.round(est.massKg * 10) / 10;
      r.massEstimated = true;
      r.massEstMethod = est.method;
      estimated += 1;
    }
  }

  try {
    await upsertObjects(rows);
    // Reconcile identity transitions: an object first seen via space-track
    // (key "ST<norad>") that GCAT has since catalogued now exists twice —
    // drop the ST-keyed duplicate so analytics never double-count it.
    await db.execute(sql`
      DELETE FROM obc_objects a
      WHERE a.jcat IS NULL
        AND a.norad IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM obc_objects b
          WHERE b.norad = a.norad AND b.jcat IS NOT NULL
        )
    `);
    await logSync("merge", "success", started, rows.length);
    logger.info({ rows: rows.length, estimated }, "obc-sync: merge complete");
  } catch (err) {
    await logSync("merge", "error", started, null, String(err));
    throw err;
  }

  invalidateStore();
}
