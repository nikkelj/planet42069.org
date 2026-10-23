import { sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import { semiMajorAxisKm } from "./screen";
import type { Force } from "./force";

/**
 * Station keeping — a red-versus-blue (or blue-versus-red) pair that holds
 * a steady along-track offset in a shared plane.
 *
 * This is not the conjunction bubble (30 km) and not the coplanar shadow
 * screen (SGP4 range ≤ 250 km). Those classes stay as they are. A pair
 * such as Kosmos 2612 trailing ICEYE-X36 by a few hundred kilometres is
 * outside both, slow, and still a proximity operation.
 *
 * The decision is orbital elements over several elsets, not one SGP4
 * sample. The hourly scan pre-filters red-versus-blue pairs on the latest
 * elsets already in memory, then reads a bounded history only for those
 * NORADs (index seek per id, LIMIT per object). It does not walk the
 * TLE archive per catalog object.
 */

export interface ElementSample {
  norad: number;
  epochMs: number;
  incDeg: number;
  raanDeg: number;
  eccentricity: number;
  argPerigeeDeg: number;
  meanAnomalyDeg: number;
  meanMotionRevPerDay: number;
}

export interface StationKeepingOptions {
  /** Absolute along-track separation cap. RPOD_STATION_KEEP_MAX_OFFSET_KM overrides. */
  maxOffsetKm: number;
  /** Confirm gate: |Δinclination| on every sample of the stable suffix. */
  maxIncDiffDeg: number;
  /** Confirm gate: |ΔRAAN| on every sample of the stable suffix. */
  maxRaanDiffDeg: number;
  /** Confirm gate: median |ΔSMA| across the suffix, and the latest sample. */
  maxSmaDiffKm: number;
  /** |linear drift| of signed along-track offset. */
  maxDriftKmPerDay: number;
  minSamples: number;
  minSpanMs: number;
  /** How far back the history seek looks. */
  historyMs: number;
  /** Rows returned per NORAD. The (norad, epoch) index serves this. */
  maxSamplesPerObject: number;
  /** Cap on history seeks after the in-memory plane prefilter. */
  pairCap: number;
  /** Offset change since the last alert that queues another review row. */
  significantChangeKm: number;
  /** Elsets further apart than this are not one geometry sample. */
  maxEpochSkewMs: number;
  /** Latest paired sample must be at least this fresh. */
  maxLatestAgeMs: number;
  /** Wider than the confirm gates. History still has to pass those. */
  prefilterIncDiffDeg: number;
  prefilterRaanDiffDeg: number;
  prefilterSmaDiffKm: number;
  /** Near-circular assumption for the along-track arc. */
  maxEccentricity: number;
}

export const DEFAULT_STATION_KEEPING: StationKeepingOptions = {
  maxOffsetKm: 1000,
  maxIncDiffDeg: 0.2,
  maxRaanDiffDeg: 0.35,
  maxSmaDiffKm: 8,
  maxDriftKmPerDay: 25,
  minSamples: 3,
  minSpanMs: 2 * 86400_000,
  historyMs: 10 * 86400_000,
  maxSamplesPerObject: 12,
  pairCap: 60,
  significantChangeKm: 100,
  maxEpochSkewMs: 12 * 3600_000,
  maxLatestAgeMs: 3 * 86400_000,
  prefilterIncDiffDeg: 0.3,
  prefilterRaanDiffDeg: 0.5,
  prefilterSmaDiffKm: 15,
  maxEccentricity: 0.02,
};

export function stationKeepingOptions(env: NodeJS.ProcessEnv = process.env): StationKeepingOptions {
  const raw = env.RPOD_STATION_KEEP_MAX_OFFSET_KM;
  if (raw == null || raw.trim() === "") return { ...DEFAULT_STATION_KEEPING };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ...DEFAULT_STATION_KEEPING };
  return { ...DEFAULT_STATION_KEEPING, maxOffsetKm: n };
}

export interface StationKeepingCatalog {
  force: Force;
  payload: boolean;
  launchTag: string | null;
}

/** Red with blue. Red-neutral, red-red, and blue-blue are not this class. */
export function isRedVersusBlue(a: Force, b: Force): boolean {
  return (a === "red" && b === "blue") || (a === "blue" && b === "red");
}

export function stationPairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function wrap360(deg: number): number {
  const x = deg % 360;
  return x < 0 ? x + 360 : x;
}

