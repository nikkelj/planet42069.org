import { db } from "@workspace/db";
import { rpodExerciseFlags } from "@workspace/db/schema";
import { gt, isNull, or, sql } from "drizzle-orm";
import { logger } from "../logger";
import { dbErrorFields } from "../dbError";
import {
  formatCitation,
  formatEscalationCitation,
  publishPolicyItems,
  type AlertMeta,
  type EscalatedRpodEvent,
  type NewRpodEvent,
} from "./alert";
import {
  applyAlertCap,
  evaluateAlert,
  pairKey,
  type ExerciseFlag,
  type PolicyEvent,
  type PolicyMember,
  type PolicyPair,
} from "./alertPolicy";
import { detectManeuver, type ElsetSnap, type ManeuverMark } from "./maneuver";
import type { InterestCatalogMeta } from "./interest";

/**
 * Decide which of this scan's cases are worth a citation, then hand them to
 * the queue (review) or the capped poster (auto). Cap-skipped rows are queued
 * pending. Kosmos 2610–2614 vs an outsider bypasses the cap.
 */

export interface TrackedRpodEvent extends NewRpodEvent {
  firstDetectedAtMs: number;
  lastSeenAtMs: number;
  scanCount: number;
  firstRangeKm: number;
  maxRangeKm: number;
  previousElsetEpochs: Record<string, number> | null;
  /** Range on file before this scan. Null on a brand-new case. */
  previousMinRangeKm?: number | null;
  suspectedCrossTag: boolean;
  pairs?: PolicyPair[];
}

export interface DispatchCatalog extends InterestCatalogMeta {
  launchTag: string | null;
  opOrbit?: string | null;
}

interface Ready {
  ev: TrackedRpodEvent;
  escalation?: EscalatedRpodEvent;
  score: number;
  bypassCap: boolean;
  ledgerKey: number;
  what: string;
  note: string | null;
}

export async function deliverPolicyAlerts(input: {
  tracked: TrackedRpodEvent[];
  escalated: EscalatedRpodEvent[];
  meta: Map<number, DispatchCatalog>;
  elsets: Map<number, ElsetSnap>;
  nowMs: number;
}): Promise<void> {
  const { tracked, escalated, meta, elsets, nowMs } = input;
  if (tracked.length === 0 && escalated.length === 0) return;
  const flags = await loadExerciseFlags(nowMs);
  const byPair = new Map<string, TrackedRpodEvent>();
  for (const ev of tracked) {
    const key = pairKey(ev.members);
    const prev = byPair.get(key);
    if (!prev || (prev.kind === "docked" && ev.kind !== "docked") || (prev.kind === ev.kind && ev.minRangeKm < prev.minRangeKm)) {
      byPair.set(key, ev);
    }
  }
  const norads = [...new Set([...byPair.values()].flatMap((e) => e.members))];
  const previous = await loadPreviousElsets(norads);

  const ready: Ready[] = [];
  const openingIds = new Set<number>();
  for (const ev of byPair.values()) {
    const policy = toPolicy(ev, meta, elsets, previous);
    const verdict = evaluateAlert(policy, nowMs, flags);
    if (!verdict.eligible) continue;
    openingIds.add(ev.eventId);
    ready.push({
      ev: citedEvent(ev, verdict.citedRangeKm, verdict.citedRelVelKmS),
      score: verdict.score, bypassCap: verdict.bypassCap,
      ledgerKey: ev.eventId, what: "new event", note: maneuverSentence(policy.maneuver),
    });
  }
  for (const esc of escalated) {
    if (openingIds.has(esc.eventId)) continue;
    const base = byPair.get(pairKey(esc.members));
    if (!base) continue;
    const policy = toPolicy(base, meta, elsets, previous);
    const verdict = evaluateAlert(policy, nowMs, flags);
    if (!verdict.eligible) continue;
    ready.push({
      ev: citedEvent(base, verdict.citedRangeKm, verdict.citedRelVelKmS),
      escalation: esc,
      score: verdict.score + 5,
      bypassCap: verdict.bypassCap,
      ledgerKey: -esc.eventId,
      what: "escalation",
      note: maneuverSentence(policy.maneuver),
    });
  }
  if (ready.length === 0) return;

  const capped = applyAlertCap(ready);
  const metaFor = (n: number): AlertMeta | undefined => {
    const m = meta.get(n);
    return m ? { name: m.name, launchTag: m.launchTag } : undefined;
  };
  // Best score first. Bypass items are included even past the numeric cap;
  // postAlertItems holds the rest instead of dropping them.
  const ordered = [...capped].sort((a, b) => b.item.score - a.item.score);
  await publishPolicyItems(ordered.map((c) => {
    const item = c.item;
    const text = item.escalation
      ? formatEscalationCitation(item.escalation, metaFor)
      : formatCitation(item.ev, metaFor, item.note);
    return {
      ev: item.ev,
      ledgerKey: item.ledgerKey,
      text,
      what: item.what,
      score: item.score,
      bypassCap: item.bypassCap,
      hold: c.held,
    };
  }), metaFor);
  logger.info(
    { eligible: ready.length, post: capped.filter((c) => c.post).length, held: capped.filter((c) => c.held).length },
    "rpod-alert: policy pass",
  );
}

