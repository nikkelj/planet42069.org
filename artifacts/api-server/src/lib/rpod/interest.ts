import { RPOD_MAX_RANGE_KM, type ClusteredEvent, type FlaggedPair } from "./screen";

/**
 * RPOD "is this interesting?" policy — the single place Space Police retunes
 * what lights up the board vs. what is constellation housekeeping.
 *
 * The hourly scan still finds every close approach inside the conjunction
 * bubble. This module decides which clustered events are worth persisting.
 * Filtering here (not in the UI) keeps the events table and the public
 * desk from filling with routine same-plane station-keeping.
 *
 * Same-constellation is NOT a hard ban. Starlink-on-Starlink (and other
 * same-operator pairs) is an allowed interesting class when the geometry
 * is unusual — see classes 2–4. Typical same-plane, kilometer-scale
 * housekeeping is still dropped.
 *
 * Interesting classes, in this order:
 *   1. Mixed-operator / mixed-owner / mixed-force (red vs blue). Default.
 *   2. Same-operator ultra-close near-miss (≤200 m, not docked).
 *   3. Same-operator crossing-track / high relative velocity — not the
 *      slow coplanar neighbor flyby.
 *   4. Messy cluster of many independently flying (non-attached) bodies.
 *      Three Starlinks in a dense-shell 30 km bubble is just density;
 *      a real mess is many free-flyers. Docked ISS/Tiangong stacks are
 *      one attached body, not a cluster.
 *
 * Everything else is boring and must not be stored.
 */

// ── thresholds (retune here) ───────────────────────────────────────────────

/**
 * Mixed-operator pairs are interesting out to the conjunction screen
 * bubble. Coplanar mixed-force shadowing may be farther (that screen has
 * its own range cap); mixed still wins regardless of range.
 */
export const MIXED_OPERATOR_MAX_RANGE_KM = RPOD_MAX_RANGE_KM; // 30 km

/**
 * Same-operator / same-constellation "they fucked up" bar. Planned
 * same-owner RPO and same-plane station-keeping live at kilometers. A
 * near-miss that looks like someone actually messed up is inside 200 m
 * AND not docked (relative velocity too high to be physically joined).
 * ~150× tighter than the mixed-operator 30 km bubble.
 *
 * Docked geometry (≤0.5 km AND ≤1 cm/s) is attached hardware, not a
 * fuckup — same-operator docked stacks stay boring. Ultra-close
 * Starlink-on-Starlink that is NOT docked still qualifies.
 */
export const SAME_OPERATOR_NEAR_MISS_KM = 0.2;

/**
 * Same-operator crossing-track bar. Slow coplanar neighbors (Starlink
 * station-keeping in one shell) close at tens of m/s. Crossing-track
 * conjunctions that still pass the plane screen close at a few hundred
 * m/s. 0.3 km/s sits above neighbor flybys and inside the 1.5 km/s
 * conjunction cap. Must also be inside CLUSTER_MAX_RANGE_KM so a 175 km
 * coplanar shadower never qualifies on velocity alone.
 */
export const SAME_OPERATOR_CROSSING_RELVEL_KM_S = 0.3;

/**
 * "Same small volume" for cluster and crossing-track detection. Matches
 * the conjunction bubble so a 175 km coplanar trio is not a cluster.
 */
export const CLUSTER_MAX_RANGE_KM = RPOD_MAX_RANGE_KM; // 30 km

/**
 * Minimum independently flying (non-attached) bodies for a same-operator
 * messy cluster. Two is a pair. Three Starlinks in a 30 km bubble of a
 * dense shell is expected density, not a mess. A real mess is many
 * free-flyers. Mixed-operator events keep at two members (class 1) and
 * do not use this bar.
 */
export const CLUSTER_MIN_FREE_BODIES = 6;

/**
 * Docked-stack geometry: near-zero range AND near-zero relative velocity
 * means physically joined (station modules, visiting vehicles), not a
 * proximity operation in progress. Kept next to the interest thresholds
 * so the desk retunes "attached vs. flying" in one file.
 */
export const DOCKED_MAX_RANGE_KM = 0.5;
export const DOCKED_MAX_RELVEL_KM_S = 0.01;

export function isDockedGeometry(minRangeKm: number, relVelKmS: number): boolean {
  return minRangeKm <= DOCKED_MAX_RANGE_KM && relVelKmS <= DOCKED_MAX_RELVEL_KM_S;
}