function signedDeltaDeg(a: number, b: number): number {
  return wrap360(a - b + 180) - 180;
}

function angDiffDeg(a: number, b: number): number {
  return Math.abs(signedDeltaDeg(a, b));
}

function usableSample(e: ElementSample, opts: StationKeepingOptions): boolean {
  return Number.isFinite(e.norad)
    && Number.isFinite(e.epochMs)
    && Number.isFinite(e.incDeg)
    && Number.isFinite(e.raanDeg)
    && Number.isFinite(e.eccentricity)
    && Number.isFinite(e.argPerigeeDeg)
    && Number.isFinite(e.meanAnomalyDeg)
    && Number.isFinite(e.meanMotionRevPerDay)
    && e.meanMotionRevPerDay >= 0.5
    && e.meanMotionRevPerDay <= 20
    && e.eccentricity >= 0
    && e.eccentricity <= opts.maxEccentricity
    && e.incDeg >= 5
    && e.incDeg <= 175;
}

/** Argument of latitude at `atMs`, plus the first-order equation of the center. */
export function trueArgLatDeg(e: ElementSample, atMs: number): number {
  const dtDays = (atMs - e.epochMs) / 86400_000;
  const ma = e.meanAnomalyDeg + e.meanMotionRevPerDay * 360 * dtDays;
  const maRad = wrap360(ma) * Math.PI / 180;
  const eqcDeg = 2 * e.eccentricity * Math.sin(maRad) * (180 / Math.PI);
  return wrap360(e.argPerigeeDeg + ma + eqcDeg);
}

export interface AlongTrack {
  /** Signed kilometres: positive when `a` is ahead of `b` in the direction of motion. */
  signedOffsetKm: number;
  offsetKm: number;
  dIncDeg: number;
  dRaanDeg: number;
  dSmaKm: number;
  crossTrackKm: number;
  atMs: number;
}

export function alongTrackAt(a: ElementSample, b: ElementSample, atMs: number): AlongTrack | null {
  const smaA = semiMajorAxisKm(a.meanMotionRevPerDay);
  const smaB = semiMajorAxisKm(b.meanMotionRevPerDay);
  if (!Number.isFinite(smaA) || !Number.isFinite(smaB) || smaA < 100 || smaB < 100) return null;
  const signedDeg = signedDeltaDeg(trueArgLatDeg(a, atMs), trueArgLatDeg(b, atMs));
  const meanA = (smaA + smaB) / 2;
  const signedOffsetKm = meanA * signedDeg * Math.PI / 180;
  const dIncDeg = a.incDeg - b.incDeg;
  const dRaanDeg = signedDeltaDeg(a.raanDeg, b.raanDeg);
  const dSmaKm = smaA - smaB;
  const incRad = ((a.incDeg + b.incDeg) / 2) * Math.PI / 180;
  const crossTrackKm = meanA * Math.hypot(
    dIncDeg * Math.PI / 180,
    Math.sin(incRad) * dRaanDeg * Math.PI / 180,
  );
  if (!Number.isFinite(signedOffsetKm) || !Number.isFinite(crossTrackKm)) return null;
  return {
    signedOffsetKm,
    offsetKm: Math.abs(signedOffsetKm),
    dIncDeg,
    dRaanDeg,
    dSmaKm,
    crossTrackKm,
    atMs,
  };
}

export interface StationKeepingCandidate {
  /** Red object. Signed offset is this object's position relative to `b`. */
  a: ElementSample;
  b: ElementSample;
  offsetKm: number;
  signedOffsetKm: number;
  dIncDeg: number;
  dRaanDeg: number;
  dSmaKm: number;
}

/**
 * Cheap latest-elset gate. Only red-versus-blue payload pairs from
 * different launches, already close in plane, shell, and along-track.
 */
