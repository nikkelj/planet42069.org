import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  serial,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * OBC catalogue — the Bureau's merged satellite catalog.
 * One row per known object, merged from GCAT (physical data, ownership)
 * and space-track.org (recency, decay). Keyed by a stable text key:
 * GCAT JCAT id when known (e.g. "S00001"), otherwise "ST<norad>" for
 * objects space-track knows but GCAT has not cataloged yet.
 */
export const obcObjects = pgTable(
  "obc_objects",
  {
    key: text("key").primaryKey(),
    jcat: text("jcat"),
    norad: integer("norad"), // NORAD catalog number; int is Alpha-5-safe (>= 100000 fine)
    intlDes: text("intl_des"), // international designator e.g. "2026-160A"
    name: text("name").notNull(),
    plName: text("pl_name"),
    ldate: text("ldate"), // ISO "YYYY-MM-DD"
    lv: text("lv"),
    lvFamily: text("lv_family"),
    site: text("site"),
    owner: text("owner"),
    state: text("state"),
    objectClass: text("object_class"), // P/R/D/C...
    objType: text("obj_type"),
    opOrbit: text("op_orbit"),
    satState: text("sat_state"), // GCAT status: O/OX/D/R...
    massKg: real("mass_kg"),
    massEstimated: boolean("mass_estimated").notNull().default(false),
    massEstMethod: text("mass_est_method"), // e.g. "name-family:STARLINK", "type-median:R"
    apogeeKm: real("apogee_km"),
    perigeeKm: real("perigee_km"),
    incDeg: real("inc_deg"),
    decayDate: text("decay_date"),
    inGcat: boolean("in_gcat").notNull().default(false),
    inSpacetrack: boolean("in_spacetrack").notNull().default(false),
    // ── Gunter's Space Page annotations (gap-fill only; never overrides
    //    GCAT/space-track identity or physics fields). Matched by COSPAR id
    //    (intl_des). Enough is stored to reproduce Gunter's own citation
    //    format: Krebs, Gunter D. "<title>". Gunter's Space Page. Retrieved
    //    <date>, from <url>.
    gunterType: text("gunter_type"),          // "Type / Application", e.g. "Communication"
    gunterUrl: text("gunter_url"),            // full dossier URL on space.skyrocket.de
    gunterTitle: text("gunter_title"),        // dossier page title, for citations
    gunterRetrievedAt: timestamp("gunter_retrieved_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("obc_objects_norad_idx").on(t.norad),
    index("obc_objects_class_idx").on(t.objectClass),
  ],
);

/** GCAT launch table mirror — needed for cadence analytics without live fetches. */
export const obcLaunches = pgTable("obc_launches", {
  launchTag: text("launch_tag").primaryKey(),
  lv: text("lv"),
  lvFamily: text("lv_family"),
  site: text("site"),
  ldate: text("ldate"),
  orbital: boolean("orbital").notNull().default(false),
});

/** One row per source per sync attempt. */
export const obcSyncLog = pgTable(
  "obc_sync_log",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(), // "gcat" | "spacetrack" | "merge"
    status: text("status").notNull(), // "success" | "error"
    rowCount: integer("row_count"),
    error: text("error"),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull().defaultNow(),
  },
  (t) => [index("obc_sync_log_source_idx").on(t.source, t.finishedAt)],
);

/**
 * Gunter's Space Page crawl state — one row per page we know about.
 * kind "chron" rows are yearly chronology indexes (discovery only);
 * kind "dossier" rows are doc_sdat satellite pages carrying the facts
 * table and per-satellite COSPAR list used for fusion.
 */
export const obcGunterPages = pgTable(
  "obc_gunter_pages",
  {
    url: text("url").primaryKey(),
    kind: text("kind").notNull(),              // "chron" | "dossier"
    status: text("status").notNull().default("pending"), // "pending" | "ok" | "error"
    title: text("title"),
    gunterType: text("gunter_type"),           // "Type / Application"
    nation: text("nation"),
    operator: text("operator"),
    contractors: text("contractors"),
    cosparIds: jsonb("cospar_ids").$type<string[]>(), // COSPAR ids listed on the page
    error: text("error"),
    discoveredAt: timestamp("discovered_at").notNull().defaultNow(),
    retrievedAt: timestamp("retrieved_at"),
  },
  (t) => [index("obc_gunter_pages_status_idx").on(t.kind, t.status)],
);

export const insertObcObjectSchema = createInsertSchema(obcObjects);
export type InsertObcObject = z.infer<typeof insertObcObjectSchema>;
export type ObcObject = typeof obcObjects.$inferSelect;
export type ObcLaunch = typeof obcLaunches.$inferSelect;
export type ObcSyncLogRow = typeof obcSyncLog.$inferSelect;
export type ObcGunterPage = typeof obcGunterPages.$inferSelect;
