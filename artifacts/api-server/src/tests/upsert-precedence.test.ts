/**
 * Regression test for the per-field precedence rules in upsertObjects
 * (artifacts/api-server/src/lib/obc/sync.ts).
 *
 * Rules under test:
 *  1. GCAT is authoritative for its own rows: an incoming GCAT row may
 *     OVERWRITE and even CLEAR (set NULL) lifecycle fields like decay_date
 *     and owner on the stored row.
 *  2. space-track is authoritative for its own ST-keyed rows: an incoming
 *     ST row may likewise overwrite/clear on a stored ST-only row.
 *  3. A space-track row landing on a GCAT-enriched row only gap-fills via
 *     coalesce and never clears GCAT-provided values.
 *
 * Uses temporary keys (TEST-UPSERT-*) against the dev database and always
 * cleans up after itself. Run with: pnpm --filter @workspace/api-server run test:upsert
 */
import { db, pool } from "@workspace/db";
import { obcObjects, type InsertObcObject } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import { upsertObjects } from "../lib/obc/sync";

const K_GCAT = "TEST-UPSERT-GCAT";
const K_ST = "STTEST-UPSERT-9999901"; // ST-style key, test-safe
const K_GAPFILL = "TEST-UPSERT-GAPFILL";
const KEYS = [K_GCAT, K_ST, K_GAPFILL];

function baseRow(key: string, over: Partial<InsertObcObject> = {}): InsertObcObject {
  return {
    key,
    jcat: null,
    norad: null,
    intlDes: null,
    name: `TEST OBJECT ${key}`,
    plName: null,
    ldate: null,
    lv: null,
    lvFamily: null,
    site: null,
    owner: null,
    state: null,
    objectClass: "P",
    objType: "P",
    opOrbit: null,
    satState: null,
    massKg: null,
    massEstimated: false,
    massEstMethod: null,
    apogeeKm: null,
    perigeeKm: null,
    incDeg: null,
    decayDate: null,
    inGcat: false,
    inSpacetrack: false,
    ...over,
  };
}

async function fetchRows() {
  const rows = await db.select().from(obcObjects).where(inArray(obcObjects.key, KEYS));
  return new Map(rows.map((r) => [r.key, r]));
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function cleanup() {
  await db.delete(obcObjects).where(inArray(obcObjects.key, KEYS));
}

async function main() {
  await cleanup(); // in case a previous run crashed mid-way

  // ── Seed initial state ─────────────────────────────────────────────
  await upsertObjects([
    // GCAT row with stale values that upstream GCAT will later correct
    baseRow(K_GCAT, {
      jcat: "TEST-UPSERT-GCAT",
      inGcat: true,
      owner: "STALE-OWNER",
      decayDate: "2020-01-01",
      apogeeKm: 500,
    }),
    // space-track-only row with a decay date space-track will later retract
    baseRow(K_ST, {
      inSpacetrack: true,
      decayDate: "2021-06-15",
      state: "US",
      satState: "D",
    }),
    // GCAT row missing orbit data; space-track will try to fill and to clash
    baseRow(K_GAPFILL, {
      jcat: "TEST-UPSERT-GAPFILL",
      inGcat: true,
      owner: "GCAT-OWNER",
      apogeeKm: null,
      perigeeKm: 400,
    }),
  ]);

  // ── Case 1: GCAT clears decay date + owner on its own row ──────────
  await upsertObjects([
    baseRow(K_GCAT, {
      jcat: "TEST-UPSERT-GCAT",
      inGcat: true,
      owner: null, // upstream correction: clears stale owner
      decayDate: null, // upstream correction: object did NOT decay
      apogeeKm: 550, // and updates a value
    }),
  ]);

  // ── Case 2: space-track clears decay date on its own ST-only row ───
  await upsertObjects([
    baseRow(K_ST, {
      inSpacetrack: true,
      decayDate: null, // space-track retracted the decay
      state: null, // and cleared country
      satState: "O?",
    }),
  ]);

  // ── Case 3: space-track row lands on GCAT row → gap-fill only ──────
  await upsertObjects([
    baseRow(K_GAPFILL, {
      inGcat: false,
      inSpacetrack: true,
      owner: null, // must NOT clear GCAT's owner
      apogeeKm: 420, // fills the gap
      perigeeKm: null, // must NOT clear GCAT's perigee
    }),
  ]);

  const rows = await fetchRows();
  const gcat = rows.get(K_GCAT);
  const st = rows.get(K_ST);
  const gap = rows.get(K_GAPFILL);
  if (!gcat || !st || !gap) throw new Error("test rows missing after upsert");

  console.log("\nCase 1 — GCAT authoritative for its own row:");
  check("GCAT clears decay_date", gcat.decayDate, null);
  check("GCAT clears owner", gcat.owner, null);
  check("GCAT updates apogee", gcat.apogeeKm, 550);
  check("row stays in_gcat", gcat.inGcat, true);

  console.log("\nCase 2 — space-track authoritative for ST-only row:");
  check("ST clears decay_date", st.decayDate, null);
  check("ST clears state", st.state, null);
  check("ST updates sat_state", st.satState, "O?");

  console.log("\nCase 3 — space-track only gap-fills a GCAT row:");
  check("ST does NOT clear GCAT owner", gap.owner, "GCAT-OWNER");
  check("ST does NOT clear GCAT perigee", gap.perigeeKm, 400);
  check("ST fills missing apogee", gap.apogeeKm, 420);
  check("in_gcat flag preserved", gap.inGcat, true);
  check("in_spacetrack flag set", gap.inSpacetrack, true);

  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  console.log("\nAll upsert precedence assertions passed.");
}

main()
  .then(async () => {
    await cleanup();
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } finally {
      await pool.end();
    }
    process.exit(1);
  });
