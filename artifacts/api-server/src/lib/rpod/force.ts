/**
 * Red / neutral / blue for an RPOD object.
 *
 * Codes are the GCAT state/owner abbreviations (US, RU, SU, CN, J, I, UK, F,
 * IR, KP, …) and the Space-Track COUNTRY abbreviations (PRC, CIS, JPN, SKOR,
 * TBD, …). RPOD_FORCE_TABLE, a JSON object of code → "red"|"blue"|"neutral",
 * overlays the defaults so an operator can retune without a deploy.
 *
 * Unnamed debris (OBJECT/DEB/…) with no country of its own inherits the
 * launch state's force. SU and RU are both red, so a Soviet-era piece next
 * to a Russian payload is the same force.
 */

export type Force = "red" | "neutral" | "blue";

const RED = [
  "RU", "RUS", "RUSSIA", "SU", "USSR", "SOVIET", "CIS",
  "CN", "CHN", "PRC", "CHINA",
  "IR", "IRAN",
  "KP", "PRK", "NKOR", "DPRK", "NORTHKOREA",
] as const;

/** US, UK, Japan, Finland, EU members, and the usual treaty allies. */
const BLUE = [
  "US", "USA", "UNITEDSTATES",
  "UK", "GB", "GBR", "UNITEDKINGDOM",
  "J", "JP", "JPN", "JAPAN",
  "FI", "FIN", "FINLAND",
  // EU
  "F", "FR", "FRA", "FRANCE",
  "I", "IT", "ITA", "ITALY",
  "D", "DE", "DEU", "GER", "GERMANY",
  "E", "ES", "ESP", "SPN", "SPAIN",
  "NL", "NETH", "NLD", "NETHERLANDS",
  "B", "BE", "BEL", "BELGIUM",
  "SE", "S", "SWE", "SWED", "SWEDEN",
  "DK", "DEN", "DNK", "DENMARK",
  "PL", "POL", "POLAND",
  "PT", "POR", "PORTUGAL",
  "GR", "GRC", "GREC", "GREECE",
  "AT", "AUT", "AUSTRIA",
  "IE", "IRL", "IRELAND",
  "CZ", "CZE", "CZECH", "CZECHIA",
  "HU", "HUN", "HUNGARY",
  "RO", "ROU", "ROM", "ROMANIA",
  "BG", "BGR", "BULGARIA",
  "HR", "HRV", "CROATIA",
  "SK", "SVK", "SLOVAKIA",
  "SI", "SVN", "SLOVENIA",
  "LT", "LTU", "LITHUANIA",
  "LV", "LVA", "LATVIA",
  "EE", "EST", "ESTONIA",
  "LU", "LUX", "LUXE", "LUXEMBOURG",
  "MT", "MLT", "MALTA",
  "CY", "CYP", "CYPRUS",
  // other allies
  "CA", "CAN", "CANADA",
  "AU", "AUS", "AUSTRALIA",
  "NZ", "NZL", "NEWZEALAND",
  "KR", "KOR", "SKOR", "ROK", "SOUTHKOREA", "KOREA",
  "ROC", "TW", "TWN", "TAIWAN",
  "IL", "ISR", "ISRA", "ISRAEL",
  "NO", "NOR", "NORWAY",
  "IS", "ISL", "ICELAND",
] as const;

const NEUTRAL = [
  "TBD", "UNK", "UNKNOWN", "NONE", "NA",
  "ESA", "EUM", "EUMETSAT",
  "ISS", "INT", "INTERNATIONAL", "MULTI",
  "UN", "UNO", "NATO", "ITSO", "INTELSAT",
] as const;

function tableFrom(codes: readonly string[], force: Force): Record<string, Force> {
  const out: Record<string, Force> = {};
  for (const c of codes) out[c] = force;
  return out;
}

export const DEFAULT_FORCE_TABLE: Record<string, Force> = {
  ...tableFrom(RED, "red"),
  ...tableFrom(BLUE, "blue"),
  ...tableFrom(NEUTRAL, "neutral"),
};

