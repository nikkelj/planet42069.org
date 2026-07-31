import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  serial,
  uniqueIndex,
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
    gunterNation: text("gunter_nation"),      // "Nation" fact, e.g. "USA"
    gunterOperator: text("gunter_operator"),  // "Operator" fact, e.g. "SpaceX"
    gunterContractors: text("gunter_contractors"), // "Contractors" fact (comma-joined)
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

/**
 * TLE history archive — sampled element sets from space-track (gp for the
 * recent feed, gp_history for the backward-walking backfill). Sampling keeps
 * a bounded number of elsets per object per day, so epoch-range queries stay
 * fast over years of history. Both raw TLE lines and parsed mean elements
 * are stored so screening never needs to re-parse.
 */
export const obcTleHistory = pgTable(
  "obc_tle_history",
  {
    id: serial("id").primaryKey(),
    norad: integer("norad").notNull(),
    epoch: timestamp("epoch").notNull(),
    line1: text("line1").notNull(),
    line2: text("line2").notNull(),
    incDeg: real("inc_deg").notNull(),
    raanDeg: real("raan_deg").notNull(),
    eccentricity: real("eccentricity").notNull(),
    argPerigeeDeg: real("arg_perigee_deg").notNull(),
    meanAnomalyDeg: real("mean_anomaly_deg").notNull(),
    meanMotionRevPerDay: real("mean_motion_rev_per_day").notNull(),
    bstar: real("bstar"),
    source: text("source").notNull(), // "recent" | "backfill"
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("obc_tle_history_norad_epoch_uq").on(t.norad, t.epoch),
    index("obc_tle_history_epoch_idx").on(t.epoch),
    index("obc_tle_history_norad_idx").on(t.norad, t.epoch),
  ],
);

/** Small key/value state store for background workers (cursors, watermarks). */
export const obcWorkerState = pgTable("obc_worker_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * RPOD (rendezvous & proximity operations) events flagged by the screener.
 * An event is a CLUSTER of close-approach pairs, so it can involve more than
 * two spacecraft (members live in rpod_event_members).
 */
export const rpodEvents = pgTable(
  "rpod_events",
  {
    id: serial("id").primaryKey(),
    status: text("status").notNull().default("active"), // "active" | "stale"
    /**
     * "conjunction": a discrete predicted close approach (bubble closes).
     * "coplanar": long-duration co-aligned shadowing — same plane and shell,
     * slowly drifting in phase; these encounters last weeks or months.
     */
    kind: text("kind").notNull().default("conjunction"),
    windowStart: timestamp("window_start").notNull(),
    windowEnd: timestamp("window_end").notNull(),
    tca: timestamp("tca").notNull(), // time of (predicted) closest approach
    minRangeKm: real("min_range_km").notNull(),
    relVelKmS: real("rel_vel_km_s").notNull(),
    memberCount: integer("member_count").notNull().default(2),
    widenedScan: boolean("widened_scan").notNull().default(false),
    screeningMeta: jsonb("screening_meta").$type<Record<string, unknown>>(),
    firstDetectedAt: timestamp("first_detected_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("rpod_events_tca_idx").on(t.tca), index("rpod_events_status_idx").on(t.status, t.tca)],
);

export const rpodEventMembers = pgTable(
  "rpod_event_members",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id").notNull().references(() => rpodEvents.id, { onDelete: "cascade" }),
    norad: integer("norad").notNull(),
    /** Min pairwise range (km) this member reached vs any other member. */
    minRangeKm: real("min_range_km"),
    relVelKmS: real("rel_vel_km_s"),
  },
  (t) => [
    uniqueIndex("rpod_event_members_uq").on(t.eventId, t.norad),
    index("rpod_event_members_norad_idx").on(t.norad),
  ],
);

export type ObcTleHistoryRow = typeof obcTleHistory.$inferSelect;
export type InsertObcTleHistory = typeof obcTleHistory.$inferInsert;
export type RpodEventRow = typeof rpodEvents.$inferSelect;
export type RpodEventMemberRow = typeof rpodEventMembers.$inferSelect;

export const insertObcObjectSchema = createInsertSchema(obcObjects);
export type InsertObcObject = z.infer<typeof insertObcObjectSchema>;
export type ObcObject = typeof obcObjects.$inferSelect;
export type ObcLaunch = typeof obcLaunches.$inferSelect;
export type ObcSyncLogRow = typeof obcSyncLog.$inferSelect;
export type ObcGunterPage = typeof obcGunterPages.$inferSelect;
