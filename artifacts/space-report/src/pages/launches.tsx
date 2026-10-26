import { Fragment, lazy, Suspense, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download, Loader2, Rocket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { MethodsMarkdown } from "@/components/MethodsMarkdown";
import LaunchGlobe from "@/components/launches/LaunchGlobe";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  emptyManifest,
  fileNameFromPath,
  launchDownloadName,
  formatUtc,
  loadLaunchDesk,
  partitionLaunches,
  publicAssetHref,
  type LaunchEntry,
  type LaunchIndexResult,
  type LaunchManifest,
} from "@/lib/launches";

const LaunchTrackPanel = lazy(() => import("@/components/LaunchTrackPanel"));

type BoardState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; manifest: LaunchManifest };

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

function FileLink({ path, launch }: { path: string | null; launch: LaunchEntry }) {
  const href = publicAssetHref(path);
  if (!path || !href) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  const filename = fileNameFromPath(path);
  return (
    <a
      href={href}
      download={launchDownloadName(launch, path)}
      className="inline-flex items-center gap-1 text-accent underline underline-offset-2 hover:text-primary transition-colors"
    >
      <Download className="w-3 h-3" aria-hidden="true" />
      {filename}
    </a>
  );
}

function IllustrativeBadge() {
  return (
    <Badge
      data-testid="illustrative-badge"
      variant="outline"
      className="rounded-none border-2 border-secondary bg-secondary text-secondary-foreground font-mono text-[10px] font-bold tracking-widest"
    >
      ILLUSTRATIVE
    </Badge>
  );
}

function DownloadSet({
  id,
  label,
  csv,
  kml,
  note,
  illustrative,
  launch,
}: {
  launch: LaunchEntry;
  id: "surrogate" | "sim";
  label: string;
  csv: string | null;
  kml: string | null;
  note: string | null;
  illustrative: boolean;
}) {
  if (!csv && !kml) return null;
  return (
    <div data-testid={`download-set-${id}`} className="whitespace-normal border-l-2 border-secondary/70 pl-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="uppercase text-[10px] tracking-widest text-secondary font-bold">{label}</span>
        {illustrative && <IllustrativeBadge />}
      </div>
      <div className="mt-1 flex items-center gap-3 flex-wrap">
        <FileLink path={csv} launch={launch} />
        <FileLink path={kml} launch={launch} />
      </div>
      {note && (
        <p
          data-testid={`method-note-${id}`}
          title={note}
          className="mt-1 max-w-md text-[10px] leading-snug text-muted-foreground normal-case tracking-normal line-clamp-2"
        >
          {note}
        </p>
      )}
    </div>
  );
}