/** Crossing-track / high-relvel flyby inside the conjunction bubble, not attached. */
export function isCrossingTrackGeometry(minRangeKm: number, relVelKmS: number): boolean {
  return minRangeKm <= CLUSTER_MAX_RANGE_KM
    && relVelKmS >= SAME_OPERATOR_CROSSING_RELVEL_KM_S
    && !isDockedGeometry(minRangeKm, relVelKmS);
}

// ── catalog affiliation ────────────────────────────────────────────────────

export interface InterestCatalogMeta {
  name: string | null;
  owner: string | null;
  state: string | null;
  gunterOperator: string | null;
  gunterNation: string | null;
  objectClass: string | null;
}

/**
 * Mega-constellation families. Used to recognize same-constellation
 * siblings so the tighter same-operator gates apply — NOT a hard ban.
 * Starlink-on-Starlink still surfaces for near-miss, crossing-track, or
 * a messy cluster. Deliberately NOT a generic name-prefix rule:
 * catch-all names like "Kosmos-NNNN" cover inspector pairs and must
 * never be lumped into one constellation.
 */
export const CONSTELLATION_PATTERNS: [string, RegExp][] = [
  ["starlink", /^starlink\b/],
  ["oneweb", /^oneweb\b/],
  ["iridium", /^iridium\b/],
  ["globalstar", /^globalstar\b/],
  ["orbcomm", /^orbcomm\b/],
  ["flock", /^flock\b/],
  ["lemur", /^lemur\b/],
  ["spacebee", /^spacebee\b/],
  ["kuiper", /^kuiper\b/],
  ["qianfan", /^(qianfan|g60)\b/],
  ["guowang", /^(guowang|gw[- ])/],
  ["gonets", /^gonets\b/],
];

/** Generic catalog placeholders — not a "clearly mixed name" signal. */
const GENERIC_NAME_TOKENS = new Set([
  "object", "tba", "unknown", "unk", "debris", "tbd", "sat", "satellite", "payload",
]);

/** Spelling variants that are the same family, not mixed-force. */
const NAME_FAMILY_ALIASES: Record<string, string> = {
  kosmos: "cosmos",
  g60: "qianfan",
  gw: "guowang",
};

