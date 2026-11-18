/**
 * Mass estimation for catalog objects GCAT hasn't massed yet.
 * Strategy (in order):
 *  1. name-family median — e.g. all "STARLINK" payloads with known mass
 *  2. object-class + LV-family median — e.g. rocket bodies of "Falcon 9"
 *  3. object-class median — global median for P / R rows
 * Debris and components are never estimated (too heterogeneous, tiny masses).
 *
 * Starship-launched payloads are left unestimated. The name-family median for
 * "STARLINK" is the Falcon-era fleet, and the sourced provisional manifest
 * already covers Starship flights. Applying that median would retire the
 * manifest row with a mass GCAT never published.
 */

export interface EstimatableRow {
  name: string;
  objectClass: string | null;
  lvFamily: string | null;
  massKg: number | null;
  massEstimated: boolean;
}

const MIN_SAMPLES = 3;

/** Payload on a Starship-family launcher. The manifest covers these; do not estimate them. */
export function isStarshipLaunchedPayload(row: Pick<EstimatableRow, "objectClass" | "lvFamily">): boolean {
  return row.objectClass === "P" && (row.lvFamily ?? "").toLowerCase().includes("starship");
}

/** "STARLINK-38128" / "STARLINK 11433" / "ONEWEB-0644" → "STARLINK", "ONEWEB" */
export function nameFamilyKey(name: string): string | null {
  const up = name.toUpperCase().trim();
  // Strip trailing separators + digits (possibly repeated groups, e.g. "GONETS-M 24")
  const fam = up.replace(/[\s\-_]*[\d./]+[A-Z]?$/g, "").replace(/[\s\-_]+$/, "").trim();
  return fam.length >= 4 ? fam : null;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface MassModel {
  estimate(row: EstimatableRow): { massKg: number; method: string } | null;
}

/** Build medians from rows with real (non-estimated) masses. */
export function buildMassModel(rows: EstimatableRow[]): MassModel {
  const known = rows.filter(
    (r) => r.massKg != null && r.massKg > 0 && !r.massEstimated,
  );

  const familySamples = new Map<string, number[]>();   // "P|STARLINK" -> masses
  const classLvSamples = new Map<string, number[]>();  // "R|Falcon 9" -> masses
  const classSamples = new Map<string, number[]>();    // "P" -> masses

  for (const r of known) {
    const cls = r.objectClass;
    if (cls !== "P" && cls !== "R") continue;
    const m = r.massKg as number;

    // Keep the STARLINK median Falcon-era. A catalogued Starship V3 must not
    // pull the name-family figure used for Falcon flights.
    const fam = nameFamilyKey(r.name);
    if (fam && !isStarshipLaunchedPayload(r)) {
      const k = `${cls}|${fam}`;
      (familySamples.get(k) ?? familySamples.set(k, []).get(k)!).push(m);
    }
    if (r.lvFamily) {
      const k = `${cls}|${r.lvFamily}`;
      (classLvSamples.get(k) ?? classLvSamples.set(k, []).get(k)!).push(m);
    }
    (classSamples.get(cls) ?? classSamples.set(cls, []).get(cls)!).push(m);
  }

  const medians = (m: Map<string, number[]>) => {
    const out = new Map<string, number>();
    for (const [k, v] of m) if (v.length >= MIN_SAMPLES) out.set(k, median(v));
    return out;
  };

  const familyMed = medians(familySamples);
  const classLvMed = medians(classLvSamples);
  const classMed = medians(classSamples);

  return {
    estimate(row) {
      const cls = row.objectClass;
      if (cls !== "P" && cls !== "R") return null;
      // Name-family, class+vehicle, and class medians all stay off Starship
      // payloads. Falcon Starlinks still use the name-family median below.
      if (isStarshipLaunchedPayload(row)) return null;

      const fam = nameFamilyKey(row.name);
      if (fam) {
        const v = familyMed.get(`${cls}|${fam}`);
        if (v != null) return { massKg: v, method: `name-family:${fam}` };
      }
      if (row.lvFamily) {
        const v = classLvMed.get(`${cls}|${row.lvFamily}`);
        if (v != null) return { massKg: v, method: `class-lv-median:${cls}|${row.lvFamily}` };
      }
      const v = classMed.get(cls);
      if (v != null) return { massKg: v, method: `class-median:${cls}` };
      return null;
    },
  };
}
