import { Router, type IRouter } from "express";
import { getSatcat, type SatcatEntry } from "../lib/satcat";

const router: IRouter = Router();

/**
 * Constellation membership by payload name pattern.
 * Order matters only for readability; patterns are mutually exclusive in practice.
 */
const CONSTELLATIONS: { name: string; test: (n: string) => boolean }[] = [
  { name: "Starlink", test: (n) => n.startsWith("STARLINK") },
  { name: "OneWeb", test: (n) => n.startsWith("ONEWEB") },
  { name: "Kuiper", test: (n) => n.startsWith("KUIPER") },
  { name: "Qianfan", test: (n) => n.startsWith("QIANFAN") },
  { name: "Iridium", test: (n) => n.startsWith("IRIDIUM") },
  { name: "Globalstar", test: (n) => n.startsWith("GLOBALSTAR") },
  { name: "Orbcomm", test: (n) => n.startsWith("ORBCOMM") },
  { name: "Flock (Planet)", test: (n) => n.startsWith("FLOCK") },
  { name: "Lemur (Spire)", test: (n) => n.startsWith("LEMUR") },
  { name: "Gonets", test: (n) => n.startsWith("GONETS") },
];

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function ldateToMs(ldate: string | null): number | null {
  if (!ldate) return null;
  const iso = ldate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const y = ldate.match(/^(\d{4})/);
  return y ? Date.UTC(+y[1], 0, 1) : null;
}

function decayToMs(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const gcat = s.match(/^(\d{4})\s+([A-Za-z]{3})\s*(\d+)?/);
  if (gcat) return Date.UTC(+gcat[1], MONTHS[gcat[2]] ?? 0, gcat[3] ? +gcat[3] : 1);
  const y = s.match(/^(\d{4})/);
  return y ? Date.UTC(+y[1], 0, 1) : null;
}

