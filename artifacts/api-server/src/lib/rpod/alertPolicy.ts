import {
  forceOf,
  forcesWarrantAlert,
  sameForce,
  type Force,
  type ForceObject,
} from "./force";
import { isSuspectedCrossTag, type ElsetSnap, type ManeuverMark } from "./maneuver";

/**
 * What is allowed to become an X citation (or a queue row).
 *
 * A case alerts only when a red object is with a blue or neutral one
 * (red-red never, SU and RU are the same force), both elsets are fresh,
 * the pair has been inside the range bubble at low speed across at least
 * two scans spanning 6 hours, and it is not a co-launch, a cross-tag, or
 * a docked label invented from elsets. Same-operator traffic alerts only
 * for a ~200 m non-docked miss or a real messy cluster. Kosmos 2610–2614
 * against anything outside the pack is scored first and skips the daily cap.
 * Pack-on-pack formation at kilometer range is not an alert.
 */

export const LEO_ALERT_RANGE_KM = 30;
export const GEO_ALERT_RANGE_KM = 10;
/** Fast crossings are out of scope. */
export const MAX_ALERT_RELVEL_KM_S = 0.1;
/** Sustained-proximity bar (~50 m/s). */
export const PERSIST_RELVEL_KM_S = 0.05;
export const PERSIST_MIN_SCANS = 2;
export const PERSIST_MIN_SPAN_MS = 6 * 3600_000;
export const ELSET_MAX_AGE_MS = 24 * 3600_000;
export const ELSET_MAX_SKEW_MS = 12 * 3600_000;
/** 1–2 citations a day. Two is the cap; the best score goes first. */
export const ALERTS_PER_DAY = 2;
export const SAME_OPERATOR_MISS_KM = 0.2;
export const DOCKED_MAX_RANGE_KM = 0.5;
export const DOCKED_MAX_RELVEL_KM_S = 0.01;

function isDockedGeometry(minRangeKm: number, relVelKmS: number): boolean {
  return minRangeKm <= DOCKED_MAX_RANGE_KM && relVelKmS <= DOCKED_MAX_RELVEL_KM_S;
}
export const MESSY_CLUSTER_MIN = 6;

/** Kosmos 2610–2614. Pack-on-pack is formation flying; one of them vs an outsider is the story. */
export const KOSMOS_PACK_NORADS = [68758, 68759, 68762, 68763, 68764] as const;
const KOSMOS_PACK = new Set<number>(KOSMOS_PACK_NORADS);

/** Cores whose visiting vehicles are a stack, not an RPOD. */
export const KNOWN_STATION_NORADS = new Set<number>([
  25544, // ISS (Zarya)
  48274, // Tiangong (Tianhe)
]);

export interface ExerciseFlag {
  norad: number | null;
  noradB?: number | null;
  expiresAtMs?: number | null;
}

export interface PolicyMember extends ForceObject {
  norad: number;
  opOrbit?: string | null;
  launchTag?: string | null;
  elset?: ElsetSnap | null;
  /** Closest approach this member reached against anyone else in the case. */
  closestRangeKm?: number | null;
  closestRelVelKmS?: number | null;
}

export interface PolicyPair {
  a: number;
  b: number;
  minRangeKm: number;
  relVelKmS: number;
}

export interface PolicyEvent {
  eventId: number;
  kind: string;
  members: PolicyMember[];
  minRangeKm: number;
  relVelKmS: number;
  firstDetectedAtMs: number;
  lastSeenAtMs: number;
  scanCount: number;
  /** Previous scan's per-object elset epochs, keyed by NORAD string. */
  previousElsetEpochs?: Record<string, number> | null;
  maneuver?: ManeuverMark | null;
  suspectedCrossTag?: boolean;
  /** Same-operator messy cluster already classified by the interest policy. */
  messyCluster?: boolean;
  /** Pair geometry from the scan. The citation uses the cross-force pair, not a co-launched sub-pair. */
  pairs?: PolicyPair[];
}

export interface AlertVerdict {
  eventId: number;
  eligible: boolean;
  /** Eligible but not in today's post set. Held, not dropped. */
  held: boolean;
  post: boolean;
  bypassCap: boolean;
  score: number;
  reason: string;
  /** Range/velocity of the pair the citation is actually about. */
  citedRangeKm?: number;
  citedRelVelKmS?: number;
}

