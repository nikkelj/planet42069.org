/**
 * Tests for the RPOD "Space Police citation" X-alert path
 * (src/lib/rpod/alert.ts + persistEvents in src/lib/rpod/scan.ts):
 *
 *  - persistEvents returns freshly INSERTED events only — updates to an
 *    active case and reopened cases must NOT re-report (no duplicate posts)
 *  - docked-geometry inserts are reported with kind="docked" so the alert
 *    selector can drop them
 *  - selectAlertableEvents drops docked events and co-launched formations
 *  - formatCitation carries case number, craft names, min range, and TCA
 *
 * Seeds temporary rows (NORADs in the 99999xxx test range) and cleans up.
 * Run with: pnpm --filter @workspace/api-server run test:rpod
 */
import { db, pool } from "@workspace/db";
import { rpodEvents, rpodEventMembers, obcSyncLog } from "@workspace/db/schema";
import { inArray, eq } from "drizzle-orm";
import { persistEvents, DOCKED_MAX_RANGE_KM, DOCKED_MAX_RELVEL_KM_S } from "../lib/rpod/scan";
import {
  selectAlertableEvents, formatCitation, formatEscalationCitation, isCoLaunched, isEscalation, caseNumber,
  ESCALATION_TRIGGER_KM, ESCALATION_PRIOR_MIN_KM,
  type NewRpodEvent, type EscalatedRpodEvent, type AlertMeta,
} from "../lib/rpod/alert";
import type { ClusteredEvent } from "../lib/rpod/screen";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const PAIR = [99999301, 99999302];
const DOCKED_PAIR = [99999303, 99999304];