export function prefilterStationKeepingPairs(
  elsets: ElementSample[],
  catalog: Map<number, StationKeepingCatalog>,
  nowMs: number,
  opts: StationKeepingOptions = DEFAULT_STATION_KEEPING,
): StationKeepingCandidate[] {
  const reds: ElementSample[] = [];
  const blues: ElementSample[] = [];
  for (const e of elsets) {
    if (!usableSample(e, opts)) continue;
    if (nowMs - e.epochMs > opts.maxLatestAgeMs || e.epochMs - nowMs > 6 * 3600_000) continue;
    const meta = catalog.get(e.norad);
    if (!meta?.payload) continue;
    if (meta.force === "red") reds.push(e);
    else if (meta.force === "blue") blues.push(e);
  }
  const bandSize = Math.max(opts.prefilterIncDiffDeg, 0.1);
  const blueBands = new Map<number, ElementSample[]>();
  for (const b of blues) {
    const band = Math.floor(b.incDeg / bandSize);
    for (const id of [band, band + 1]) {
      const arr = blueBands.get(id) ?? [];
      arr.push(b);
      blueBands.set(id, arr);
    }
  }
  const out: StationKeepingCandidate[] = [];
  const seen = new Set<string>();
  for (const a of reds) {
    const band = Math.floor(a.incDeg / bandSize);
    const metaA = catalog.get(a.norad);
    for (const id of [band, band + 1]) {
      for (const b of blueBands.get(id) ?? []) {
        if (a.norad === b.norad) continue;
        const key = stationPairKey(a.norad, b.norad);
        if (seen.has(key)) continue;
        const metaB = catalog.get(b.norad);
        if (!metaA || !metaB || !isRedVersusBlue(metaA.force, metaB.force)) continue;
        if (metaA.launchTag && metaA.launchTag === metaB.launchTag) continue;
        if (Math.abs(a.incDeg - b.incDeg) > opts.prefilterIncDiffDeg) continue;
        if (angDiffDeg(a.raanDeg, b.raanDeg) > opts.prefilterRaanDiffDeg) continue;
        const smaA = semiMajorAxisKm(a.meanMotionRevPerDay);
        const smaB = semiMajorAxisKm(b.meanMotionRevPerDay);
        if (!Number.isFinite(smaA) || !Number.isFinite(smaB)) continue;
        if (Math.abs(smaA - smaB) > opts.prefilterSmaDiffKm) continue;
        const at = Math.max(a.epochMs, b.epochMs);
        const track = alongTrackAt(a, b, at);
        if (!track || track.offsetKm > opts.maxOffsetKm) continue;
        seen.add(key);
        out.push({
          a, b,
          offsetKm: track.offsetKm,
          signedOffsetKm: track.signedOffsetKm,
          dIncDeg: track.dIncDeg,
          dRaanDeg: track.dRaanDeg,
          dSmaKm: track.dSmaKm,
        });
      }
    }
  }
  out.sort((x, y) =>
    (Math.abs(x.dIncDeg) + Math.abs(x.dRaanDeg) + Math.abs(x.dSmaKm) / 10)
    - (Math.abs(y.dIncDeg) + Math.abs(y.dRaanDeg) + Math.abs(y.dSmaKm) / 10));
  return out;
}

interface TrackPoint extends AlongTrack {}

function pairSamples(
  aSamples: ElementSample[],
  bSamples: ElementSample[],
  opts: StationKeepingOptions,
): TrackPoint[] {
  const bs = bSamples.filter((e) => usableSample(e, opts)).slice().sort((x, y) => x.epochMs - y.epochMs);
  const points: TrackPoint[] = [];
  for (const a of aSamples) {
    if (!usableSample(a, opts)) continue;
    let best: ElementSample | null = null;
    let bestDt = Infinity;
    for (const b of bs) {
      const dt = Math.abs(a.epochMs - b.epochMs);
      if (dt < bestDt) { bestDt = dt; best = b; }
    }
    if (!best || bestDt > opts.maxEpochSkewMs) continue;
    const at = Math.max(a.epochMs, best.epochMs);
    const track = alongTrackAt(a, best, at);
    if (track) points.push(track);
  }
  points.sort((x, y) => x.atMs - y.atMs);
  // One point per ~hour so a burst of elsets cannot fake a long span.
  const dedup: TrackPoint[] = [];
  for (const p of points) {
    const prev = dedup[dedup.length - 1];
    if (prev && p.atMs - prev.atMs < 3600_000) {
      if (p.atMs >= prev.atMs) dedup[dedup.length - 1] = p;
      continue;
    }
    dedup.push(p);
  }
  return dedup;
}

function linearDriftKmPerDay(points: TrackPoint[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let tMean = 0;
  let yMean = 0;
  for (const p of points) { tMean += p.atMs; yMean += p.signedOffsetKm; }
  tMean /= n;
  yMean /= n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dt = (p.atMs - tMean) / 86400_000;
    num += dt * (p.signedOffsetKm - yMean);
    den += dt * dt;
  }
  if (den <= 0) return 0;
  return num / den;
}