let cached: { key: string; table: Record<string, Force> } | null = null;

/** Defaults plus the RPOD_FORCE_TABLE overlay. Cached until the env string changes. */
export function forceTable(env: NodeJS.ProcessEnv = process.env): Record<string, Force> {
  const extra = env.RPOD_FORCE_TABLE ?? "";
  if (cached && cached.key === extra) return cached.table;
  const table: Record<string, Force> = { ...DEFAULT_FORCE_TABLE };
  if (extra.trim()) {
    try {
      const parsed = JSON.parse(extra) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v === "red" || v === "blue" || v === "neutral") table[k.trim().toUpperCase()] = v;
      }
    } catch {
      // Bad JSON leaves the defaults in place.
    }
  }
  cached = { key: extra, table };
  return table;
}

export function resetForceTableCache(): void {
  cached = null;
}

export interface ForceObject {
  name?: string | null;
  owner?: string | null;
  state?: string | null;
  gunterNation?: string | null;
  objectClass?: string | null;
  /** State/owner of the launch this unnamed piece rode, when its own code is blank or TBD. */
  launchState?: string | null;
  launchOwner?: string | null;
}

const UNNAMED_RE = /^(object|debris|deb|unknown|unk|tba|tbd|payload|r\/b|rocket body|sl-\d+)\b/i;

export function isUnnamedPiece(obj: Pick<ForceObject, "name" | "objectClass">): boolean {
  const name = obj.name?.trim() ?? "";
  if (!name) return obj.objectClass === "D" || obj.objectClass === "R" || obj.objectClass === "U";
  if (UNNAMED_RE.test(name)) return true;
  if ((obj.objectClass === "D" || obj.objectClass === "R") && /^[\d\s-]+$/.test(name)) return true;
  return false;
}

function compact(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/**
 * Force for one catalog code, or null when the code isn't in the table.
 * "I-ESA" resolves to Italy (blue) rather than the ESA org token.
 * Conflicting country tokens on one string ("US/RU") are neutral.
 */
export function forceFromCode(raw: string | null | undefined, table: Record<string, Force> = forceTable()): Force | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-") return null;
  const whole = compact(trimmed);
  if (!whole) return null;
  if (table[whole]) return table[whole];
  const parts = trimmed.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  let found: Force | null = null;
  for (const p of parts) {
    const f = table[p];
    if (!f || f === "neutral") continue;
    if (found && found !== f) return "neutral";
    found = f;
  }
  if (found) return found;
  if (parts.some((p) => table[p] === "neutral")) return "neutral";
  return null;
}

function firstDecisive(codes: (string | null | undefined)[], table: Record<string, Force>): Force | null {
  for (const c of codes) {
    const f = forceFromCode(c, table);
    if (f && f !== "neutral") return f;
  }
  for (const c of codes) {
    if (forceFromCode(c, table) === "neutral") return "neutral";
  }
  return null;
}

export function forceOf(obj: ForceObject, table: Record<string, Force> = forceTable()): Force {
  const own = firstDecisive([obj.state, obj.owner, obj.gunterNation], table);
  if (own && own !== "neutral") return own;
  if (isUnnamedPiece(obj)) {
    const inherited = firstDecisive([obj.launchState, obj.launchOwner], table);
    if (inherited && inherited !== "neutral") return inherited;
  }
  return own ?? "neutral";
}

/** A red object paired with blue or neutral. Red-red (including SU vs RU) is not. */
export function forcesWarrantAlert(forces: Force[]): boolean {
  if (forces.length < 2) return false;
  const red = forces.some((f) => f === "red");
  const other = forces.some((f) => f === "blue" || f === "neutral");
  return red && other;
}

export function sameForce(forces: Force[]): boolean {
  return forces.length >= 2 && forces.every((f) => f === forces[0]);
}