export function isKosmosOutsider(norads: number[]): boolean {
  const inside = norads.filter((n) => KOSMOS_PACK.has(n));
  const outside = norads.filter((n) => !KOSMOS_PACK.has(n));
  return inside.length >= 1 && outside.length >= 1;
}

export function isPackOnPack(norads: number[]): boolean {
  return norads.length >= 2 && norads.every((n) => KOSMOS_PACK.has(n));
}

export function exerciseCovers(norads: number[], flags: ExerciseFlag[], nowMs: number): boolean {
  const set = new Set(norads);
  for (const f of flags) {
    if (f.expiresAtMs != null && f.expiresAtMs <= nowMs) continue;
    if (f.norad == null) continue;
    if (f.noradB == null) {
      if (set.has(f.norad)) return true;
    } else if (set.has(f.norad) && set.has(f.noradB)) return true;
  }
  return false;
}

/** Both elsets younger than 24 h and within 12 h of each other. */
export function elsetsAreFresh(epochsMs: number[], nowMs: number): boolean {
  const finite = epochsMs.filter((n) => Number.isFinite(n));
  if (finite.length < 2) return false;
  for (const e of finite) {
    const age = nowMs - e;
    if (age >= ELSET_MAX_AGE_MS || age < -3600_000) return false;
  }
  return Math.max(...finite) - Math.min(...finite) <= ELSET_MAX_SKEW_MS;
}

/** The new scan's elsets are not older than the ones already stored, and at least one moved forward. */
export function elsetsAdvanced(
  previous: Record<string, number> | null | undefined,
  next: Record<string, number>,
): boolean {
  if (!previous || Object.keys(previous).length === 0) return true;
  let newer = false;
  for (const [k, epoch] of Object.entries(next)) {
    if (!Number.isFinite(epoch)) continue;
    const was = previous[k];
    if (was == null) { newer = true; continue; }
    if (epoch + 1000 < was) return false;
    if (epoch > was + 1000) newer = true;
  }
  return newer;
}

/**
 * Docked is a known station/stack, not a range reading.
 * A red-vs-blue/neutral pair is never labeled docked from elsets alone.
 */
export function mayLabelDocked(
  norads: number[],
  forces: Force[],
  stations: Set<number> = KNOWN_STATION_NORADS,
): boolean {
  if (norads.some((n) => stations.has(n))) return true;
  if (forcesWarrantAlert(forces)) return false;
  return true;
}

export function isBogusDocked(ev: Pick<PolicyEvent, "kind" | "minRangeKm" | "relVelKmS" | "members">, forces: Force[]): boolean {
  const geometry = ev.kind === "docked" || isDockedGeometry(ev.minRangeKm, ev.relVelKmS);
  if (!geometry) return false;
  return !mayLabelDocked(ev.members.map((m) => m.norad), forces);
}

function rangeLimitKm(members: PolicyMember[]): number {
  const orbits = members.map((m) => (m.opOrbit ?? "").toUpperCase());
  if (orbits.some((o) => o === "LEO" || o === "SSO" || o === "VLEO")) return LEO_ALERT_RANGE_KM;
  if (orbits.some((o) => o === "GEO")) return GEO_ALERT_RANGE_KM;
  return LEO_ALERT_RANGE_KM;
}

function coLaunched(members: PolicyMember[]): boolean {
  if (members.length < 2) return false;
  const tags = members.map((m) => m.launchTag ?? null);
  const first = tags[0];
  return first != null && tags.every((t) => t === first);
}

function pairCrossTag(members: PolicyMember[]): boolean {
  if (members.length !== 2) return false;
  const a = members[0].elset;
  const b = members[1].elset;
  if (!a || !b) return false;
  return isSuspectedCrossTag(a, b);
}

export function memberForces(members: PolicyMember[]): Force[] {
  return members.map((m) => forceOf(m));
}

/**
 * The approach the citation is about.
 *
 * A cluster's tightest pair is often two same-launch siblings (Mule-4T and
 * SITRO-AIS-64 at 2.7 km) with an outsider merely in the neighborhood.
 * That sibling pair is not the alert. Prefer an explicit pair list; without
 * one, a 3+-body case whose tightest members share a launch tag is scored
 * on the outsider's closest approach instead.
 */
