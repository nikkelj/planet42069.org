import React, { useState, useEffect, Suspense, lazy } from "react";
import {
  useGetRpodEvents, getGetRpodEventsQueryKey,
  useGetRpodEvent, getGetRpodEventQueryKey,
  useGetRpodStatus, getGetRpodStatusQueryKey,
} from "@workspace/api-client-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Crosshair, Loader2, ChevronDown, ChevronRight, Radio, Search } from "lucide-react";

const RpodViewer3D = lazy(() => import("@/components/RpodViewer3D"));

/**
 * RPOD WATCH — rendezvous & proximity-operations surveillance desk.
 * Events come from the hourly screen of the TLE history archive:
 * coplanar/converging pairs SGP4-differenced down to predicted close
 * approaches at docking-grade relative velocity.
 */

const fmtUtc = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "Z").replace(/Z$/, " Z");

function fmtRange(km: number): string {
  return km >= 100 ? `${km.toFixed(0)} km` : km >= 1 ? `${km.toFixed(1)} km` : `${(km * 1000).toFixed(0)} m`;
}

function EventDetail({ eventId }: { eventId: number }) {
  const { data, isLoading } = useGetRpodEvent(eventId, {
    query: { queryKey: getGetRpodEventQueryKey(eventId), staleTime: 5 * 60_000 },
  });
  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center p-8 text-primary font-mono text-xs uppercase tracking-widest">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Pulling case file…
      </div>
    );
  }
  const sats = data.members.map((m) => ({ norad: m.norad, name: m.name ?? null, tle: m.tle ?? null }));
  return (
    <div className="border-l-4 border-primary ml-2 my-2 bg-background/60 divide-y divide-border/40">
      <div className="w-full h-[300px] sm:h-[420px]">
        <Suspense fallback={
          <div className="w-full h-full flex items-center justify-center bg-black/70 font-mono text-[10px] uppercase tracking-widest text-primary/70">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Initializing proximity tracking display…
          </div>
        }>
          <RpodViewer3D sats={sats} tcaMs={Date.parse(data.tca)} />
        </Suspense>
      </div>
      <div className="overflow-x-auto">
        <Table className="font-mono text-xs whitespace-nowrap">
          <TableHeader className="bg-muted/40">
            <TableRow className="border-b-border hover:bg-transparent">
              <TableHead className="uppercase text-[10px] tracking-wider">NORAD</TableHead>
              <TableHead className="uppercase text-[10px] tracking-wider">Name</TableHead>
              <TableHead className="uppercase text-[10px] tracking-wider">Owner</TableHead>
              <TableHead className="uppercase text-[10px] tracking-wider">Class</TableHead>
              <TableHead className="uppercase text-[10px] tracking-wider">Orbit</TableHead>
              <TableHead className="uppercase text-[10px] tracking-wider">Launched</TableHead>
              <TableHead className="uppercase text-[10px] tracking-wider">Min Range</TableHead>
              <TableHead className="uppercase text-[10px] tracking-wider">Rel Vel</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.members.map((m) => (
              <TableRow key={m.norad} className="border-b-border/40 hover:bg-primary/5">
                <TableCell className="text-primary font-bold">#{m.norad}</TableCell>
                <TableCell>{m.name ?? "—"}</TableCell>
                <TableCell>{m.owner ?? "—"}</TableCell>
                <TableCell>{m.objectClass ?? "—"}</TableCell>
                <TableCell>{m.opOrbit ?? "—"}</TableCell>
                <TableCell>{m.ldate ?? "—"}</TableCell>
                <TableCell className="text-accent">{m.minRangeKm != null ? fmtRange(m.minRangeKm) : "—"}</TableCell>
                <TableCell className="text-secondary">{m.relVelKmS != null ? `${m.relVelKmS.toFixed(3)} km/s` : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {data.widenedScan && (
        <div className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-accent">
          ⚠ Cluster hit the participant cap — a widened neighborhood sweep was executed. Somebody is having a party up there.
        </div>
      )}
    </div>
  );
}

export default function Rpod() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
      setExpanded(null);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const queryParams = {
    page,
    limit: 50,
    status: statusFilter !== "all" ? (statusFilter as "active" | "stale" | "ended") : undefined,
    kind: kindFilter !== "all" ? (kindFilter as "conjunction" | "coplanar") : undefined,
    q: debouncedSearch || undefined,
  };
  const { data, isLoading, isError } = useGetRpodEvents(queryParams, {
    query: { queryKey: getGetRpodEventsQueryKey(queryParams), refetchInterval: 5 * 60_000 },
  });
  const { data: status } = useGetRpodStatus({ query: { queryKey: getGetRpodStatusQueryKey(), refetchInterval: 5 * 60_000 } });

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      <div className="flex items-center gap-3 border-b-2 border-border pb-4 mb-4">
        <Crosshair className="w-8 h-8 text-primary animate-pulse" />
        <div>
          <h1 className="text-2xl font-display font-bold text-primary uppercase text-glow">RPOD Watch</h1>
          <p className="text-muted-foreground text-sm uppercase">Rendezvous & Proximity Operations Surveillance Desk</p>
        </div>
      </div>

      {/* status strip */}
      <div className="bg-card border-2 border-border p-4 box-glow grid grid-cols-2 md:grid-cols-5 gap-4 font-mono text-xs relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-20" />
        <div>
          <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Active cases</span>
          <span className="text-primary font-bold text-lg">{status?.activeEvents ?? "—"}</span>
        </div>
        <div>
          <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Elsets archived</span>
          <span className="text-accent font-bold text-lg">{status?.archive.totalRows?.toLocaleString() ?? "—"}</span>
        </div>
        <div>
          <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Objects tracked</span>
          <span className="text-secondary font-bold text-lg">{status?.archive.objects?.toLocaleString() ?? "—"}</span>
        </div>
        <div>
          <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Archive reaches back to</span>
          <span className="text-foreground">{status?.archive.backfillCursor ? fmtUtc(status.archive.backfillCursor) : "—"}</span>
        </div>
        <div>
          <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Last sweep</span>
          <span className="text-foreground">{status?.lastScanAt ? fmtUtc(status.lastScanAt) : "pending"}</span>
          {status?.archive.backoffUntil && (
            <span className="block text-destructive text-[10px] uppercase mt-1" title="space-track asked us to slow down; the Bureau complies with all lawful orbital paperwork requests">
              standing down until {fmtUtc(status.archive.backoffUntil)}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-widest max-w-3xl leading-relaxed normal-case">
          Two kinds of cases: CONJUNCTIONS — discrete predicted approaches within 30 km at under
          1.5 km/s — and SHADOWING — payload pairs from different launches co-aligned in plane
          (ΔRAAN &amp; inclination ≤ 0.15°), radial shell, and along-track phase, trailing each other
          for weeks or months. Formation flying, inspections, dockings — all of it unlicensed,
          none of it with a permit on file.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="NAME OR NORAD #"
              className="w-[200px] pl-7 rounded-none border-border bg-background uppercase text-xs font-mono h-9"
            />
          </div>
          <Select value={kindFilter} onValueChange={(v) => { setKindFilter(v); setPage(1); setExpanded(null); }}>
            <SelectTrigger className="w-[160px] rounded-none border-border bg-background uppercase text-xs">
              <SelectValue placeholder="KIND" />
            </SelectTrigger>
            <SelectContent className="rounded-none">
              <SelectItem value="all">ALL KINDS</SelectItem>
              <SelectItem value="conjunction">CONJUNCTION</SelectItem>
              <SelectItem value="coplanar">SHADOWING</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); setExpanded(null); }}>
            <SelectTrigger className="w-[150px] rounded-none border-border bg-background uppercase text-xs">
              <SelectValue placeholder="STATUS" />
            </SelectTrigger>
            <SelectContent className="rounded-none">
              <SelectItem value="all">ALL CASES</SelectItem>
              <SelectItem value="active">ACTIVE</SelectItem>
              <SelectItem value="stale">ARCHIVED</SelectItem>
              <SelectItem value="ended">ENDED</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border-2 border-border bg-card overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-10" />
        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-12 space-y-4">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-primary font-bold tracking-widest uppercase animate-pulse">SCANNING PROXIMITY CASE FILES…</p>
          </div>
        ) : isError ? (
          <div className="p-12 text-center text-destructive uppercase font-bold">Error loading RPOD events</div>
        ) : (data?.data.length ?? 0) === 0 ? (
          <div className="p-12 text-center font-mono text-sm text-muted-foreground uppercase tracking-widest space-y-2">
            <Radio className="w-8 h-8 mx-auto text-primary/50" />
            <p className="text-primary font-bold">No proximity operations currently on file</p>
            <p className="normal-case text-xs max-w-xl mx-auto leading-relaxed">
              Either orbit is briefly law-abiding, or the element-set archive is still filling
              ({status?.archive.totalRows?.toLocaleString() ?? 0} elsets so far). The sweep runs hourly.
              The Space Police remain vigilant.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto relative z-10">
            <Table className="font-mono text-sm whitespace-nowrap">
              <TableHeader className="bg-muted/50 border-b-2 border-border">
                <TableRow className="border-b-border hover:bg-transparent">
                  <TableHead />
                  <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Case</TableHead>
                  <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Status</TableHead>
                  <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Kind</TableHead>
                  <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">TCA (UTC)</TableHead>
                  <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Min Range</TableHead>
                  <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Rel Vel</TableHead>
                  <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Craft</TableHead>
                  <TableHead className="text-muted-foreground uppercase text-xs tracking-wider">Participants</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.data.map((ev) => (
                  <React.Fragment key={ev.id}>
                    <TableRow
                      className={`border-b-border/50 hover:bg-primary/5 transition-colors cursor-pointer ${expanded === ev.id ? "bg-primary/5" : ""}`}
                      onClick={() => setExpanded(expanded === ev.id ? null : ev.id)}
                    >
                      <TableCell className="py-3 w-8">
                        {expanded === ev.id ? <ChevronDown className="w-4 h-4 text-primary" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                      </TableCell>
                      <TableCell className="text-primary font-bold">RPOD-{String(ev.id).padStart(4, "0")}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`font-mono text-[10px] uppercase rounded-none ${
                            ev.status === "active"
                              ? "bg-primary text-primary-foreground border-primary"
                              : ev.status === "ended"
                                ? "bg-destructive/10 text-destructive border-destructive/60"
                                : "bg-muted text-muted-foreground border-muted-foreground"
                          }`}
                          title={ev.status === "ended" ? `Pair drifted apart — last seen together ${fmtUtc(ev.lastSeenAt)}` : undefined}
                        >
                          {ev.status === "active" ? "ACTIVE" : ev.status === "ended" ? "ENDED" : "ARCHIVED"}
                        </Badge>
                        {ev.status === "ended" && (
                          <span className="block mt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                            last seen {fmtUtc(ev.lastSeenAt)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`font-mono text-[10px] uppercase rounded-none ${ev.kind === "coplanar" ? "border-secondary text-secondary" : "border-accent/70 text-accent"}`}
                          title={ev.kind === "coplanar"
                            ? "Long-duration co-aligned shadowing: same plane, same shell, slow phase drift — these encounters last weeks or months"
                            : "Discrete predicted close approach"}
                        >
                          {ev.kind === "coplanar" ? "SHADOWING" : "CONJUNCTION"}
                        </Badge>
                      </TableCell>
                      <TableCell>{fmtUtc(ev.tca)}</TableCell>
                      <TableCell className="text-accent font-bold">{fmtRange(ev.minRangeKm)}</TableCell>
                      <TableCell className="text-secondary">{ev.relVelKmS.toFixed(3)} km/s</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5">
                          {ev.memberCount}
                          {ev.widenedScan && (
                            <span className="text-[9px] font-mono uppercase border border-accent/60 text-accent px-1 leading-4 cursor-help" title="Cluster hit the participant cap — widened neighborhood sweep executed">
                              4v1?
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[360px] truncate text-muted-foreground">
                        {ev.members.map((m) => m.name ?? `#${m.norad}`).join(" · ")}
                      </TableCell>
                    </TableRow>
                    {expanded === ev.id && (
                      <TableRow className="bg-muted/20 border-b-border/50 hover:bg-muted/20">
                        <TableCell colSpan={9} className="p-0">
                          <EventDetail eventId={ev.id} />
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {(data?.pages ?? 1) > 1 && (
        <div className="flex items-center justify-end gap-2 font-mono text-xs uppercase">
          <Button variant="outline" size="sm" className="rounded-none" disabled={page <= 1}
            onClick={() => { setPage((p) => p - 1); setExpanded(null); }}>Prev</Button>
          <span className="text-muted-foreground">Page {page} / {data?.pages}</span>
          <Button variant="outline" size="sm" className="rounded-none" disabled={page >= (data?.pages ?? 1)}
            onClick={() => { setPage((p) => p + 1); setExpanded(null); }}>Next</Button>
        </div>
      )}
    </div>
  );
}