function suffixHolds(points: TrackPoint[], opts: StationKeepingOptions): boolean {
  if (points.length < opts.minSamples) return false;
  const span = points[points.length - 1].atMs - points[0].atMs;
  if (span < opts.minSpanMs) return false;
  let smaAbs = 0;
  const smaAbsValues: number[] = [];
  let minOff = Infinity;
  let maxOff = -Infinity;
  for (const p of points) {
    if (p.offsetKm > opts.maxOffsetKm) return false;
    if (Math.abs(p.dIncDeg) > opts.maxIncDiffDeg) return false;
    if (Math.abs(p.dRaanDeg) > opts.maxRaanDiffDeg) return false;
    smaAbsValues.push(Math.abs(p.dSmaKm));
    if (p.offsetKm < minOff) minOff = p.offsetKm;
    if (p.offsetKm > maxOff) maxOff = p.offsetKm;
  }
  smaAbsValues.sort((a, b) => a - b);
  const mid = Math.floor(smaAbsValues.length / 2);
  smaAbs = smaAbsValues.length % 2 === 1
    ? smaAbsValues[mid]
    : (smaAbsValues[mid - 1] + smaAbsValues[mid]) / 2;
  const latest = points[points.length - 1];
  if (smaAbs > opts.maxSmaDiffKm || Math.abs(latest.dSmaKm) > opts.maxSmaDiffKm) return false;
  const drift = Math.abs(linearDriftKmPerDay(points));
  if (drift > opts.maxDriftKmPerDay) return false;
  const spanDays = span / 86400_000;
  const allowedRange = Math.max(80, opts.maxDriftKmPerDay * spanDays + 40);
  if (maxOff - minOff > allowedRange) return false;
  return true;
}

export interface StationKeepingVerdict {
  offsetKm: number;
  signedOffsetKm: number;
  driftKmPerDay: number;
  dIncDeg: number;
  dRaanDeg: number;
  dSmaKm: number;
  crossTrackKm: number;
  samples: number;
  spanDays: number;
  latestEpochMs: number;
  spanStartMs: number;
  leadNorad: number;
  trailNorad: number;
}

/**
 * Longest recent suffix of paired elsets that stays inside the plane,
 * shell, offset, and drift gates. Null when the pair is not holding station.
 * `a` is the red object when the caller used the prefilter order.
 */
export function classifyStationKeeping(
  aSamples: ElementSample[],
  bSamples: ElementSample[],
  nowMs: number,
  opts: StationKeepingOptions = DEFAULT_STATION_KEEPING,
): StationKeepingVerdict | null {
  const points = pairSamples(aSamples, bSamples, opts);
  if (points.length < opts.minSamples) return null;
  const latest = points[points.length - 1];
  if (nowMs - latest.atMs > opts.maxLatestAgeMs) return null;
  let chosen: TrackPoint[] | null = null;
  for (let start = 0; start <= points.length - opts.minSamples; start++) {
    const window = points.slice(start);
    if (suffixHolds(window, opts)) { chosen = window; break; }
  }
  if (!chosen) return null;
  const end = chosen[chosen.length - 1];
  const aNorad = aSamples[0]?.norad;
  const bNorad = bSamples[0]?.norad;
  if (aNorad == null || bNorad == null) return null;
  return {
    offsetKm: end.offsetKm,
    signedOffsetKm: end.signedOffsetKm,
    driftKmPerDay: linearDriftKmPerDay(chosen),
    dIncDeg: end.dIncDeg,
    dRaanDeg: end.dRaanDeg,
    dSmaKm: end.dSmaKm,
    crossTrackKm: end.crossTrackKm,
    samples: chosen.length,
    spanDays: (end.atMs - chosen[0].atMs) / 86400_000,
    latestEpochMs: end.atMs,
    spanStartMs: chosen[0].atMs,
    leadNorad: end.signedOffsetKm >= 0 ? aNorad : bNorad,
    trailNorad: end.signedOffsetKm >= 0 ? bNorad : aNorad,
  };
}

export interface StationKeepingHit {
  a: number;
  b: number;
  verdict: StationKeepingVerdict;
}

function mergeLatest(list: ElementSample[], latest: ElementSample | undefined): ElementSample[] {
  if (!latest) return list;
  if (list.some((s) => Math.abs(s.epochMs - latest.epochMs) < 1000)) return list;
  return [...list, latest];
}

