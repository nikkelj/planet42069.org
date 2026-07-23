import { useGetSatcatSummary } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Exhibit for Case #MAJORITY-5680 — a live "ballot" bar showing what share
 * of all operational payloads belong to a single constellation. Computed
 * directly from the catalog summary on every page load, so the exhibit
 * cannot go stale (the Bureau does not tolerate stale exhibits).
 */
export function StarlinkMajorityExhibit() {
  const { data: summary, isLoading, isError } = useGetSatcatSummary();

  if (isLoading) {
    return <Skeleton className="h-28 w-full bg-muted" />;
  }
  if (isError || !summary || !summary.activePayloads) {
    return (
      <div className="p-3 border border-destructive/40 text-destructive/80 text-[10px] uppercase tracking-wider text-center">
        Exhibit unavailable — GCAT uplink interrupted. The tally stands regardless.
      </div>
    );
  }

  const starlink = summary.starlinkActive ?? 0;
  const active = summary.activePayloads;
  const rest = active - starlink;
  const pct = (starlink / active) * 100;
  const restPct = 100 - pct;
  const fmt = (n: number) => n.toLocaleString();

  return (
    <figure className="space-y-2" data-testid="exhibit-majority">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[10px] uppercase tracking-wider">
        <span className="text-cyan-300/90 font-bold">
          Exhibit A — Census of operational payloads, live from the catalog
        </span>
        <span className="text-muted-foreground">
          n = {fmt(active)} active satellites
        </span>
      </div>

      <div
        className="relative h-10 w-full border border-cyan-400/30 bg-background/60 overflow-hidden"
        role="img"
        aria-label={`Starlink ${pct.toFixed(1)} percent of active satellites, all other operators ${restPct.toFixed(1)} percent`}
      >
        <div
          className="absolute inset-y-0 left-0 bg-cyan-500/70"
          style={{ width: `${pct}%`, boxShadow: "0 0 18px rgba(34,211,238,0.45)" }}
        />
        <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/50" />
        <div
          className="absolute -top-0.5 text-[9px] text-foreground/70 uppercase tracking-wider"
          style={{ left: "calc(50% + 4px)" }}
        >
          50% line
        </div>
        <div className="absolute inset-0 flex items-center justify-between px-2 text-[10px] font-bold uppercase tracking-wider">
          <span className="text-background/90 mix-blend-normal drop-shadow-[0_0_4px_rgba(0,0,0,0.7)] text-cyan-50">
            Starlink · {fmt(starlink)} · {pct.toFixed(1)}%
          </span>
          <span className="text-muted-foreground">
            Everyone else · {fmt(rest)} · {restPct.toFixed(1)}%
          </span>
        </div>
      </div>

      <figcaption className="flex flex-wrap justify-between gap-2 text-[9px] uppercase tracking-wider text-muted-foreground/70">
        <span>
          "Everyone else" comprises every other government, military, corporation,
          university, and hobbyist on Earth. Combined.
        </span>
        <span>Source: GCAT · operational payloads · name match "STARLINK"</span>
      </figcaption>
    </figure>
  );
}