function citedEvent(ev: TrackedRpodEvent, rangeKm?: number, relVelKmS?: number): TrackedRpodEvent {
  if (rangeKm == null || relVelKmS == null) return ev;
  if (rangeKm === ev.minRangeKm && relVelKmS === ev.relVelKmS) return ev;
  return { ...ev, minRangeKm: rangeKm, relVelKmS };
}

function maneuverSentence(m: ManeuverMark | null | undefined): string | null {
  if (!m) return null;
  const sma = `${m.dSmaKm >= 0 ? "+" : ""}${m.dSmaKm.toFixed(2)} km SMA`;
  if (m.relation === "match") return `Orbit-matching burn detected (${sma}).`;
  if (m.relation === "depart") return `Departure burn detected (${sma}).`;
  return `Maneuver beyond drag detected (${sma}).`;
}

function toPolicy(
  ev: TrackedRpodEvent,
  meta: Map<number, DispatchCatalog>,
  elsets: Map<number, ElsetSnap>,
  previous: Map<number, ElsetSnap>,
): PolicyEvent {
  const members: PolicyMember[] = ev.members.map((norad) => {
    const m = meta.get(norad);
    return {
      norad,
      name: m?.name ?? null,
      owner: m?.owner ?? null,
      state: m?.state ?? null,
      gunterNation: m?.gunterNation ?? null,
      objectClass: m?.objectClass ?? null,
      launchState: m?.launchState ?? null,
      opOrbit: m?.opOrbit ?? null,
      launchTag: m?.launchTag ?? null,
      elset: elsets.get(norad) ?? null,
    };
  });
  let maneuver: ManeuverMark | null = null;
  for (let i = 0; i < members.length && !maneuver; i++) {
    const prev = previous.get(members[i].norad);
    const curr = members[i].elset;
    const target = members.find((m) => m.norad !== members[i].norad)?.elset ?? null;
    if (prev && curr) maneuver = detectManeuver(prev, curr, target);
  }
  return {
    eventId: ev.eventId,
    kind: ev.kind,
    members,
    minRangeKm: ev.minRangeKm,
    relVelKmS: ev.relVelKmS,
    firstDetectedAtMs: ev.firstDetectedAtMs,
    lastSeenAtMs: ev.lastSeenAtMs,
    scanCount: ev.scanCount,
    previousElsetEpochs: ev.previousElsetEpochs,
    previousMinRangeKm: ev.previousMinRangeKm,
    maneuver,
    suspectedCrossTag: ev.suspectedCrossTag,
    pairs: ev.pairs,
  };
}

async function loadExerciseFlags(nowMs: number): Promise<ExerciseFlag[]> {
  try {
    const rows = await db.select().from(rpodExerciseFlags).where(
      or(isNull(rpodExerciseFlags.expiresAt), gt(rpodExerciseFlags.expiresAt, new Date(nowMs))),
    );
    return rows.map((r) => ({
      norad: r.norad,
      noradB: r.noradB,
      expiresAtMs: r.expiresAt ? r.expiresAt.getTime() : null,
    }));
  } catch (err) {
    logger.error(
      { err, ...dbErrorFields(err) },
      "rpod-alert: exercise-flag lookup failed; treating as no active exercise",
    );
    return [];
  }
}

async function loadPreviousElsets(norads: number[]): Promise<Map<number, ElsetSnap>> {
  const out = new Map<number, ElsetSnap>();
  if (norads.length === 0) return out;
  try {
    const values = sql.join(norads.map((n) => sql`(${n}::int)`), sql`, `);
    const result = await db.execute(sql`
      SELECT h.norad, h.epoch, h.inc_deg, h.raan_deg, h.eccentricity,
             h.mean_motion_rev_per_day, h.arg_perigee_deg, h.mean_anomaly_deg, h.bstar
      FROM (VALUES ${values}) AS n(norad)
      JOIN LATERAL (
        SELECT * FROM obc_tle_history
        WHERE obc_tle_history.norad = n.norad
        ORDER BY epoch DESC
        OFFSET 1 LIMIT 1
      ) h ON true
    `);
    const rows = extractRows(result);
    for (const r of rows) {
      const norad = Number(r.norad);
      const epoch = r.epoch instanceof Date ? r.epoch : new Date(String(r.epoch));
      if (!Number.isFinite(norad) || Number.isNaN(epoch.getTime())) continue;
      out.set(norad, {
        epochMs: epoch.getTime(),
        incDeg: Number(r.inc_deg),
        raanDeg: Number(r.raan_deg),
        eccentricity: Number(r.eccentricity),
        meanMotionRevPerDay: Number(r.mean_motion_rev_per_day),
        argPerigeeDeg: r.arg_perigee_deg == null ? null : Number(r.arg_perigee_deg),
        meanAnomalyDeg: r.mean_anomaly_deg == null ? null : Number(r.mean_anomaly_deg),
        bstar: r.bstar == null ? null : Number(r.bstar),
      });
    }
  } catch (err) {
    logger.warn({ err }, "rpod-alert: previous-elset lookup failed");
  }
  return out;
}

function extractRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}
