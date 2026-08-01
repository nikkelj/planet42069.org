/**
 * Pure retirement policy for coplanar (shadowing) events — kept free of db
 * imports so tests can exercise the transition rule directly.
 *
 * Once a pair stops station-keeping it drifts hundreds of km/day and fails
 * the co-aligned screen almost immediately. The scan runs hourly, so 48h of
 * no re-detection ≈ dozens of consecutive missed scans — enough slack to
 * ride out elset gaps without letting dead cases linger for weeks.
 */
export const COPLANAR_END_AFTER_MS = 48 * 3600_000;

/**
 * Given the currently ACTIVE coplanar events, return the ids whose
 * lastSeenAt (last scan that re-detected them) is older than the retirement
 * threshold at `nowMs`.
 */
export function selectEndedCoplanarIds(
  events: { id: number; lastSeenAt: Date }[],
  nowMs: number,
): number[] {
  return events.filter((e) => nowMs - e.lastSeenAt.getTime() > COPLANAR_END_AFTER_MS).map((e) => e.id);
}