export function crossForceApproach(ev: PolicyEvent): { rangeKm: number; relVelKmS: number } | null {
  if (ev.pairs && ev.pairs.length > 0) {
    const byId = new Map(ev.members.map((m) => [m.norad, m]));
    const ordered = [...ev.pairs].sort((a, b) => a.minRangeKm - b.minRangeKm || a.relVelKmS - b.relVelKmS);
    for (const p of ordered) {
      const a = byId.get(p.a);
      const b = byId.get(p.b);
      if (!a || !b) continue;
      if (a.launchTag && a.launchTag === b.launchTag) continue;
      const forces = [forceOf(a), forceOf(b)];
      const mixed = forcesWarrantAlert(forces);
      const near = p.minRangeKm <= SAME_OPERATOR_MISS_KM && !isDockedGeometry(p.minRangeKm, p.relVelKmS);
      const bluePair = forces.length === 2 && forces.every((f) => f === "blue");
      if (mixed || near || bluePair) return { rangeKm: p.minRangeKm, relVelKmS: p.relVelKmS };
    }
    return null;
  }
  if (ev.members.length < 3) return { rangeKm: ev.minRangeKm, relVelKmS: ev.relVelKmS };
  const withClosest = ev.members.filter((m) => m.closestRangeKm != null && Number.isFinite(m.closestRangeKm));
  if (withClosest.length < ev.members.length) return { rangeKm: ev.minRangeKm, relVelKmS: ev.relVelKmS };
  const tight = withClosest.filter((m) => Math.abs((m.closestRangeKm ?? 0) - ev.minRangeKm) < 0.05);
  const tag = tight[0]?.launchTag ?? null;
  const tightIsCoLaunch = tight.length >= 2 && tag != null && tight.every((m) => m.launchTag === tag);
  if (!tightIsCoLaunch) return { rangeKm: ev.minRangeKm, relVelKmS: ev.relVelKmS };
  const outsiders = withClosest.filter((m) => !tight.includes(m));
  if (outsiders.length === 0) return null;
  const best = outsiders.reduce((a, b) => ((a.closestRangeKm ?? Infinity) <= (b.closestRangeKm ?? Infinity) ? a : b));
  return { rangeKm: best.closestRangeKm ?? ev.minRangeKm, relVelKmS: best.closestRelVelKmS ?? ev.relVelKmS };
}

function persistenceOk(ev: PolicyEvent, epochs: Record<string, number>): boolean {
  const span = ev.lastSeenAtMs - ev.firstDetectedAtMs;
  if (ev.scanCount < PERSIST_MIN_SCANS) return false;
  if (span < PERSIST_MIN_SPAN_MS) return false;
  return elsetsAdvanced(ev.previousElsetEpochs, epochs);
}

/**
 * Gate result before the daily cap. `eligible` cases are worth a citation;
 * the cap decides which of them post today and which are held.
 */