function norm(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

export function constellationTag(name: string | null | undefined): string | null {
  const n = norm(name);
  if (!n) return null;
  for (const [tag, re] of CONSTELLATION_PATTERNS) if (re.test(n)) return tag;
  return null;
}

/**
 * Leading alphabetic token of a catalog name, or the constellation tag
 * when the name matches a known family. Generic placeholders ("OBJECT A")
 * return null so they cannot fake a mixed-name pair.
 */
export function nameFamily(name: string | null | undefined): string | null {
  const tag = constellationTag(name);
  if (tag) return tag;
  const n = norm(name);
  if (!n) return null;
  const m = n.match(/[a-z]{3,}/);
  if (!m) return null;
  const token = NAME_FAMILY_ALIASES[m[0]] ?? m[0];
  if (GENERIC_NAME_TOKENS.has(token)) return null;
  return token;
}

export interface Affiliation {
  constellation: string | null;
  owner: string | null;
  operator: string | null;
  state: string | null;
  nation: string | null;
  nameFamily: string | null;
}

/** Catalog lookup used by the scan (values may carry extra fields). */
export type CatalogLookup = {
  get(norad: number): InterestCatalogMeta | undefined;
};

export function affiliationOf(meta: InterestCatalogMeta | undefined): Affiliation {
  return {
    constellation: constellationTag(meta?.name),
    owner: norm(meta?.owner),
    operator: norm(meta?.gunterOperator),
    state: norm(meta?.state),
    nation: norm(meta?.gunterNation),
    nameFamily: nameFamily(meta?.name),
  };
}

/**
 * Proven SAME operator/constellation: both objects share a constellation
 * tag, GCAT owner, or Gunter operator. Same nation/state alone is NOT
 * same-operator (US military vs Starlink is mixed-force).
 */
export function isProvenSameAffiliation(a: Affiliation, b: Affiliation): boolean {
  if (a.constellation && a.constellation === b.constellation) return true;
  if (a.owner && a.owner === b.owner) return true;
  if (a.operator && a.operator === b.operator) return true;
  return false;
}

/**
 * Proven MIXED: any catalog field we trust disagrees. Different owners,
 * operators, nations, or constellation families → red vs blue.
 */
export function isProvenMixedAffiliation(a: Affiliation, b: Affiliation): boolean {
  const keys = ["constellation", "owner", "operator", "state", "nation"] as const;
  for (const key of keys) {
    const va = a[key];
    const vb = b[key];
    if (va && vb && va !== vb) return true;
  }
  return false;
}

/**
 * Pair classification from catalog metadata we already have.
 *
 *  - "mixed": different operators / nations / constellations, OR clearly
 *    mixed names when ownership is missing (COSMOS vs USA, STARLINK vs
 *    ONEWEB). Never drop these as a bland self-on-self guess.
 *  - "same": proven same constellation, owner, or operator. Still an
 *    allowed interesting class when geometry is unusual (near-miss,
 *    crossing-track, messy cluster); only the slow same-plane km-scale
 *    case is boring.
 *  - "unknown": not enough metadata to prove mixed, and names are not
 *    clearly different. Fail closed: treat as bland self-on-self unless
 *    the geometry is unusual (near-miss, crossing-track, messy cluster).
 */
export type PairClass = "mixed" | "same" | "unknown";

export function classifyPair(a: Affiliation, b: Affiliation): PairClass {
  if (isProvenMixedAffiliation(a, b)) return "mixed";
  if (isProvenSameAffiliation(a, b)) return "same";
  if (a.nameFamily && b.nameFamily && a.nameFamily !== b.nameFamily) return "mixed";
  if (a.nameFamily && b.nameFamily && a.nameFamily === b.nameFamily) return "same";
  return "unknown";
}

export function classifyPairByNorad(
  a: number,
  b: number,
  meta: CatalogLookup,
): PairClass {
  return classifyPair(affiliationOf(meta.get(a)), affiliationOf(meta.get(b)));
}

/** True when the pair is mixed-force / mixed-operator / mixed-name. */
export function isMixedPair(
  a: number,
  b: number,
  meta: CatalogLookup,
): boolean {
  return classifyPairByNorad(a, b, meta) === "mixed";
}

/**
 * True when we can prove the pair is same-operator or same-constellation.
 * Used to skip the *coplanar* (slow-neighbor) SGP4 path — that screen is
 * definitionally the boring same-plane flyby. Same-constellation pairs
 * still go through the conjunction screen and persist when they are a
 * near-miss, crossing-track, or messy cluster.
 */
export function isProvenSamePair(
  a: number,
  b: number,
  meta: CatalogLookup,
): boolean {
  return classifyPairByNorad(a, b, meta) === "same";
}

// ── event-level decision ───────────────────────────────────────────────────

export type InterestReason =
  | "mixed-operator"
  | "cluster"
  | "same-operator-near-miss"
  | "same-operator-crossing"
  | "boring";

export interface InterestDecision {
  keep: boolean;
  reason: InterestReason;
}

/**
 * Independently flying bodies in the conjunction-scale volume. Members
 * joined by docked geometry (attached stacks) do not count — ISS visiting
 * vehicles sitting on the station are one stack, not a cluster.
 */
export function countFreeBodies(ev: Pick<ClusteredEvent, "pairs">): number {
  const inVolume: FlaggedPair[] = ev.pairs.filter((p) => p.minRangeKm <= CLUSTER_MAX_RANGE_KM);
  if (inVolume.length === 0) return 0;
  const attached = new Set<number>();
  for (const p of inVolume) {
    if (isDockedGeometry(p.minRangeKm, p.relVelKmS)) {
      attached.add(p.a);
      attached.add(p.b);
    }
  }
  const members = new Set<number>();
  for (const p of inVolume) {
    members.add(p.a);
    members.add(p.b);
  }
  let free = 0;
  for (const n of members) if (!attached.has(n)) free++;
  return free;
}

function eventIsMixed(members: number[], meta: CatalogLookup): boolean {
  const affs = members.map((n) => affiliationOf(meta.get(n)));
  for (let i = 0; i < affs.length; i++) {
    for (let j = i + 1; j < affs.length; j++) {
      if (classifyPair(affs[i], affs[j]) === "mixed") return true;
    }
  }
  return false;
}

function eventIsDockedNearMiss(ev: Pick<ClusteredEvent, "minRangeKm" | "relVelKmS">): boolean {
  return isDockedGeometry(ev.minRangeKm, ev.relVelKmS);
}

/**
 * Classify a clustered RPOD event. Pure — no DB, no Space-Track.
 *
 * Mixed-operator wins even for docked stacks (ISS + Dragon is mixed-force
 * visiting-vehicle traffic). Same-operator / same-constellation is kept
 * when the geometry is a near-miss, a crossing-track conjunction, or a
 * messy cluster of many free-flyers — not when it is a slow same-plane
 * neighbor at kilometers.
 */
export function classifyEvent(
  ev: Pick<ClusteredEvent, "members" | "pairs" | "minRangeKm" | "relVelKmS">,
  meta: CatalogLookup,
): InterestDecision {
  if (ev.members.length >= 2 && eventIsMixed(ev.members, meta)) {
    return { keep: true, reason: "mixed-operator" };
  }
  if (
    ev.minRangeKm <= SAME_OPERATOR_NEAR_MISS_KM
    && !eventIsDockedNearMiss(ev)
  ) {
    return { keep: true, reason: "same-operator-near-miss" };
  }
  if (isCrossingTrackGeometry(ev.minRangeKm, ev.relVelKmS)) {
    return { keep: true, reason: "same-operator-crossing" };
  }
  if (countFreeBodies(ev) >= CLUSTER_MIN_FREE_BODIES) {
    return { keep: true, reason: "cluster" };
  }
  return { keep: false, reason: "boring" };
}

export interface InterestFilterStats {
  kept: number;
  dropped: number;
  mixed: number;
  cluster: number;
  nearMiss: number;
  crossing: number;
}

/** Drop boring events before persist so they never reach the events table. */
export function selectInterestingEvents<T extends Pick<ClusteredEvent, "members" | "pairs" | "minRangeKm" | "relVelKmS">>(
  events: T[],
  meta: CatalogLookup,
): { kept: T[]; stats: InterestFilterStats } {
  const kept: T[] = [];
  const stats: InterestFilterStats = { kept: 0, dropped: 0, mixed: 0, cluster: 0, nearMiss: 0, crossing: 0 };
  for (const ev of events) {
    const d = classifyEvent(ev, meta);
    if (!d.keep) {
      stats.dropped++;
      continue;
    }
    kept.push(ev);
    stats.kept++;
    if (d.reason === "mixed-operator") stats.mixed++;
    else if (d.reason === "cluster") stats.cluster++;
    else if (d.reason === "same-operator-near-miss") stats.nearMiss++;
    else if (d.reason === "same-operator-crossing") stats.crossing++;
  }
  return { kept, stats };
}

/**
 * Spend the SGP4 budget on mixed-force pairs first so routine same-plane
 * housekeeping cannot crowd red-vs-blue approaches off the hour.
 *
 * Remaining slots are split: tightest same-operator planes (in-shell
 * clusters / near-misses) and loosest planes still inside the screen
 * (crossing-track). Same-constellation is not excluded from the budget.
 */
export function prioritizeSgp4Pairs<T extends { a: { norad: number }; b: { norad: number } }>(
  pairs: T[],
  meta: CatalogLookup,
  budget: number,
  planeScore: (p: T) => number,
): T[] {
  const mixed: T[] = [];
  const rest: T[] = [];
  for (const p of pairs) {
    if (isMixedPair(p.a.norad, p.b.norad, meta)) mixed.push(p);
    else rest.push(p);
  }
  const byPlane = (arr: T[]) => [...arr].sort((x, y) => planeScore(x) - planeScore(y));
  const mixedTake = byPlane(mixed).slice(0, budget);
  const remaining = budget - mixedTake.length;
  if (remaining <= 0) return mixedTake;
  const restSorted = byPlane(rest);
  const tightN = Math.min(restSorted.length, Math.ceil(remaining / 2));
  const tight = restSorted.slice(0, tightN);
  const taken = new Set(tight);
  const loose: T[] = [];
  for (let i = restSorted.length - 1; i >= 0 && tight.length + loose.length < remaining; i--) {
    const p = restSorted[i];
    if (!taken.has(p)) loose.push(p);
  }
  return [...mixedTake, ...tight, ...loose];
}
