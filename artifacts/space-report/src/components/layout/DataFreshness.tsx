import { useEffect, useState } from "react";
import { useGetSatcatSummary } from "@workspace/api-client-react";
import { Clock } from "lucide-react";

/** Latest successful catalogue sync time, from the summary freshness block. */
function latestSync(freshness?: {
  gcatSyncedAt: string | null;
  spacetrackSyncedAt: string | null;
  mergeSyncedAt: string | null;
  gunterSyncedAt: string | null;
}): Date | null {
  if (!freshness) return null;
  const times = [
    freshness.mergeSyncedAt,
    freshness.gcatSyncedAt,
    freshness.spacetrackSyncedAt,
    freshness.gunterSyncedAt,
  ]
    .filter((t): t is string => t !== null)
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  return new Date(Math.max(...times));
}

function relativeAge(from: Date, now: number): string {
  const mins = Math.max(0, Math.floor((now - from.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * Small "data as of" indicator so visitors know how current the catalogue is.
 * Reuses the summary query (deduped by react-query with the briefing page).
 */
export function DataFreshness() {
  const { data: summary } = useGetSatcatSummary();
  const [now, setNow] = useState(() => Date.now());

  // Re-render every minute so the relative age stays honest.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const synced = latestSync(summary?.freshness);
  if (!synced) return null;

  const utc = synced.toISOString().slice(0, 16).replace("T", " ");

  return (
    <div
      className="flex items-center gap-2 uppercase tracking-widest text-[10px] text-muted-foreground font-mono"
      data-testid="data-freshness"
      title={`Catalogue last synced ${utc} UTC`}
    >
      <Clock className="w-3 h-3 text-primary" aria-hidden="true" />
      <span>
        DATA AS OF {utc} UTC <span className="text-primary/80">({relativeAge(synced, now)})</span>
      </span>
    </div>
  );
}