/**
 * Prefilter, then classify from history. `loadHistory` must seek only the
 * norads passed in — the scan wires that to a VALUES/LATERAL query.
 */
export async function screenStationKeeping(input: {
  latest: ElementSample[];
  catalog: Map<number, StationKeepingCatalog>;
  excludePairs?: Set<string>;
  nowMs: number;
  opts?: StationKeepingOptions;
  loadHistory: (norads: number[], sinceMs: number, untilMs: number, limit: number) => Promise<ElementSample[]>;
}): Promise<{ hits: StationKeepingHit[]; candidates: number; capped: boolean }> {
  const opts = input.opts ?? DEFAULT_STATION_KEEPING;
  const all = prefilterStationKeepingPairs(input.latest, input.catalog, input.nowMs, opts);
  const candidates = all.filter((c) => !input.excludePairs?.has(stationPairKey(c.a.norad, c.b.norad)));
  const capped = candidates.length > opts.pairCap;
  const kept = capped ? candidates.slice(0, opts.pairCap) : candidates;
  if (kept.length === 0) return { hits: [], candidates: candidates.length, capped };
  const norads = [...new Set(kept.flatMap((c) => [c.a.norad, c.b.norad]))];
  const sinceMs = input.nowMs - opts.historyMs;
  const history = await input.loadHistory(norads, sinceMs, input.nowMs + 6 * 3600_000, opts.maxSamplesPerObject);
  const byNorad = new Map<number, ElementSample[]>();
  for (const s of history) {
    const arr = byNorad.get(s.norad) ?? [];
    arr.push(s);
    byNorad.set(s.norad, arr);
  }
  const latestByNorad = new Map(input.latest.map((e) => [e.norad, e]));
  const hits: StationKeepingHit[] = [];
  for (const c of kept) {
    const aSamples = mergeLatest(byNorad.get(c.a.norad) ?? [], latestByNorad.get(c.a.norad));
    const bSamples = mergeLatest(byNorad.get(c.b.norad) ?? [], latestByNorad.get(c.b.norad));
    const verdict = classifyStationKeeping(aSamples, bSamples, input.nowMs, opts);
    if (!verdict) continue;
    hits.push({ a: c.a.norad, b: c.b.norad, verdict });
  }
  return { hits, candidates: candidates.length, capped };
}

/** Argument of perigee and mean anomaly from TLE line 2, same columns as the coplanar screen. */
export function argumentAndAnomaly(line2: string): { argPerigeeDeg: number; meanAnomalyDeg: number } | null {
  if (typeof line2 !== "string" || line2.length < 51) return null;
  const argPerigeeDeg = parseFloat(line2.slice(34, 42));
  const meanAnomalyDeg = parseFloat(line2.slice(43, 51));
  if (!Number.isFinite(argPerigeeDeg) || !Number.isFinite(meanAnomalyDeg)) return null;
  return { argPerigeeDeg, meanAnomalyDeg };
}

/**
 * History for an explicit NORAD list. One lateral index seek per id, capped,
 * no TLE text, no catalog scan. Null when there is nothing to seek.
 */
