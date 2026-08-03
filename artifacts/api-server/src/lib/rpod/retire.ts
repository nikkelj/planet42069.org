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

/**
 * How long an ended shadowing case remains eligible for reopening. Pairs
 * that resume station-keeping within this window get their original case
 * reactivated (same RPOD number) instead of a fresh case, so repeat
 * offenders keep a single continuous file.
 */
export const COPLANAR_REOPEN_WINDOW_MS = 90 * 86400_000;

/**
 * How long a STALE conjunction-track case (conjunction/docked) remains
 * eligible for reactivation. Discrete approaches recur on shorter horizons
 * than shadowing campaigns, so the window is tighter than the coplanar one:
 * a pair re-flagged within 30 days of last being seen continues the same
 * case file instead of splitting its history across two case numbers.
 */
export const CONJUNCTION_REOPEN_WINDOW_MS = 30 * 86400_000;

/**
 * Pure reopen decision: given recently-ENDED coplanar events (with their
 * memberships) and the member set of a newly detected coplanar cluster,
 * return the id of the ended case to reactivate, or null when a brand-new
 * case should be opened.
 *
 * Rules mirror the active-event upsert: ≥2 shared members counts as the
 * same pair. Only cases ended within COPLANAR_REOPEN_WINDOW_MS qualify.
 * When several qualify, the most recently ended one wins (its history is
 * the freshest continuation of the pair).
 */
export function selectReopenCandidate(
  endedEvents: { id: number; endedAt: Date | null; members: number[] }[],
  incomingMembers: number[],
  nowMs: number,
  reopenWindowMs: number = COPLANAR_REOPEN_WINDOW_MS,
): number | null {
  const incoming = new Set(incomingMembers);
  let best: { id: number; endedAtMs: number } | null = null;
  for (const ev of endedEvents) {
    if (!ev.endedAt) continue;
    const endedAtMs = ev.endedAt.getTime();
    if (nowMs - endedAtMs > reopenWindowMs) continue;
    let shared = 0;
    for (const n of ev.members) if (incoming.has(n)) shared++;
    if (shared < 2) continue;
    if (!best || endedAtMs > best.endedAtMs) best = { id: ev.id, endedAtMs };
  }
  return best?.id ?? null;
}