function makeCluster(members: number[], nowMs: number, minRangeKm: number, relVelKmS: number): ClusteredEvent {
  const [a, b] = members;
  return {
    members,
    pairs: [{ a, b, minRangeKm, relVelKmS, tcaMs: nowMs }],
    minRangeKm, relVelKmS, tcaMs: nowMs,
    windowStartMs: nowMs - 3600_000,
    windowEndMs: nowMs + 3600_000,
    hitCap: false,
  };
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const cleanupIds: number[] = [];
  try {
    console.log("persistEvents reporting: insert vs update");
    const { inserted } = await persistEvents([makeCluster(PAIR, nowMs, 4.2, 0.05)], "conjunction");
    check("fresh insert is reported exactly once", inserted.length === 1, JSON.stringify(inserted));
    if (inserted[0]) cleanupIds.push(inserted[0].eventId);
    check("reported event carries members, stats, tca",
      inserted[0]?.members.length === 2 &&
      inserted[0]?.minRangeKm === 4.2 &&
      inserted[0]?.kind === "conjunction" &&
      Math.abs(inserted[0].tcaMs - nowMs) < 1000,
      JSON.stringify(inserted[0]));

    const updated = await persistEvents([makeCluster(PAIR, nowMs + 60_000, 3.9, 0.04)], "conjunction");
    check("update to the same active case reports NO insert", updated.inserted.length === 0, JSON.stringify(updated.inserted));
    check("mild tightening (4.2 → 3.9 km) is NOT an escalation", updated.escalated.length === 0, JSON.stringify(updated.escalated));

    console.log("escalation detection on active-case updates");
    check("isEscalation: 25 → 2 km escalates", isEscalation(25, 2));
    check("isEscalation: prior must exceed the floor", !isEscalation(ESCALATION_PRIOR_MIN_KM, 2));
    check("isEscalation: new range must be under the trigger", !isEscalation(25, ESCALATION_TRIGGER_KM));
    // Widen the case back out (routine update), then tighten sharply.
    const widened = await persistEvents([makeCluster(PAIR, nowMs + 120_000, 25, 0.05)], "conjunction");
    check("widening reports no escalation", widened.escalated.length === 0, JSON.stringify(widened.escalated));
    const tightened = await persistEvents([makeCluster(PAIR, nowMs + 180_000, 2.1, 0.05)], "conjunction");
    check("sharp tightening (25 → 2.1 km) reports ONE escalation, no insert",
      tightened.escalated.length === 1 && tightened.inserted.length === 0, JSON.stringify(tightened));
    check("escalation carries old and new stats",
      tightened.escalated[0]?.eventId === inserted[0].eventId &&
      tightened.escalated[0]?.prevMinRangeKm === 25 &&
      tightened.escalated[0]?.minRangeKm === 2.1,
      JSON.stringify(tightened.escalated[0]));

    console.log("docked-geometry insert reported as docked");
    const { inserted: docked } = await persistEvents(
      [makeCluster(DOCKED_PAIR, nowMs, DOCKED_MAX_RANGE_KM, DOCKED_MAX_RELVEL_KM_S)], "conjunction");
    check("docked insert reported with kind=docked", docked.length === 1 && docked[0].kind === "docked", JSON.stringify(docked));
    if (docked[0]) cleanupIds.push(docked[0].eventId);

    console.log("alert selection");
    const meta = new Map<number, AlertMeta>([
      [PAIR[0], { name: "COSMOS TEST A", launchTag: "2020-001" }],
      [PAIR[1], { name: "USA TEST B", launchTag: "2021-002" }],
      [DOCKED_PAIR[0], { name: "STACK A", launchTag: "1998-067" }],
      [DOCKED_PAIR[1], { name: "STACK B", launchTag: "1998-067" }],
    ]);
    const metaFor = (n: number) => meta.get(n);
    const all: NewRpodEvent[] = [...inserted, ...docked];
    const alertable = selectAlertableEvents(all, metaFor);
    check("docked events never alert", alertable.every((e) => e.kind !== "docked"), JSON.stringify(alertable));
    check("the real conjunction survives selection",
      alertable.length === 1 && alertable[0].eventId === inserted[0].eventId, JSON.stringify(alertable));
    check("co-launched pair detected", isCoLaunched(DOCKED_PAIR, metaFor));
    check("mixed-launch pair not co-launched", !isCoLaunched(PAIR, metaFor));
    const coLaunched: NewRpodEvent = { ...inserted[0], eventId: 999, kind: "conjunction", members: DOCKED_PAIR };
    check("co-launched formation never alerts",
      selectAlertableEvents([coLaunched], metaFor).length === 0);

    console.log("citation text");
    const text = formatCitation(inserted[0], metaFor);
    check("has case number", text.includes(caseNumber(inserted[0].eventId)), text);
    check("has both craft names", text.includes("COSMOS TEST A") && text.includes("USA TEST B"), text);
    check("has min range", text.includes("4.20 km"), text);
    check("has UTC TCA", /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(text), text);
    check("links the case file", text.includes(`/rpod?case=${inserted[0].eventId}`), text);
    check("unknown names fall back to NORAD id",
      formatCitation(inserted[0], () => undefined).includes(`NORAD ${PAIR[0]}`));

    console.log("escalation citation text");
    const escEv: EscalatedRpodEvent = tightened.escalated[0] ?? { ...inserted[0], prevMinRangeKm: 25 };
    const escText = formatEscalationCitation(escEv, metaFor);
    check("escalation text has case number", escText.includes(caseNumber(escEv.eventId)), escText);
    check("escalation text says ESCALATION", escText.includes("ESCALATION"), escText);
    check("escalation text shows old → new range", escText.includes("25.0 km") && escText.includes("2.10 km"), escText);
    check("escalation text links the case file", escText.includes(`/rpod?case=${escEv.eventId}`), escText);
    check("docked escalations never alert",
      selectAlertableEvents([{ ...escEv, kind: "docked" }], metaFor).length === 0);
    check("trigger below prior floor (sane thresholds)", ESCALATION_TRIGGER_KM < ESCALATION_PRIOR_MIN_KM);

    console.log("case-card image");
    const { renderCaseCardSvg, renderCaseCardPng } = await import("../lib/rpod/case-card");
    const svg = renderCaseCardSvg(inserted[0], metaFor);
    check("svg carries case number", svg.includes(caseNumber(inserted[0].eventId)));
    check("svg carries craft names", svg.includes("COSMOS TEST A") && svg.includes("USA TEST B"));
    check("svg carries geometry", svg.includes("4.20 km") && / UTC</.test(svg));
    const hostile: AlertMeta = { name: `<script>&"x`, launchTag: null };
    const hostileSvg = renderCaseCardSvg(inserted[0], () => hostile);
    check("svg escapes hostile names", !hostileSvg.includes("<script>") && hostileSvg.includes("&lt;script&gt;"));
    const png = await renderCaseCardPng(inserted[0], metaFor);
    check("png renders with PNG magic bytes",
      png.length > 10_000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
      `len=${png.length}`);
  } finally {
    if (cleanupIds.length) {
      await db.delete(rpodEventMembers).where(inArray(rpodEventMembers.eventId, cleanupIds));
      await db.delete(rpodEvents).where(inArray(rpodEvents.id, cleanupIds));
      await db.delete(obcSyncLog).where(inArray(obcSyncLog.rowCount, cleanupIds));
    }
    await pool.end();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll rpod-alert checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