export function evaluateAlert(
  ev: PolicyEvent,
  nowMs: number,
  exerciseFlags: ExerciseFlag[] = [],
): Omit<AlertVerdict, "held" | "post"> {
  const approach = crossForceApproach(ev);
  if (!approach) return { eventId: ev.eventId, bypassCap: false, score: 0, eligible: false, reason: "co-launched" };
  // Gates and the citation follow the cross-force pair, not a co-launched sibling pair in the same cluster.
  ev = { ...ev, minRangeKm: approach.rangeKm, relVelKmS: approach.relVelKmS };
  const cited = { citedRangeKm: approach.rangeKm, citedRelVelKmS: approach.relVelKmS };

  const norads = ev.members.map((m) => m.norad);
  const forces = memberForces(ev.members);
  const kosmos = isKosmosOutsider(norads);
  const base = { eventId: ev.eventId, bypassCap: kosmos, score: 0, eligible: false, ...cited };

  if (ev.relVelKmS > MAX_ALERT_RELVEL_KM_S) return { ...base, reason: "fast" };
  if (ev.suspectedCrossTag || pairCrossTag(ev.members)) return { ...base, reason: "cross-tag" };
  if (isBogusDocked(ev, forces)) return { ...base, reason: "bogus-docked" };
  if (ev.kind === "docked" || isDockedGeometry(ev.minRangeKm, ev.relVelKmS)) return { ...base, reason: "docked" };
  if (norads.some((n) => KNOWN_STATION_NORADS.has(n))) return { ...base, reason: "station" };
  if (coLaunched(ev.members)) return { ...base, reason: "co-launched" };
  if (isPackOnPack(norads) && ev.minRangeKm > SAME_OPERATOR_MISS_KM) return { ...base, reason: "pack-on-pack" };

  const redOther = forcesWarrantAlert(forces);
  const exercise = !redOther && sameForce(forces) && forces[0] === "blue"
    && ev.relVelKmS <= PERSIST_RELVEL_KM_S
    && exerciseCovers(norads, exerciseFlags, nowMs);
  const nearMiss = !redOther && ev.minRangeKm <= SAME_OPERATOR_MISS_KM
    && ev.relVelKmS <= MAX_ALERT_RELVEL_KM_S
    && !isDockedGeometry(ev.minRangeKm, ev.relVelKmS);
  const messy = !redOther && (ev.messyCluster === true || ev.members.length >= MESSY_CLUSTER_MIN);
  if (!redOther && !exercise && !nearMiss && !messy) {
    return { ...base, reason: sameForce(forces) && forces[0] === "red" ? "red-red" : "not-red-blue" };
  }

  const sustained = redOther || exercise;
  if (sustained && ev.relVelKmS > PERSIST_RELVEL_KM_S) return { ...base, reason: "not-slow" };
  if (ev.minRangeKm > rangeLimitKm(ev.members)) return { ...base, reason: "range" };

  const epochs: Record<string, number> = {};
  for (const m of ev.members) {
    if (m.elset && Number.isFinite(m.elset.epochMs)) epochs[String(m.norad)] = m.elset.epochMs;
  }
  const epochList = Object.values(epochs);
  if (!elsetsAreFresh(epochList.length >= 2 ? epochList : ev.members.map((m) => m.elset?.epochMs ?? NaN), nowMs)) {
    return { ...base, reason: "stale-elset" };
  }
  if (!persistenceOk(ev, epochs)) return { ...base, reason: "not-persistent" };

  return { ...base, eligible: true, score: scoreEvent(ev, forces, kosmos), reason: kosmos ? "kosmos" : redOther ? "red-blue" : exercise ? "exercise" : nearMiss ? "near-miss" : "cluster" };
}

function scoreEvent(ev: PolicyEvent, forces: Force[], kosmos: boolean): number {
  const spanH = Math.max(0, ev.lastSeenAtMs - ev.firstDetectedAtMs) / 3600_000;
  let score = Math.max(0, rangeLimitKm(ev.members) - ev.minRangeKm);
  score += Math.max(0, (PERSIST_RELVEL_KM_S - ev.relVelKmS) * 400);
  score += Math.min(spanH, 72) / 6;
  if (forces.includes("red") && forces.includes("blue")) score += 40;
  else if (forcesWarrantAlert(forces)) score += 25;
  if (ev.kind === "coplanar") score += 8;
  if (ev.maneuver?.relation === "match") score += 40;
  else if (ev.maneuver?.relation === "depart") score += 18;
  else if (ev.maneuver?.beyondDrag) score += 12;
  if (ev.members.length > 2) score -= 20;
  if (ev.members.some((m) => m.objectClass && m.objectClass !== "P")) score -= 30;
  if (kosmos) score += 1000;
  return Math.round(score * 10) / 10;
}

export interface CappedAlert<T> {
  item: T;
  post: boolean;
  held: boolean;
}

/**
 * Best score first, ALERTS_PER_DAY posts, everyone else held.
 * `bypassCap` (the Kosmos pack vs an outsider) always posts.
 */
export function applyAlertCap<T extends { score: number; bypassCap: boolean }>(
  ready: T[],
  alreadyPostedToday = 0,
  cap = ALERTS_PER_DAY,
): CappedAlert<T>[] {
  const ordered = [...ready].sort((a, b) => b.score - a.score);
  let slots = Math.max(0, cap - alreadyPostedToday);
  return ordered.map((item) => {
    if (item.bypassCap) return { item, post: true, held: false };
    if (slots > 0) { slots--; return { item, post: true, held: false }; }
    return { item, post: false, held: true };
  });
}

/** One case per pair: drop bogus-docked duplicates, keep the earliest file. */
export function pairKey(norads: number[]): string {
  return [...norads].sort((a, b) => a - b).join(":");
}

