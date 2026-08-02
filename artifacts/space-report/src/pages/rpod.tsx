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
import { Crosshair, Loader2, ChevronDown, ChevronRight, Radio, Search, ArrowUp, ArrowDown } from "lucide-react";

type SortField = "id" | "status" | "kind" | "tca" | "duration" | "minRangeKm" | "relVelKmS" | "memberCount";
interface SortSpec { field: SortField; order: "asc" | "desc" }

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

function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const days = ms / 86_400_000;
  if (days >= 1) {
    const d = Math.floor(days);
    const h = Math.floor((days - d) * 24);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  const hours = ms / 3_600_000;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

interface SpellInterval { start: string; lastSeenAt: string | null; endedAt: string | null }

export function CaseTimeline({
  firstDetectedAt, lastSeenAt, endedAt, status, spells,
}: { firstDetectedAt: string; lastSeenAt: string; endedAt: string | null; status: string; spells?: SpellInterval[] }) {
  // Fall back to a single spell when the API doesn't provide the list.
  const spellList: SpellInterval[] = spells && spells.length > 0
    ? spells
    : [{ start: firstDetectedAt, lastSeenAt, endedAt }];

  const last = spellList[spellList.length - 1];
  const ended = last.endedAt != null;
  const multi = spellList.length > 1;

  // Build alternating observation/gap segments across the full case span.
  const segs: { kind: "obs" | "gap"; ms: number; live?: boolean }[] = [];
  let totalObsMs = 0;
  for (let i = 0; i < spellList.length; i++) {
    const sp = spellList[i];
    const s = Date.parse(sp.start);
    const obsEnd = Date.parse(sp.lastSeenAt ?? sp.endedAt ?? sp.start);
    const obsMs = Math.max(0, obsEnd - s);
    totalObsMs += obsMs;
    segs.push({ kind: "obs", ms: obsMs, live: i === spellList.length - 1 && !ended });
    // gap: from last contact of this spell to the start of the next (or to endedAt for the final ended spell)
    const gapEnd = i < spellList.length - 1
      ? Date.parse(spellList[i + 1].start)
      : sp.endedAt != null ? Date.parse(sp.endedAt) : null;
    if (gapEnd != null && gapEnd > obsEnd) segs.push({ kind: "gap", ms: gapEnd - obsEnd });
  }
  // Convert durations to widths with a minimum so short segments stay visible.
  const totalMs = segs.reduce((a, s) => a + s.ms, 0);
  const minFrac = segs.length > 1 ? 0.06 : 1;
  const rawFracs = segs.map((s) => Math.max(minFrac, totalMs > 0 ? s.ms / totalMs : 1));
  const fracSum = rawFracs.reduce((a, f) => a + f, 0);
  const fracs = rawFracs.map((f) => f / fracSum);

  const finalGapMs = ended && last.lastSeenAt != null ? Date.parse(last.endedAt!) - Date.parse(last.lastSeenAt) : 0;

  return (
    <div className="px-4 py-3 font-mono text-[10px] uppercase tracking-widest space-y-2">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <span className="text-muted-foreground">
          Case timeline
          {multi && <span className="text-accent"> · {spellList.length} separate shadowing spells</span>}
        </span>
        <span className="text-primary">
          shadowed for <span className="font-bold">{fmtDuration(totalObsMs)}</span>
          {multi && <span className="text-muted-foreground normal-case tracking-normal"> across {spellList.length} spells</span>}
          {ended && finalGapMs > 0 && (
            <span className="text-muted-foreground normal-case tracking-normal"> · closed {fmtDuration(finalGapMs)} after last contact</span>
          )}
        </span>
      </div>
      <div className="flex items-center w-full">
        {segs.map((seg, i) => {
          const width = `${fracs[i] * 100}%`;
          const isFinalGap = seg.kind === "gap" && i === segs.length - 1 && ended;
          if (seg.kind === "obs") {
            return (
              <div key={i} data-testid="timeline-spell" className="relative h-1.5 bg-primary/70" style={{ width }} title={`Shadowing spell — ${fmtDuration(seg.ms)}`}>
                <span className="absolute -left-0.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-primary" />
                <span className={`absolute -right-0.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ${seg.live ? "bg-primary animate-pulse" : "bg-primary/70"}`} />
              </div>
            );
          }
          return (
            <div
              key={i}
              data-testid={isFinalGap ? "timeline-final-gap" : "timeline-gap"}
              className={`relative h-0 border-t-2 border-dashed ${isFinalGap ? "border-destructive/50" : "border-accent/50"}`}
              style={{ width }}
              title={isFinalGap ? `Case closed ${fmtDuration(seg.ms)} after last contact` : `Pair drifted apart for ${fmtDuration(seg.ms)} before closing ranks again`}
            >
              {isFinalGap && <span className="absolute -right-0.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-destructive" />}
            </div>
          );
        })}
      </div>
      <div className="flex items-start justify-between gap-2 text-[9px]">
        <div>
          <span className="block text-muted-foreground">First detected</span>
          <span className="text-foreground">{fmtUtc(firstDetectedAt)}</span>
        </div>
        <div className="text-right sm:text-center">
          <span className="block text-muted-foreground">{ended ? "Last observed" : status === "active" ? "Last observed (still on file)" : "Last observed"}</span>
          <span className="text-foreground">{fmtUtc(lastSeenAt)}</span>
        </div>
        {ended ? (
          <div className="text-right">
            <span className="block text-destructive">Case closed</span>
            <span className="text-foreground">{fmtUtc(endedAt!)}</span>
          </div>
        ) : (
          <div className="text-right">
            <span className="block text-muted-foreground">Ended</span>
            <span className="text-foreground">—</span>
          </div>
        )}
      </div>
    </div>
  );
}

function EventDetail({ eventId }: { eventId: number }) {
  const { data, isLoading, isError } = useGetRpodEvent(eventId, {
    query: { queryKey: getGetRpodEventQueryKey(eventId), staleTime: 5 * 60_000 },
  });
  if (isError) {
    return (
      <div className="p-8 text-center font-mono text-xs uppercase tracking-widest text-destructive">
        No case file found under RPOD-{String(eventId).padStart(4, "0")} — the link may be stale.
      </div>
    );
  }
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
      <CaseTimeline
        firstDetectedAt={data.firstDetectedAt}
        lastSeenAt={data.lastSeenAt}
        endedAt={data.endedAt}
        status={data.status}
        spells={data.spells}
      />
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

/** Read initial view state from the URL so shared/bookmarked links restore the same view. */
function readUrlState() {
  const sp = new URLSearchParams(window.location.search);
  const kind = sp.get("kind");
  const status = sp.get("status");
  const pageRaw = parseInt(sp.get("page") ?? "", 10);
  const caseRaw = parseInt(sp.get("case") ?? "", 10);
  return {
    q: sp.get("q") ?? "",
    kind: kind === "conjunction" || kind === "coplanar" || kind === "docked" ? kind : "all",
    status: status === "active" || status === "stale" || status === "ended" ? status : "all",
    reopened: sp.get("reopened") === "true",
    page: Number.isFinite(pageRaw) && pageRaw > 1 ? pageRaw : 1,
    case: Number.isFinite(caseRaw) && caseRaw > 0 ? caseRaw : null,
  };
}
export default function Rpod() {
  const initial = React.useMemo(readUrlState, []);
  const [page, setPage] = useState(initial.page);
  const [statusFilter, setStatusFilter] = useState(initial.status);
  const [kindFilter, setKindFilter] = useState(initial.kind);
  const [reopenedOnly, setReopenedOnly] = useState(initial.reopened);
  const [expanded, setExpanded] = useState<number | null>(initial.case);
  const [search, setSearch] = useState(initial.q);
  const [debouncedSearch, setDebouncedSearch] = useState(initial.q.trim());
  // sorts[0] = primary (click), sorts[1] = secondary (shift-click)
  const [sorts, setSorts] = useState<SortSpec[]>([{ field: "tca", order: "desc" }]);

  const handleSort = (field: SortField, additive: boolean) => {
    setSorts((prev) => {
      if (!additive) {
        // plain click: make this the only sort; toggle direction if already primary
        if (prev[0]?.field === field) return [{ field, order: prev[0].order === "desc" ? "asc" : "desc" }];
        return [{ field, order: "desc" }];
      }
      // shift-click: set/toggle the secondary sort (keep primary)
      const primary = prev[0] ?? { field: "tca" as SortField, order: "desc" as const };
      if (primary.field === field) {
        // shift-click on the primary column just toggles it
        return [{ field, order: primary.order === "desc" ? "asc" : "desc" }, ...prev.slice(1)];
      }
      const existing = prev[1];
      if (existing?.field === field) return [primary, { field, order: existing.order === "desc" ? "asc" : "desc" }];
      return [primary, { field, order: "desc" }];
    });
    setPage(1);
    setExpanded(null);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch((prev) => {
        const next = search.trim();
        if (next !== prev) {
          setPage(1);
          setExpanded(null);
        }
        return next;
      });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Keep q/kind/status/page mirrored into the URL query string so the view is shareable.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const setOrDelete = (key: string, value: string | null) =>
      value != null && value !== "" ? sp.set(key, value) : sp.delete(key);
    setOrDelete("q", debouncedSearch || null);
    setOrDelete("kind", kindFilter !== "all" ? kindFilter : null);
    setOrDelete("status", statusFilter !== "all" ? statusFilter : null);
    setOrDelete("reopened", reopenedOnly ? "true" : null);
    setOrDelete("page", page > 1 ? String(page) : null);
    setOrDelete("case", expanded != null ? String(expanded) : null);
    const qs = sp.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [debouncedSearch, kindFilter, statusFilter, reopenedOnly, page, expanded]);

  const queryParams = {
    page,
    limit: 50,
    status: statusFilter !== "all" ? (statusFilter as "active" | "stale" | "ended") : undefined,
    kind: kindFilter !== "all" ? (kindFilter as "conjunction" | "coplanar" | "docked") : undefined,
    reopened: reopenedOnly ? true : undefined,
    q: debouncedSearch || undefined,
    sort: sorts[0]?.field,
    order: sorts[0]?.order,
    sort2: sorts[1]?.field,
    order2: sorts[1]?.order,
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
          for weeks or months. Pairs sitting at effectively zero range and zero relative velocity
          are labeled DOCKED — physically joined stacks (station modules, visiting vehicles), not
          operations in progress. Formation flying, inspections, dockings — all of it unlicensed,
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
              <SelectItem value="docked">DOCKED</SelectItem>
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setReopenedOnly((v) => !v); setPage(1); setExpanded(null); }}
            title="Repeat offenders: cases that ended, then the same pair closed ranks again"
            className={`rounded-none h-9 uppercase text-xs font-mono tracking-wider ${
              reopenedOnly
                ? "border-accent text-accent bg-accent/10 hover:bg-accent/20 hover:text-accent"
                : "border-border text-muted-foreground"
            }`}
          >
            Reopened only
          </Button>
        </div>
      </div>

      {/* A shared ?case= link may point at a case that isn't on the current page of
          results — pin its full case file above the table by fetching it directly. */}
      {expanded != null && !isLoading && !isError && !data?.data.some((ev) => ev.id === expanded) && (
        <div className="border-2 border-primary/60 bg-card overflow-hidden relative">
          <div className="flex items-center justify-between gap-2 px-4 py-2 bg-primary/10 border-b border-border font-mono text-xs uppercase tracking-widest">
            <span className="text-primary font-bold">Case file RPOD-{String(expanded).padStart(4, "0")}</span>
            <span className="flex items-center gap-3">
              <span className="text-muted-foreground normal-case tracking-normal">Not on this page of results — pulled directly</span>
              <Button variant="outline" size="sm" className="rounded-none h-7 uppercase text-[10px] font-mono" onClick={() => setExpanded(null)}>
                Close
              </Button>
            </span>
          </div>
          <EventDetail eventId={expanded} />
        </div>
      )}

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
                  {([
                    ["id", "Case"],
                    ["status", "Status"],
                    ["kind", "Kind"],
                    ["tca", "TCA (UTC)"],
                    ["duration", "Duration"],
                    ["minRangeKm", "Min Range"],
                    ["relVelKmS", "Rel Vel"],
                    ["memberCount", "Craft"],
                  ] as [SortField, string][]).map(([field, label]) => {
                    const rank = sorts.findIndex((s) => s.field === field);
                    const spec = rank >= 0 ? sorts[rank] : null;
                    return (
                      <TableHead
                        key={field}
                        onClick={(e) => handleSort(field, e.shiftKey)}
                        title="Click to sort · Shift+click to add a secondary sort"
                        className={`uppercase text-xs tracking-wider cursor-pointer select-none hover:text-primary transition-colors ${spec ? "text-primary" : "text-muted-foreground"}`}
                      >
                        <span className="inline-flex items-center gap-1">
                          {label}
                          {spec && (spec.order === "desc" ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)}
                          {spec && sorts.length > 1 && (
                            <span className="text-[9px] border border-primary/50 px-0.5 leading-3">{rank + 1}</span>
                          )}
                        </span>
                      </TableHead>
                    );
                  })}
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
                        {ev.reopenCount > 0 && (
                          <Badge
                            variant="outline"
                            className="ml-1 font-mono text-[10px] uppercase rounded-none border-accent text-accent"
                            title={`Case previously ended, then the same pair closed ranks again — reopened ${ev.reopenCount}×${ev.lastReopenedAt ? `, most recently ${fmtUtc(ev.lastReopenedAt)}` : ""}. Repeat offenders keep one file.`}
                          >
                            REOPENED{ev.reopenCount > 1 ? ` ×${ev.reopenCount}` : ""}
                          </Badge>
                        )}
                        {ev.status === "ended" && (
                          <span className="block mt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                            last seen {fmtUtc(ev.lastSeenAt)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`font-mono text-[10px] uppercase rounded-none ${
                            ev.kind === "coplanar" ? "border-secondary text-secondary"
                            : ev.kind === "docked" ? "border-muted-foreground/60 text-muted-foreground"
                            : "border-accent/70 text-accent"}`}
                          title={ev.kind === "coplanar"
                            ? "Long-duration co-aligned shadowing: same plane, same shell, slow phase drift — these encounters last weeks or months"
                            : ev.kind === "docked"
                            ? "Near-zero range at near-zero relative velocity: a physically joined stack (station modules, docked visiting vehicles), not a proximity operation"
                            : "Discrete predicted close approach"}
                        >
                          {ev.kind === "coplanar" ? "SHADOWING" : ev.kind === "docked" ? "DOCKED" : "CONJUNCTION"}
                        </Badge>
                      </TableCell>
                      <TableCell>{fmtUtc(ev.tca)}</TableCell>
                      <TableCell
                        className="text-primary"
                        title={`Observation span: first detected ${fmtUtc(ev.firstDetectedAt)} · last seen ${fmtUtc(ev.lastSeenAt)}`}
                      >
                        {fmtDuration(Date.parse(ev.lastSeenAt) - Date.parse(ev.firstDetectedAt))}
                      </TableCell>
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
                        <TableCell colSpan={10} className="p-0">
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
