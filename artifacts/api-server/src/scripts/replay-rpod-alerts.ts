/**
 * Replay the alert policy against stored RPOD events.
 *
 * Reads a JSON dump of GET /api/rpod/events (default /tmp/rpod-replay/events.json)
 * and, for cases that pass every gate except the live elset, fetches
 * GET /api/rpod/events/:id so launch tags and epochs come from the TLE.
 *
 * Historical elsets at the moment a case first became persistent are not in
 * the public API — freshness is judged on the latest published epochs versus
 * `now`. Scan counts are not stored on old rows; a case whose first-seen to
 * last-seen span is at least 6 h is treated as ≥2 scans (the scanner is hourly).
 *
 *   pnpm --filter @workspace/api-server exec tsx ./src/scripts/replay-rpod-alerts.ts
 */
import { readFileSync } from "node:fs";
import {
  applyAlertCap,
  evaluateAlert,
  type PolicyEvent,
  type PolicyMember,
} from "../lib/rpod/alertPolicy";
import { designatorFromTleLine1 } from "../lib/obc/designator";
import { isSuspectedCrossTag, type ElsetSnap } from "../lib/rpod/maneuver";

const WINDOW_START = Date.parse("2026-10-15T00:00:00Z");
const WINDOW_END = Date.parse("2026-10-20T00:00:00Z");
const PERSIST_MS = 6 * 3600_000;
const API = process.env.RPOD_REPLAY_API ?? "https://www.planet42069.org";

interface ApiMember {
  norad: number;
  name: string | null;
  owner: string | null;
  state: string | null;
  objectClass: string | null;
  opOrbit: string | null;
  ldate: string | null;
  minRangeKm?: number | null;
  relVelKmS?: number | null;
  tle?: {
    line1?: string;
    epoch?: string;
    incDeg?: number;
    raanDeg?: number;
    eccentricity?: number;
    argPerigeeDeg?: number;
    meanAnomalyDeg?: number;
    meanMotionRevPerDay?: number;
  } | null;
}

interface ApiEvent {
  id: number;
  status: string;
  kind: string;
  minRangeKm: number;
  relVelKmS: number;
  firstDetectedAt: string;
  lastSeenAt: string;
  members: ApiMember[];
}

interface Merged {
  ids: number[];
  kind: string;
  status: string;
  minRangeKm: number;
  relVelKmS: number;
  firstDetectedAtMs: number;
  lastSeenAtMs: number;
  members: ApiMember[];
  bogusDockIds: number[];
}