interface Member {
  constellation: string;
  launchMs: number;
  decayMs: number | null; // null = still in orbit
  massKg: number | null;
  altKm: number | null;
  incDeg: number | null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Bucket key for an orbital shell, by inclination (rounded to whole degrees).
 * GCAT's apogee/perigee columns record the INITIAL (injection) orbit, so
 * altitude is not a reliable shell discriminator — inclination is.
 */
function shellKey(m: Member): string {
  if (m.incDeg == null) return "unknown";
  return String(Math.round(m.incDeg));
}

/** Bucket key for a hardware variant: mass class in ~15% geometric steps. */
function variantKey(m: Member): string {
  if (m.massKg == null || m.massKg <= 0) return "unknown";
  return String(Math.round(Math.log(m.massKg) / Math.log(1.15)));
}

function segmentSeries(
  members: Member[],
  quarterEnds: number[],
  keyFn: (m: Member) => string,
  labelFn: (ms: Member[]) => string,
  maxSegments: number,
  otherLabel: string,
): { label: string; active: number[] }[] {
  const groups = new Map<string, Member[]>();
  for (const m of members) {
    const k = keyFn(m);
    const g = groups.get(k);
    if (g) g.push(m);
    else groups.set(k, [m]);
  }
  const ranked = [...groups.entries()]
    .filter(([k]) => k !== "unknown")
    .sort((a, b) => b[1].length - a[1].length);
  const top = ranked.slice(0, maxSegments);
  const rest = ranked.slice(maxSegments).flatMap(([, ms]) => ms)
    .concat(groups.get("unknown") ?? []);

  const activeSeries = (ms: Member[]) =>
    quarterEnds.map((t) =>
      ms.reduce((n, m) => n + (m.launchMs <= t && (m.decayMs == null || m.decayMs > t) ? 1 : 0), 0),
    );

  const out = top.map(([, ms]) => ({ label: labelFn(ms), active: activeSeries(ms) }));
  if (rest.length > 0) out.push({ label: otherLabel, active: activeSeries(rest) });
  return out;
}

let cached: { at: number; body: unknown } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

router.get("/satcat/constellations", async (_req, res): Promise<void> => {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.json(cached.body);
    return;
  }
  const data = await getSatcat();

  // Membership: payloads only, matched by name.
  const members: Member[] = [];
  for (const e of data) {
    if (e.objectClass !== "P") continue;
    const upper = e.name.toUpperCase();
    const c = CONSTELLATIONS.find((c) => c.test(upper));
    if (!c) continue;
    const launchMs = ldateToMs(e.ldate);
    if (launchMs == null) continue;
    const alt =
      e.apogeeKm != null && e.perigeeKm != null ? (e.apogeeKm + e.perigeeKm) / 2 : null;
    members.push({
      constellation: c.name,
      launchMs,
      decayMs: decayToMs(e.decayDate),
      massKg: e.massKg,
      altKm: alt,
      incDeg: e.incDeg,
    });
  }

  // Shared quarterly axis from the first constellation launch to now.
  const firstMs = members.reduce((m, x) => Math.min(m, x.launchMs), Date.now());
  const firstYear = Math.max(1990, new Date(firstMs).getUTCFullYear());
  const now = new Date();
  const quarters: string[] = [];
  const quarterEnds: number[] = [];
  for (let y = firstYear; y <= now.getUTCFullYear(); y++) {
    for (let q = 0; q < 4; q++) {
      const end = Date.UTC(y, q * 3 + 3, 1) - 1;
      const start = Date.UTC(y, q * 3, 1);
      if (start > Date.now()) break;
      const partial = end > Date.now();
      quarters.push(partial ? "NOW" : `${y}-Q${q + 1}`);
      quarterEnds.push(partial ? Date.now() : end);
    }
  }

  const byConstellation = new Map<string, Member[]>();
  for (const m of members) {
    const g = byConstellation.get(m.constellation);
    if (g) g.push(m);
    else byConstellation.set(m.constellation, [m]);
  }

  const nowMs = Date.now();
  const activeNow = (ms: Member[]) =>
    ms.filter((m) => m.launchMs <= nowMs && (m.decayMs == null || m.decayMs > nowMs)).length;

  // Overall tracker, largest constellations first.
  const overall = [...byConstellation.entries()]
    .sort((a, b) => activeNow(b[1]) - activeNow(a[1]))
    .map(([name, ms]) => ({
      name,
      active: quarterEnds.map((t) =>
        ms.reduce((n, m) => n + (m.launchMs <= t && (m.decayMs == null || m.decayMs > t) ? 1 : 0), 0),
      ),
    }));

  // Annual deployment cadence.
  const launchYears: number[] = [];
  for (let y = firstYear; y <= now.getUTCFullYear(); y++) launchYears.push(y);
  const launchedPerYear = overall.map(({ name }) => {
    const ms = byConstellation.get(name) ?? [];
    const counts = launchYears.map((y) =>
      ms.reduce((n, m) => n + (new Date(m.launchMs).getUTCFullYear() === y ? 1 : 0), 0),
    );
    return { name, counts };
  });

  // Breakouts for the biggest players.
  const breakouts = overall.slice(0, 6).map(({ name }) => {
    const ms = byConstellation.get(name) ?? [];
    const shells = segmentSeries(
      ms,
      quarterEnds,
      shellKey,
      (g) => {
        const incs = g.map((m) => m.incDeg).filter((x): x is number => x != null);
        return `${median(incs).toFixed(1)}° SHELL`;
      },
      5,
      "OTHER SHELLS",
    );
    const variants = segmentSeries(
      ms,
      quarterEnds,
      variantKey,
      (g) => {
        const masses = g.map((m) => m.massKg).filter((x): x is number => x != null && x > 0);
        return `≈${Math.round(median(masses)).toLocaleString()} kg class`;
      },
      4,
      "OTHER / UNSPECIFIED",
    );
    const launched = ms.length;
    const active = activeNow(ms);
    const massTonnes =
      Math.round(ms.reduce((s, m) => s + (m.massKg ?? 0), 0) / 100) / 10;
    return {
      name,
      totals: { launched, active, decayed: launched - active, massTonnes },
      shells,
      variants,
    };
  });

  const body = { quarters, overall, launchYears, launchedPerYear, breakouts };
  cached = { at: Date.now(), body };
  res.json(body);
});

export default router;
