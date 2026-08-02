/**
 * Regression test for the Gunter's Space Page parser
 * (artifacts/api-server/src/lib/obc/gunter.ts).
 *
 * The parser is regex-based on stable markup (satdata td ids sdtyp/sdnat/
 * sdope/sdcon, satlist class="cosid" cells, h1 title). This test exercises
 * parseChronology/parseDossier against saved iso-8859-1 HTML fixtures so a
 * silent site-layout change shows up as a test failure, and verifies the
 * empty-parse layout alert is recorded in obc_sync_log.
 *
 * Run with: pnpm --filter @workspace/api-server run test:gunter
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, pool } from "@workspace/db";
import { obcSyncLog } from "@workspace/db/schema";
import { and, eq, gte } from "drizzle-orm";
import {
  EMPTY_PARSE_ALERT_THRESHOLD,
  chronUrl,
  isEmptyParse,
  logGunterLayoutAlert,
  parseChronology,
  parseDossier,
} from "../lib/obc/gunter";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Read a fixture the same way fetchPage does: raw bytes + iso-8859-1 decode. */
function readFixture(name: string): string {
  const buf = readFileSync(join(FIXTURES, name));
  return new TextDecoder("iso-8859-1").decode(buf);
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function main() {
  // ── parseChronology ────────────────────────────────────────────────
  console.log("parseChronology:");
  const chron = parseChronology(readFixture("gunter-chron.htm"));
  const chronUrls = chron.map((e) => e.url);
  check("discovers unique dossier urls", chron.length, 3);
  check(
    "resolves ../doc_sdat and dedupes repeat links",
    chronUrls.includes("https://space.skyrocket.de/doc_sdat/starlink-v1-0.htm"),
    true,
  );
  check(
    "handles link without ../ prefix",
    chronUrls.includes("https://space.skyrocket.de/doc_sdat/hayabusa-2_capsule.htm"),
    true,
  );
  check(
    "skips urls with #anchors",
    chronUrls.includes("https://space.skyrocket.de/doc_sdat/vega-fail.htm"),
    false,
  );
  check(
    "skips urls with query strings",
    chronUrls.some((u) => u.includes("query.htm")),
    false,
  );
  check(
    "launch tag hint captured per row",
    chron.find((e) => e.url.endsWith("sentinel-6.htm"))?.launchTags,
    ["2020-086"],
  );
  check(
    "launch tag for link without ../ prefix",
    chron.find((e) => e.url.endsWith("hayabusa-2_capsule.htm"))?.launchTags,
    ["2020-089"],
  );
  check(
    "starlink row tag captured once despite repeat links",
    chron.find((e) => e.url.endsWith("starlink-v1-0.htm"))?.launchTags,
    ["2020-088"],
  );
  check("chronUrl shape", chronUrl(2020), "https://space.skyrocket.de/doc_chr/lau2020.htm");

  // ── parseDossier (well-formed iso-8859-1 page) ─────────────────────
  console.log("\nparseDossier — current layout:");
  const dossier = parseDossier(readFixture("gunter-dossier.htm"));
  check("title from h1 (entities decoded)", dossier.title, "Sentinel-6A, -6B (Jason CS A, B)");
  check("sdtyp fact", dossier.gunterType, "Earth observation, oceanography");
  check("sdnat fact", dossier.nation, "Europe, USA");
  check("sdope fact", dossier.operator, "ESA, NASA, NOAA, EUMETSAT");
  check(
    "sdcon fact keeps iso-8859-1 umlaut",
    dossier.contractors,
    "Airbus Defence and Space (formerly EADS Astrium) - München",
  );
  check(
    "cosid cells: splits multi-id cell, skips '-' placeholder",
    [...dossier.cosparIds].sort(),
    ["2020-086A", "2025-999A", "2025-999B"],
  );
  check("well-formed page is not an empty parse", isEmptyParse(dossier), false);

  // ── parseDossier (simulated site redesign) ─────────────────────────
  console.log("\nparseDossier — layout changed:");
  const changed = parseDossier(readFixture("gunter-dossier-layout-changed.htm"));
  check("redesigned page yields no facts", changed.gunterType, null);
  check("redesigned page yields no COSPAR ids", changed.cosparIds.length, 0);
  check("redesigned page IS flagged as empty parse", isEmptyParse(changed), true);
  check("alert threshold is a small positive count", EMPTY_PARSE_ALERT_THRESHOLD >= 2, true);

  // ── layout alert lands in obc_sync_log ─────────────────────────────
  console.log("\nlayout alert sync row:");
  const startedAt = new Date();
  await logGunterLayoutAlert(EMPTY_PARSE_ALERT_THRESHOLD, startedAt);
  const rows = await db
    .select()
    .from(obcSyncLog)
    .where(and(eq(obcSyncLog.source, "gunter"), eq(obcSyncLog.status, "error"), gte(obcSyncLog.startedAt, startedAt)));
  const row = rows.find((r) => r.error?.includes("gunter layout alert"));
  check("error-status gunter row recorded", row != null, true);
  check("error message mentions consecutive empty parses", row?.error?.includes(`${EMPTY_PARSE_ALERT_THRESHOLD} consecutive dossiers`) ?? false, true);
  if (row) await db.delete(obcSyncLog).where(eq(obcSyncLog.id, row.id));

  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  console.log("\nAll Gunter parser assertions passed.");
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