function pairKey(norads: number[]): string {
  return [...norads].sort((a, b) => a - b).join(":");
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function snapFrom(m: ApiMember): ElsetSnap | null {
  const t = m.tle;
  if (!t?.epoch || t.incDeg == null || t.raanDeg == null || t.eccentricity == null || t.meanMotionRevPerDay == null) return null;
  const epochMs = Date.parse(t.epoch);
  if (!Number.isFinite(epochMs)) return null;
  return {
    epochMs,
    incDeg: t.incDeg,
    raanDeg: t.raanDeg,
    eccentricity: t.eccentricity,
    meanMotionRevPerDay: t.meanMotionRevPerDay,
    argPerigeeDeg: t.argPerigeeDeg ?? null,
    meanAnomalyDeg: t.meanAnomalyDeg ?? null,
  };
}

function toPolicy(m: Merged, nowMs: number): PolicyEvent {
  const span = m.lastSeenAtMs - m.firstDetectedAtMs;
  const members: PolicyMember[] = m.members.map((mem) => {
    const tag = designatorFromTleLine1(mem.tle?.line1)?.launchTag ?? null;
    return {
      norad: mem.norad,
      name: mem.name,
      owner: mem.owner,
      state: mem.state,
      objectClass: mem.objectClass,
      opOrbit: mem.opOrbit,
      launchTag: tag,
      elset: snapFrom(mem),
      closestRangeKm: mem.minRangeKm ?? null,
      closestRelVelKmS: mem.relVelKmS ?? null,
    };
  });
  const cross = members.length === 2 && members[0].elset && members[1].elset
    ? isSuspectedCrossTag(members[0].elset, members[1].elset)
    : false;
  return {
    eventId: m.ids[0],
    kind: m.kind,
    members,
    minRangeKm: m.minRangeKm,
    relVelKmS: m.relVelKmS,
    firstDetectedAtMs: m.firstDetectedAtMs,
    lastSeenAtMs: m.lastSeenAtMs,
    scanCount: span >= PERSIST_MS ? Math.max(2, Math.round(span / 3600_000)) : 1,
    previousElsetEpochs: null,
    suspectedCrossTag: cross,
    messyCluster: m.members.length >= 6,
  };
}

/** Prefer a real coplanar/conjunction range over a bogus ~0 docked reading. */
function mergeGroup(rows: ApiEvent[]): Merged {
  const real = rows.filter((r) => !(r.kind === "docked" && r.minRangeKm < 1));
  const pool = real.length ? real : rows;
  const coplanar = pool.find((r) => r.kind === "coplanar");
  const tightest = [...pool].sort((a, b) => a.minRangeKm - b.minRangeKm)[0];
  const chosen = coplanar ?? tightest;
  return {
    ids: rows.map((r) => r.id).sort((a, b) => a - b),
    kind: coplanar ? "coplanar" : chosen.kind === "docked" ? "docked" : chosen.kind,
    status: rows.some((r) => r.status === "active") ? "active" : chosen.status,
    minRangeKm: chosen.minRangeKm,
    relVelKmS: chosen.relVelKmS,
    firstDetectedAtMs: Math.min(...rows.map((r) => Date.parse(r.firstDetectedAt))),
    lastSeenAtMs: Math.max(...rows.map((r) => Date.parse(r.lastSeenAt))),
    members: chosen.members,
    bogusDockIds: rows.filter((r) => r.kind === "docked" && r.minRangeKm < 1).map((r) => r.id),
  };
}

async function fetchDetail(id: number): Promise<ApiEvent | null> {
  const res = await fetch(`${API}/api/rpod/events/${id}`);
  if (!res.ok) return null;
  return await res.json() as ApiEvent;
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? "/tmp/rpod-replay/events.json";
  const events = JSON.parse(readFileSync(path, "utf8")) as ApiEvent[];
  const nowMs = Date.now();
  const recent = events.filter((e) =>
    Date.parse(e.lastSeenAt) >= WINDOW_START || Date.parse(e.firstDetectedAt) >= WINDOW_START);
  const groups = new Map<string, ApiEvent[]>();
  for (const e of recent) {
    if (!e.members || e.members.length < 2) continue;
    const key = pairKey(e.members.map((m) => m.norad));
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  const merged = [...groups.values()].map(mergeGroup);

  // Structural pass with no elsets, so co-launch / freshness are still open.
  const structural = merged.map((m) => {
    const verdict = evaluateAlert(toPolicy(m, nowMs), nowMs);
    return { m, verdict };
  });
  const needTle = structural.filter((s) => s.verdict.eligible || s.verdict.reason === "stale-elset" || s.verdict.reason === "not-persistent");
  // Only spend HTTP on cases that are otherwise in the conversation: eligible
  // once elsets exist, or blocked solely because the list payload has no TLE.
  const shortlist = structural.filter((s) => {
    const span = s.m.lastSeenAtMs - s.m.firstDetectedAtMs;
    return span >= PERSIST_MS && (s.verdict.eligible || s.verdict.reason === "stale-elset");
  });

  console.log(`events in file: ${events.length}`);
  console.log(`seen or opened since 2026-10-15: ${recent.length}`);
  console.log(`unique pairs: ${merged.length}`);
  console.log(`shortlist (span ≥ 6 h, waiting on elsets or already eligible): ${shortlist.length}`);

  const BATCH = 8;
  for (let i = 0; i < shortlist.length; i += BATCH) {
    const slice = shortlist.slice(i, i + BATCH);
    const details = await Promise.all(slice.map((s) => fetchDetail(s.m.ids[0])));
    slice.forEach((s, j) => {
      const detail = details[j];
      if (!detail?.members) return;
      const byNorad = new Map(detail.members.map((mem) => [mem.norad, mem]));
      s.m.members = s.m.members.map((mem) => ({ ...mem, tle: byNorad.get(mem.norad)?.tle ?? null }));
    });
    if (i + BATCH < shortlist.length && (i / BATCH) % 5 === 4) {
      console.log(`  fetched ${Math.min(i + BATCH, shortlist.length)}/${shortlist.length}`);
    }
  }

  type Row = { m: Merged; score: number; bypassCap: boolean; reason: string; onsetMs: number };
  const inWindow: Row[] = [];
  const beforeWindow: Row[] = [];
  const reasons = new Map<string, number>();
  for (const s of shortlist) {
    const verdict = evaluateAlert(toPolicy(s.m, nowMs), nowMs);
    reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
    if (!verdict.eligible) continue;
    const onsetMs = s.m.firstDetectedAtMs + PERSIST_MS;
    const row: Row = { m: s.m, score: verdict.score, bypassCap: verdict.bypassCap, reason: verdict.reason, onsetMs };
    if (onsetMs >= WINDOW_START && onsetMs < WINDOW_END) inWindow.push(row);
    else if (onsetMs < WINDOW_START) beforeWindow.push(row);
  }

  const byDay = new Map<string, Row[]>();
  for (let t = WINDOW_START; t < WINDOW_END; t += 86400_000) byDay.set(dayKey(t), []);
  let held: Row[] = [];
  const posted: { day: string; row: Row }[] = [];
  const stillHeld: Row[] = [];
  for (const [day, born] of byDay) {
    const arriving = inWindow.filter((r) => dayKey(r.onsetMs) === day);
    const capped = applyAlertCap([...held, ...arriving, ...born], 0, 2);
    held = [];
    for (const c of capped) {
      if (c.post) posted.push({ day, row: c.item });
      else held.push(c.item);
    }
  }
  stillHeld.push(...held);

  const kosmos = inWindow.find((r) => r.m.members.some((m) => m.norad === 68762) && r.m.members.some((m) => m.norad === 59103));
  const dock1638 = merged.find((m) => m.ids.includes(1638) || m.bogusDockIds.includes(1638));

  console.log("\nshortlist reasons after TLE fill:");
  for (const [k, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  console.log(`\neligible with onset 2026-10-15..19: ${inWindow.length}`);
  console.log(`eligible whose onset was before Oct 15 (not re-posted): ${beforeWindow.length}`);
  console.log(`would post inside the window: ${posted.length}`);
  console.log(`still held at the end of Oct 19: ${stillHeld.length}`);
  for (const row of stillHeld) {
    const names = row.m.members.map((m) => `${m.name ?? m.norad}`).join(" vs ");
    console.log(`  held score=${row.score} #${row.m.ids.join("+")} ${row.m.minRangeKm} km ${names}`);
  }
  console.log("already eligible before Oct 15 (suppressed, not a new post):");
  for (const row of beforeWindow.sort((a, b) => b.score - a.score)) {
    const names = row.m.members.map((m) => `${m.name ?? m.norad} (${m.state ?? "?"})`).join(" vs ");
    console.log(`  score=${row.score} onset=${dayKey(row.onsetMs)} #${row.m.ids.join("+")} ${row.m.kind} ${row.m.minRangeKm} km ${names}`);
  }
  console.log("\nposts:");
  for (const p of posted) {
    const names = p.row.m.members.map((m) => `${m.name ?? m.norad} (${m.state ?? "?"})`).join(" vs ");
    console.log(`  ${p.day}  score=${p.row.score}  ${p.row.reason}  #${p.row.m.ids.join("+")}  ${p.row.m.kind}  ${p.row.m.minRangeKm} km  ${p.row.m.relVelKmS} km/s  ${names}`);
  }
  if (kosmos) {
    console.log(`\n2612/X36 eligible onset ${new Date(kosmos.onsetMs).toISOString()} score=${kosmos.score} ids=${kosmos.m.ids.join("+")} range=${kosmos.m.minRangeKm} kind=${kosmos.m.kind}`);
    console.log(`  posted: ${posted.some((p) => p.row === kosmos)}`);
  } else {
    console.log("\n2612/X36 did NOT pass the gates");
    const raw = merged.find((m) => m.members.some((x) => x.norad === 68762) && m.members.some((x) => x.norad === 59103));
    if (raw) {
      const v = evaluateAlert(toPolicy(raw, nowMs), nowMs);
      console.log(`  merged ids=${raw.ids.join("+")} kind=${raw.kind} range=${raw.minRangeKm} vel=${raw.relVelKmS} reason=${v.reason}`);
    }
  }
  if (dock1638) {
    const v = evaluateAlert(toPolicy(dock1638, nowMs), nowMs);
    console.log(`event 1638 merged into #${dock1638.ids.join("+")} kind=${dock1638.kind} range=${dock1638.minRangeKm} verdict=${v.reason} eligible=${v.eligible} bogusDockIds=${dock1638.bogusDockIds.join(",")}`);
  }
  console.log(`\n(freshness judged at ${new Date(nowMs).toISOString()} using the latest published elset, not the elset that was current at onset)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
