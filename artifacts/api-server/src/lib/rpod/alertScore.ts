/**
 * Placeholder rank used until the persistence scorer fills the queue.
 * Closer and slower outranks a distant, faster pass. Pure — no DB.
 */
export function provisionalAlertScore(ev: { minRangeKm: number; relVelKmS: number }): number {
  const range = Math.max(ev.minRangeKm, 0.05);
  const vel = Math.max(ev.relVelKmS, 0.001);
  return Math.round((10 / range) * (0.05 / vel) * 100) / 100;
}