function LaunchTable({
  launches,
  timeHeader,
}: {
  launches: LaunchEntry[];
  timeHeader: string;
}) {
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto relative z-10">
      <Table className="font-mono text-sm">
        <TableHeader className="bg-muted/50 border-b-2 border-border">
          <TableRow className="border-b-border hover:bg-transparent">
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Name</TableHead>
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Vehicle</TableHead>
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider whitespace-nowrap">{timeHeader}</TableHead>
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Status</TableHead>
            <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Trajectories</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {launches.map((launch) => {
            const canView = Boolean(launch.files.csv || launch.files.csvSim);
            const open = openSlug === launch.slug;
            return (
            <Fragment key={launch.slug}>
            <TableRow
              data-testid="launch-row"
              data-slug={launch.slug}
              className="border-b-border/50 hover:bg-primary/5"
            >
              <TableCell className="py-3 align-top whitespace-normal">
                <div className="text-foreground font-bold">{launch.name}</div>
                {launch.referenceIds.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] normal-case tracking-normal text-muted-foreground">
                    {launch.referenceIds.map((id) => (
                      <a key={id} href={`#ref-${id}`} className="underline underline-offset-2 hover:text-primary">
                        {id}
                      </a>
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell className="align-top text-accent whitespace-nowrap">{launch.vehicle}</TableCell>
              <TableCell className="align-top text-foreground whitespace-nowrap">{formatUtc(launch.t0Utc)}</TableCell>
              <TableCell className="align-top">
                <Badge
                  variant="outline"
                  className={`rounded-none font-mono text-[10px] uppercase tracking-wider ${statusClass(launch.status)}`}
                >
                  {launch.status}
                </Badge>
              </TableCell>
              <TableCell className="align-top">
                <div className="flex flex-col gap-3">
                  <DownloadSet
                    id="surrogate"
                    label="Surrogate"
                    csv={launch.files.csv}
                    kml={launch.files.kml}
                    note={launch.method.csv}
                    illustrative={launch.illustrative}
                    launch={launch}
                  />
                  <DownloadSet
                    id="sim"
                    label="3DOF sim"
                    csv={launch.files.csvSim}
                    kml={launch.files.kmlSim}
                    note={launch.method.csvSim}
                    illustrative={launch.illustrative}
                    launch={launch}
                  />
                  {canView && (
                    <button
                      type="button"
                      data-testid={`view-trajectory-${launch.slug}`}
                      aria-expanded={open}
                      onClick={() => setOpenSlug(open ? null : launch.slug)}
                      className="mt-2 inline-flex items-center gap-1 border border-primary/60 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-primary hover:bg-primary hover:text-primary-foreground"
                    >
                      {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {open ? "Hide trajectory" : "View trajectory"}
                    </button>
                  )}
                </div>
              </TableCell>
            </TableRow>
            {open && canView && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="bg-muted/10 p-3">
                  <Suspense
                    fallback={
                      <div className="flex items-center justify-center gap-2 p-8 font-mono text-xs uppercase tracking-widest text-primary">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading trajectory viewer…
                      </div>
                    }
                  >
                    <LaunchTrackPanel
                      name={launch.name}
                      illustrative={launch.illustrative}
                      surrogateUrl={publicAssetHref(launch.files.csv)}
                      simUrl={publicAssetHref(launch.files.csvSim)}
                    />
                  </Suspense>
                </TableCell>
              </TableRow>
            )}
            </Fragment>
            );
          })}
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

function MethodsSection({ manifest }: { manifest: LaunchManifest }) {
  const docHref = publicAssetHref(manifest.methodsDoc) ?? publicAssetHref("/launches/METHODS.md");
  const hasBlurb = manifest.methods.length > 0;
  const hasNote = Boolean(manifest.methodsMarkdown);
  if (!hasBlurb && !hasNote && !manifest.methodsDoc) return null;

  return (
    <section id="methods" data-testid="launch-methods" className="border-2 border-border bg-card relative overflow-hidden" aria-labelledby="launch-heading-methods">
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-10" />
      <div className="relative z-10 bg-muted/30 border-b border-border px-4 py-3 flex items-center justify-between gap-3">
        <h2 id="launch-heading-methods" className="text-sm font-display font-bold text-primary uppercase tracking-widest">
          Methods
        </h2>
        {docHref && (manifest.methodsDoc || hasNote) && (
          <a
            href={docHref}
            className="font-mono text-[10px] uppercase tracking-widest text-accent underline underline-offset-2 hover:text-primary"
          >
            METHODS.md
          </a>
        )}
      </div>
      <div className="relative z-10 p-4 space-y-4">
        {hasBlurb && (
          <div className="grid gap-4 md:grid-cols-2">
            {manifest.methods.map((method) => (
              <article key={method.key} data-testid={`method-${method.key}`} className="border border-border bg-muted/20 p-3 space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-widest text-secondary">{method.title}</h3>
                <p className="font-mono text-xs leading-relaxed normal-case tracking-normal text-foreground/90">
                  {method.summary}
                </p>
              </article>
            ))}
          </div>
        )}
        {hasNote && hasBlurb && (
          <details className="border border-border bg-background/40 px-3 py-2">
            <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-widest text-accent">
              Full write-up
            </summary>
            <div className="pt-3">
              <MethodsMarkdown source={manifest.methodsMarkdown ?? ""} />
            </div>
          </details>
        )}
        {hasNote && !hasBlurb && <MethodsMarkdown source={manifest.methodsMarkdown ?? ""} />}
      </div>
    </section>
  );
}

function ReferencesSection({ manifest }: { manifest: LaunchManifest }) {
  if (manifest.references.length === 0) return null;
  return (
    <section id="references" data-testid="launch-references" className="border-2 border-border bg-card relative overflow-hidden" aria-labelledby="launch-heading-references">
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-10" />
      <div className="relative z-10 bg-muted/30 border-b border-border px-4 py-3">
        <h2 id="launch-heading-references" className="text-sm font-display font-bold text-primary uppercase tracking-widest">
          References
        </h2>
      </div>
      <ol className="relative z-10 p-4 space-y-2 font-mono text-xs normal-case tracking-normal list-decimal pl-8">
        {manifest.references.map((reference) => (
          <li key={reference.id} id={`ref-${reference.id}`} className="scroll-mt-6 leading-relaxed">
            {reference.url ? (
              <a
                href={reference.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline underline-offset-2 hover:text-primary"
              >
                {reference.title}
              </a>
            ) : (
              <span className="text-foreground">{reference.title}</span>
            )}
            <span className="text-muted-foreground"> ({reference.id})</span>
            {!reference.url && (
              <span className="text-muted-foreground"> — notice id only, no public URL</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function LaunchesBoard({ state }: { state: BoardState }) {
  const manifest = state.kind === "ready" ? state.manifest : null;
  const sections = manifest ? partitionLaunches(manifest.launches) : null;
  const emptyManifestBoard = manifest != null && manifest.launches.length === 0;

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
          {" "}Surrogate and 3DOF sim files marked ILLUSTRATIVE are generated illustrations, not reconstructed flight telemetry.
        </span>
      </p>

      <LaunchGlobe />

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

      {manifest && sections && (
        <>
          {emptyManifestBoard && (
            <p data-testid="launch-manifest-empty" className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              The manifest is on file and lists no launches.
            </p>
          )}
          <LaunchSection
            id="upcoming"
            title="Upcoming"
            timeHeader="NET (UTC)"
            launches={sections.upcoming}
            empty="No upcoming launches on the board."
          />
          <LaunchSection
            id="recent"
            title="Recent"
            timeHeader="T-0 (UTC)"
            launches={sections.recent}
            empty="No recent launches on the board."
          />
          <MethodsSection manifest={manifest} />
          <ReferencesSection manifest={manifest} />
        </>
      )}
    </div>
  );
}

function resultToState(result: LaunchIndexResult): BoardState {
  if (!result.ok) return { kind: "unavailable" };
  return { kind: "ready", manifest: result.manifest };
}

export default function Launches() {
  const [state, setState] = useState<BoardState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadLaunchDesk().then((result) => {
      if (!cancelled) setState(resultToState(result));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <LaunchesBoard state={state} />;
}

export { emptyManifest };
