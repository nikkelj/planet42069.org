/**
 * Regression test for the ST-duplicate reconcile step in the OBC sync
 * (reconcileStDuplicates in artifacts/api-server/src/lib/obc/sync.ts).
 *
 * Scenario under test: an object first seen via space-track (key "ST<norad>",
 * jcat NULL) is later catalogued by GCAT (jcat-keyed row, same NORAD id).
 * The reconcile DELETE must remove the ST-keyed duplicate and keep the GCAT
 * row, so analytics never double-count the satellite.
 *
 * Uses temporary keys / a sentinel NORAD id against the dev database and
 * always cleans up after itself.
 * Run with: pnpm --filter @workspace/api-server run test:dedupe
 */
import { db, pool } from "@workspace/db";
import { obcObjects, type InsertObcObject } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import { upsertObjects, reconcileStDuplicates } from "../lib/obc/sync";

const NORAD = 99999901; // sentinel, far above any real catalog number
const K_ST = `ST${NORAD}`;
const K_GCAT = "TEST-DEDUPE-GCAT";
const KEYS = [K_ST, K_GCAT];

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

  // ── Step 1: seed a space-track-only row (jcat NULL, ST key) ──────────
  await upsertObjects([
    baseRow(K_ST, {
      norad: NORAD,
      inSpacetrack: true,
      satState: "O?",
      state: "US",
    }),
  ]);

  // Reconcile with no GCAT counterpart yet: the ST row must survive.
  await reconcileStDuplicates();
  let rows = await fetchRows();
  console.log("Step 1 — ST-only row, no GCAT counterpart:");
  check("ST row survives reconcile when uncatalogued", rows.has(K_ST), true);

  // ── Step 2: GCAT catalogs the same NORAD id ──────────────────────────
  await upsertObjects([
    baseRow(K_GCAT, {
      jcat: K_GCAT,
      norad: NORAD,
      inGcat: true,
      inSpacetrack: true,
      owner: "TEST-OWNER",
    }),
  ]);

  // ── Step 3: reconcile must drop the ST duplicate, keep the GCAT row ──
  await reconcileStDuplicates();
  rows = await fetchRows();
  console.log("\nStep 3 — after GCAT catalogs the object:");
  check("ST duplicate removed", rows.has(K_ST), false);
  check("GCAT row survives", rows.has(K_GCAT), true);
  const gcat = rows.get(K_GCAT);
  check("GCAT row keeps its jcat", gcat?.jcat, K_GCAT);
  check("GCAT row keeps its norad", gcat?.norad, NORAD);

  // ── Step 4: reconcile is idempotent ──────────────────────────────────
  await reconcileStDuplicates();
  rows = await fetchRows();
  console.log("\nStep 4 — reconcile again (idempotence):");
  check("GCAT row still present", rows.has(K_GCAT), true);
  check("exactly one row remains for this norad", rows.size, 1);

  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  console.log("\nAll dedupe reconcile assertions passed.");
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