export function stationKeepingHistorySql(
  norads: number[],
  since: Date,
  until: Date,
  limit: number,
): SQL | null {
  const ids = [...new Set(norads.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return null;
  const cap = Math.max(1, Math.min(50, Math.floor(limit)));
  const values = sql.join(ids.map((n) => sql`(${n}::int)`), sql`, `);
  return sql`
    SELECT
      h.norad,
      h.epoch,
      h.inc_deg,
      h.raan_deg,
      h.eccentricity,
      h.arg_perigee_deg,
      h.mean_anomaly_deg,
      h.mean_motion_rev_per_day
    FROM (VALUES ${values}) AS n(norad)
    JOIN LATERAL (
      SELECT
        norad,
        epoch,
        inc_deg,
        raan_deg,
        eccentricity,
        arg_perigee_deg,
        mean_anomaly_deg,
        mean_motion_rev_per_day
      FROM obc_tle_history
      WHERE obc_tle_history.norad = n.norad
        AND obc_tle_history.epoch >= ${since}
        AND obc_tle_history.epoch <= ${until}
      ORDER BY epoch DESC
      LIMIT ${sql.raw(String(cap))}
    ) AS h ON true
  `;
}

function asRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return n;
}

export async function loadStationKeepingSamples(
  norads: number[],
  sinceMs: number,
  untilMs: number,
  limit: number,
  execute: (query: SQL) => Promise<unknown> = (query) => db.execute(query),
): Promise<ElementSample[]> {
  const query = stationKeepingHistorySql(norads, new Date(sinceMs), new Date(untilMs), limit);
  if (!query) return [];
  const rows = asRows(await execute(query));
  const out: ElementSample[] = [];
  for (const r of rows) {
    const epoch = r.epoch instanceof Date ? r.epoch.getTime() : Date.parse(String(r.epoch));
    const sample: ElementSample = {
      norad: asNumber(r.norad),
      epochMs: epoch,
      incDeg: asNumber(r.inc_deg),
      raanDeg: asNumber(r.raan_deg),
      eccentricity: asNumber(r.eccentricity),
      argPerigeeDeg: asNumber(r.arg_perigee_deg),
      meanAnomalyDeg: asNumber(r.mean_anomaly_deg),
      meanMotionRevPerDay: asNumber(r.mean_motion_rev_per_day),
    };
    if (!Number.isFinite(sample.norad) || !Number.isFinite(sample.epochMs)) continue;
    out.push(sample);
  }
  return out;
}

/**
 * Ledger keys live at and above 1e9 so they never collide with +eventId
 * (opening citation) or -eventId (the one range-escalation follow-up).
 * Generation 0 is onset. Each significant offset change increments it,
 * so the same offset does not queue again and a later change can.
 */
export const STATION_KEEPING_LEDGER_BASE = 1_000_000_000;

export function stationKeepingLedgerKey(eventId: number, generation: number): number {
  const gen = Math.max(0, Math.floor(generation));
  return STATION_KEEPING_LEDGER_BASE + eventId * 100 + gen;
}

export interface StationKeepingAlertState {
  alertAnchorKm: number | null;
  alertGeneration: number;
}

export function readStationKeepingAlertState(meta: unknown): StationKeepingAlertState {
  if (!meta || typeof meta !== "object") return { alertAnchorKm: null, alertGeneration: 0 };
  const sk = (meta as { stationKeeping?: unknown }).stationKeeping;
  if (!sk || typeof sk !== "object") return { alertAnchorKm: null, alertGeneration: 0 };
  const row = sk as { alertAnchorKm?: unknown; alertGeneration?: unknown };
  const anchor = typeof row.alertAnchorKm === "number" ? row.alertAnchorKm : Number(row.alertAnchorKm);
  const generation = typeof row.alertGeneration === "number" ? row.alertGeneration : Number(row.alertGeneration);
  return {
    alertAnchorKm: Number.isFinite(anchor) ? anchor : null,
    alertGeneration: Number.isFinite(generation) && generation >= 0 ? Math.floor(generation) : 0,
  };
}

/**
 * Onset when this case has not been alerted. A later scan alerts only when
 * the absolute offset has moved by `significantKm` from that anchor.
 * Hourly repeats inside the band return null and keep the anchor.
 */
export function stationKeepingAlertStep(
  offsetKm: number,
  anchorKm: number | null,
  generation: number,
  significantKm: number,
): { what: "onset" | "change" | null; anchorKm: number; generation: number } {
  const gen = Number.isFinite(generation) && generation >= 0 ? Math.floor(generation) : 0;
  if (anchorKm == null || !Number.isFinite(anchorKm)) {
    return { what: "onset", anchorKm: offsetKm, generation: gen };
  }
  if (Math.abs(offsetKm - anchorKm) >= significantKm) {
    return { what: "change", anchorKm: offsetKm, generation: gen + 1 };
  }
  return { what: null, anchorKm, generation: gen };
}

/** Conjunction / coplanar / docked still share one file. Station keeping does not. */
export function rpodKindsShareAFile(existing: string, incoming: string): boolean {
  if (existing === "station-keeping" || incoming === "station-keeping") return existing === incoming;
  return true;
}

/** One review-queue row. The scan fills `eventId` / `ledgerKey` after the case id exists. */
export interface StationKeepingQueuedAlert {
  eventId: number;
  members: number[];
  minRangeKm: number;
  relVelKmS: number;
  tcaMs: number;
  what: "onset" | "change";
  ledgerKey: number;
  offsetKm: number;
  previousOffsetKm: number | null;
  driftKmPerDay: number;
  dIncDeg: number;
  dRaanDeg: number;
  dSmaKm: number;
  leadNorad: number;
  trailNorad: number;
}
