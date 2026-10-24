import { useEffect, useState } from "react";
import { Download, Loader2, Rocket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  formatUtc,
  loadLaunchIndex,
  partitionLaunches,
  publicAssetHref,
  type LaunchEntry,
  type LaunchIndexResult,
} from "@/lib/launches";

type BoardState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; launches: LaunchEntry[] };

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "success" || s === "successful") {
    return "bg-primary text-primary-foreground border-primary";
  }
  if (s === "go" || s === "hold" || s === "scheduled" || s === "tbd") {
    return "bg-secondary/15 text-secondary border-secondary";
  }
  if (s === "failure" || s === "failed" || s === "scrub" || s === "scrubbed" || s === "abort" || s === "aborted") {
    return "bg-destructive/15 text-destructive border-destructive/70";
  }
  return "bg-muted text-muted-foreground border-muted-foreground/40";
}

function FileLink({ path, filename }: { path: string | null; filename: string }) {
  const href = publicAssetHref(path);
  if (!href) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  return (
    <a
      href={href}
      download={filename}
      className="inline-flex items-center gap-1 text-accent underline underline-offset-2 hover:text-primary transition-colors"
    >
      <Download className="w-3 h-3" aria-hidden="true" />
      {filename}
    </a>
  );
}

function LaunchTable({
  launches,
  timeHeader,
}: {
  launches: LaunchEntry[];
  timeHeader: string;
}) {
  return (
    <div className="overflow-x-auto relative z-10">
      <Table className="font-mono text-sm whitespace-nowrap">
        <TableHeader className="bg-muted/50 border-b-2 border-border">
          <TableRow className="border-b-border hover:bg-transparent">
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Name</TableHead>
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Vehicle</TableHead>
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">{timeHeader}</TableHead>
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Status</TableHead>
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Trajectory</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {launches.map((launch) => (
            <TableRow
              key={launch.slug}
              data-testid="launch-row"
              data-slug={launch.slug}
              className="border-b-border/50 hover:bg-primary/5"
            >
              <TableCell className="py-3">
                <div className="flex items-center gap-2">
                  <span className="text-foreground font-bold">{launch.name}</span>
                  {launch.illustrative && (
                    <Badge
                      data-testid="illustrative-badge"
                      variant="outline"
                      className="rounded-none border-2 border-secondary bg-secondary text-secondary-foreground font-mono text-[10px] font-bold tracking-widest"
                    >
                      ILLUSTRATIVE
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-accent">{launch.vehicle}</TableCell>
              <TableCell className="text-foreground">{formatUtc(launch.t0Utc)}</TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={`rounded-none font-mono text-[10px] uppercase tracking-wider ${statusClass(launch.status)}`}
                >
                  {launch.status}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-3">
                  <FileLink path={launch.files.csv} filename="trajectory.csv" />
                  <FileLink path={launch.files.kml} filename="trajectory.kml" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LaunchSection({
  id,
  title,
  timeHeader,
  launches,
  empty,
}: {
  id: "upcoming" | "recent";
  title: string;
  timeHeader: string;
  launches: LaunchEntry[];
  empty: string;
}) {
  return (
    <section data-testid={`launch-section-${id}`} className="border-2 border-border bg-card relative overflow-hidden" aria-labelledby={`launch-heading-${id}`}>
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-10" />
      <div className="bg-muted/30 border-b border-border px-4 py-3 flex items-center justify-between gap-3 relative z-10">
        <h2 id={`launch-heading-${id}`} className="text-sm font-display font-bold text-primary uppercase tracking-widest">
          {title}
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {launches.length} {launches.length === 1 ? "launch" : "launches"}
        </span>
      </div>
      {launches.length === 0 ? (
        <p className="relative z-10 p-8 text-center font-mono text-sm text-muted-foreground uppercase tracking-widest">
          {empty}
        </p>
      ) : (
        <LaunchTable launches={launches} timeHeader={timeHeader} />
      )}
    </section>
  );
}

export function LaunchesBoard({ state }: { state: BoardState }) {
  const sections = state.kind === "ready" ? partitionLaunches(state.launches) : null;
  const emptyManifest = state.kind === "ready" && state.launches.length === 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      <div className="flex items-center gap-3 border-b-2 border-border pb-4 mb-4">
        <Rocket className="w-8 h-8 text-primary animate-pulse" />
        <div>
          <h1 className="text-2xl font-display font-bold text-primary uppercase text-glow">Launches</h1>
          <p className="text-muted-foreground text-sm uppercase">Ascent trajectory desk</p>
        </div>
      </div>

      <p
        data-testid="synthetic-note"
        className="border border-secondary/60 bg-secondary/10 px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-secondary leading-relaxed"
      >
        Trajectories are synthetic.
        <span className="normal-case tracking-normal text-foreground/80">
          {" "}Files marked ILLUSTRATIVE are generated illustrations, not reconstructed flight telemetry.
        </span>
      </p>

      {state.kind === "loading" && (
        <div className="border-2 border-border bg-card flex flex-col items-center justify-center p-12 space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <p className="text-primary font-bold tracking-widest uppercase animate-pulse">Reading launch manifest…</p>
        </div>
      )}

      {state.kind === "unavailable" && (
        <div
          data-testid="launch-manifest-unavailable"
          className="border-2 border-border bg-card p-12 text-center font-mono text-sm uppercase tracking-widest space-y-2"
        >
          <Rocket className="w-8 h-8 mx-auto text-primary/50" />
          <p className="text-primary font-bold">Launch manifest unavailable</p>
          <p className="normal-case text-xs text-muted-foreground max-w-xl mx-auto leading-relaxed">
            This desk reads the static file /launches/index.json. The file is missing or could not be read.
            The board stays up; there is nothing to file until the manifest is published.
          </p>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          {emptyManifest && (
            <p data-testid="launch-manifest-empty" className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              The manifest is on file and lists no launches.
            </p>
          )}
          <LaunchSection
            id="upcoming"
            title="Upcoming"
            timeHeader="NET (UTC)"
            launches={sections!.upcoming}
            empty="No upcoming launches on the board."
          />
          <LaunchSection
            id="recent"
            title="Recent"
            timeHeader="T-0 (UTC)"
            launches={sections!.recent}
            empty="No recent launches on the board."
          />
        </>
      )}
    </div>
  );
}

function resultToState(result: LaunchIndexResult): BoardState {
  if (!result.ok) return { kind: "unavailable" };
  return { kind: "ready", launches: result.launches };
}

export default function Launches() {
  const [state, setState] = useState<BoardState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadLaunchIndex().then((result) => {
      if (!cancelled) setState(resultToState(result));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <LaunchesBoard state={state} />;
}
