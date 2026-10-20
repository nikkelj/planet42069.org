/**
 * International designators for the co-launch filter.
 *
 * GCAT stores Launch_Tag ("2024-043") and Piece ("F") separately. Space-Track
 * OBJECT_ID is the full "2024-043F", but a missing OBJECT_ID used to be written
 * through as NULL and wipe the designator. Either form is enough to recover
 * the launch tag (`YYYY-NNN`).
 */

/** "2024-043" + "F" → "2024-043F". A piece that is already a full designator is kept. */
export function gcatIntlDesignator(
  launchTag: string | null | undefined,
  piece: string | null | undefined,
): string | null {
  const tag = launchTag?.trim().toUpperCase() || "";
  const p = piece?.trim().toUpperCase() || "";
  if (/^\d{4}-[A-Z0-9]{3,}[A-Z]+$/.test(p) || /^\d{4}-\d{3}[A-Z]{1,3}$/.test(p)) return p;
  if (!tag) return null;
  if (!p) return tag;
  if (p.startsWith(tag)) return p;
  return `${tag}${p}`;
}

/** Launch tag embedded in a COSPAR id, e.g. "2024-043F" → "2024-043". */
export function launchTagFromIntl(intlDes: string | null | undefined): string | null {
  const m = intlDes?.trim().toUpperCase().match(/^(\d{4}-[A-Z0-9]\d{2})/);
  return m ? m[1] : null;
}

/**
 * TLE line 1 columns 10–17 are the YYNNNPPP designator ("24043F").
 * Returns null when the field is blank or the line is shifted (Alpha-5).
 */
export function designatorFromTleLine1(line1: string | null | undefined): { intlDes: string; launchTag: string } | null {
  if (!line1 || line1.length < 18 || !line1.startsWith("1")) return null;
  const raw = line1.slice(9, 17).trim().toUpperCase();
  const m = raw.match(/^(\d{2})(\d{3})([A-Z]{1,3})$/);
  if (!m) return null;
  const yy = parseInt(m[1], 10);
  const year = yy >= 57 ? 1900 + yy : 2000 + yy;
  const launchTag = `${year}-${m[2]}`;
  return { intlDes: `${launchTag}${m[3]}`, launchTag };
}
