import React, { useState, useEffect, Suspense, lazy } from "react";
import PassFinder, { loadStoredObserver, storeObserver, type ObserverCoords, type PassRow } from "@/components/PassFinder";

const OrbitViewer3D = lazy(() => import("@/components/OrbitViewer3D"));
import { 
  useGetSatcat, 
  useGetSatcatFilters, 
  getGetSatcatQueryKey,
  useGetSatcatTle,
  getGetSatcatTleQueryKey,
} from "@workspace/api-client-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  PaginationState,
  SortingState,
} from "@tanstack/react-table";
import { 
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow 
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Database, Loader2, Search, ChevronDown, ChevronUp, ChevronRight, Link2, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * Orbit viewer wrapper that pulls the live TLE for objects with a NORAD id,
 * so the 3D view can show the REAL RAAN / arg-perigee / current position
 * instead of drawing them at 0°. Falls back to GCAT-only geometry when no
 * element set exists (decayed objects, deep-space probes, fetch failures).
 */
function TrackingPanel({ satno, apogeeKm, perigeeKm, incDeg, name }: {
  satno?: number | null;
  apogeeKm?: number | null;
  perigeeKm?: number | null;
  incDeg?: number | null;
  name?: string;
}) {
  const enabled = satno != null && satno > 0;
  const { data: tle } = useGetSatcatTle(satno ?? 0, {
    query: {
      enabled,
      queryKey: getGetSatcatTleQueryKey(satno ?? 0),
      staleTime: 30 * 60_000,
      retry: false,
    },
  });

  // Observer + prediction inputs, shared between the pass finder and the 3D
  // view (visibility cone / slant vector). Seeded from a share link when its
  // sat matches this row, else from the browser-cached station location.
  const [observer, setObserver] = useState<ObserverCoords | null>(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("sat") === String(satno)) {
      const lat = parseFloat(p.get("lat") ?? "");
      const lon = parseFloat(p.get("lon") ?? "");
      if (Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180) {
        const coords = { lat, lon };
        storeObserver(coords);
        return coords;
      }
    }
    return loadStoredObserver();
  });
  const [days, setDays] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    const d = p.get("sat") === String(satno) ? p.get("days") : null;
    return d && ["1", "2", "3", "5", "7"].includes(d) ? d : "3";
  });
  const [selectedPass, setSelectedPass] = useState<PassRow | null>(null);
  const [copied, setCopied] = useState(false);

  const onObserverChange = (coords: ObserverCoords) => {
    storeObserver(coords);
    setObserver(coords);
    setSelectedPass(null);
  };

  const shareLink = () => {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set("sat", String(satno ?? ""));
    if (observer) {
      url.searchParams.set("lat", String(observer.lat));
      url.searchParams.set("lon", String(observer.lon));
      url.searchParams.set("days", days);
    }
    navigator.clipboard?.writeText(url.toString()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard unavailable — button just won't confirm */ });
  };

  const passWindow = (() => {
    if (!selectedPass) return null;
    const startMs = Date.parse(selectedPass.startTime);
    const endMs = Date.parse(selectedPass.endTime);
    // Guard malformed timestamps — NaN bounds would break the time slider.
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? { startMs, endMs }
      : null;
  })();

  return (
    <>
      <div className="w-full h-[280px] sm:h-[420px]">
        <OrbitViewer3D
          apogeeKm={apogeeKm}
          perigeeKm={perigeeKm}
          incDeg={incDeg}
          name={name}
          tle={tle ?? null}
          observer={selectedPass ? observer : null}
          passWindow={passWindow}
          onExitPassMode={() => setSelectedPass(null)}
        />
      </div>
      {enabled && (
        <div className="flex items-center justify-between gap-2 px-4 py-1.5 border-t border-border/40">
          <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
            Tracking file #{satno}
          </span>
          <Button
            type="button" variant="outline" size="sm" onClick={shareLink}
            className="h-6 rounded-none border-border text-muted-foreground hover:text-primary uppercase text-[10px] font-mono"
            title="Copy a link to this satellite with your station location and prediction window"
          >
            {copied ? <Check className="w-3 h-3 mr-1 text-primary" /> : <Link2 className="w-3 h-3 mr-1" />}
            {copied ? "Link copied" : "Share link"}
          </Button>
        </div>
      )}
      {enabled && (
        <Suspense fallback={null}>
          <PassFinder
            norad={satno!}
            name={name}
            observer={observer}
            onObserverChange={onObserverChange}
            days={days}
            onDaysChange={(d) => { setDays(d); setSelectedPass(null); }}
            selectedPass={selectedPass}
            onSelectPass={setSelectedPass}
          />
        </Suspense>
      )}
    </>
  );
}

export default function Catalog() {
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
  const [sorting, setSorting] = useState<SortingState>([]);
  const [initialSearch] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    // Share links carry ?sat=<norad>; searching by it surfaces the row.
    return p.get("search") ?? p.get("sat") ?? "";
  });
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [classFilter, setObjectClassFilter] = useState<string>("all");
  const [orbitFilter, setOrbitFilter] = useState<string>("all");
  const [stateFilter, setSatStateFilter] = useState<string>("all");
  const [gunterTypeFilter, setGunterTypeFilter] = useState<string>("all");
  const [massMinInput, setMassMinInput] = useState<string>("");
  const [massMaxInput, setMassMaxInput] = useState<string>("");
  const [massMin, setMassMin] = useState<string>("");
  const [massMax, setMassMax] = useState<string>("");

  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const { data: filters } = useGetSatcatFilters();

  const queryParams = {
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
    search: debouncedSearch || undefined,
    owner: ownerFilter !== "all" ? ownerFilter : undefined,
    objectClass: classFilter !== "all" ? classFilter : undefined,
    orbit: orbitFilter !== "all" ? orbitFilter : undefined,
    satState: stateFilter !== "all" ? stateFilter : undefined,
    gunterType: gunterTypeFilter !== "all" ? gunterTypeFilter : undefined,
    massMin: massMin !== "" && !Number.isNaN(Number(massMin)) ? Number(massMin) : undefined,
    massMax: massMax !== "" && !Number.isNaN(Number(massMax)) ? Number(massMax) : undefined,
    sort: sorting.length > 0 ? sorting[0].id : undefined,
    order: sorting.length > 0 ? (sorting[0].desc ? "desc" as const : "asc" as const) : undefined,
  };

  const { data: catData, isLoading, isError } = useGetSatcat(queryParams, {
    query: {
      enabled: true,
      queryKey: getGetSatcatQueryKey(queryParams)
    }
  });

  // Share-link deep link: once results arrive, auto-expand the shared satellite.
  const [pendingShareSat, setPendingShareSat] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("sat"),
  );
  useEffect(() => {
    if (!pendingShareSat || !catData) return;
    const match = catData.data.find((e) => String(e.satno) === pendingShareSat);
    if (match) setExpandedRows({ [match.jcat]: true });
    setPendingShareSat(null);
  }, [pendingShareSat, catData]);

  const toggleRow = (id: string) => {
    // Only one row expanded at a time — each viewer owns a WebGL context,
    // and browsers hard-limit concurrent contexts.
    setExpandedRows(prev => (prev[id] ? {} : { [id]: true }));
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setDebouncedSearch(search);
    setMassMin(massMinInput);
    setMassMax(massMaxInput);
    setPagination(p => ({ ...p, pageIndex: 0 }));
  };

  const applyMassFilter = () => {
    setMassMin(massMinInput);
    setMassMax(massMaxInput);
    setPagination(p => ({ ...p, pageIndex: 0 }));
  };

  const formatTonnes = (kg: number) =>
    kg >= 1_000_000
      ? `${(kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} t`
      : kg >= 10_000
        ? `${(kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} t`
        : `${Math.round(kg).toLocaleString()} kg`;

  const getClassBadgeColor = (cls?: string | null) => {
    switch(cls) {
      case 'P': return 'bg-primary text-primary-foreground border-primary';
      case 'R': return 'bg-secondary text-secondary-foreground border-secondary';
      case 'D': return 'bg-destructive text-destructive-foreground border-destructive';
      case 'U': return 'bg-muted text-muted-foreground border-muted-foreground';
      default: return 'bg-muted text-muted-foreground border-muted-foreground';
    }
  };

  const getClassLabel = (cls?: string | null) => {
    switch(cls) {
      case 'P': return 'PAYLOAD';
      case 'R': return 'ROCKET BODY';
      case 'D': return 'DEBRIS';
      case 'U': return 'UNKNOWN';
      default: return cls || 'N/A';
    }
  };

  const columns = [
    {
      id: "expander",
      header: () => null,
      cell: ({ row }: any) => {
        const isExpanded = expandedRows[row.original.jcat];
        return (
          <button 
            onClick={(e) => { e.stopPropagation(); toggleRow(row.original.jcat); }}
            className="p-1 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-primary"
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        );
      },
    },
    {
      accessorKey: "jcat",
      header: () => (
        <span
          className="cursor-help inline-flex items-center gap-1"
          title="CASE #JCAT-0001: Primary keys begin with 'S' — a mandatory string prefix with zero semantic value. Numeric sorting requires stripping it first. ADDENDUM (case reluctantly reopened): The defendant's alphanumeric-prefix instinct was later VINDICATED. The US Space Force itself adopted 'Alpha-5' — replacing the first digit of the 5-digit NORAD catalog ID with a letter (A=10, B=11... skipping I and O) to cram 240,000 more objects (up to 339,999) into a legacy fixed-width TLE format. The Other Jonathan was, regrettably, prescient. The Space Police hate it when this happens. Case adjourned."
        >
          JCAT <span className="text-destructive text-[10px]">⚠</span>
        </span>
      ),
      cell: ({ row }: any) => {
        const jcat: string = row.original.jcat ?? "";
        const prefix = jcat.charAt(0);
        const numeric = jcat.slice(1);
        return (
          <span className="font-mono text-xs">
            <span
              className="text-destructive/50 line-through cursor-help"
              title="CASE #JCAT-0001: Unnecessary string prefix. Contributes nothing. The catalog is called the Satellite Catalog. We know. ...Although we now concede this exact alphanumeric-prefix instinct foreshadowed the Space Force's own 'Alpha-5' patch on the NORAD catalog ID. Don't let it go to your head."
            >
              {prefix}
            </span>
            <span>{numeric}</span>
          </span>
        );
      },
    },
    { accessorKey: "name", header: "NAME" },
    { accessorKey: "ldate", header: "LAUNCH DATE" },
    { accessorKey: "owner", header: "OWNER" },
    { 
      accessorKey: "objectClass", 
      header: "CLASS",
      cell: ({ row }: any) => {
        const val = row.original.objectClass;
        return (
          <Badge variant="outline" className={`font-mono text-[10px] uppercase rounded-none ${getClassBadgeColor(val)}`}>
            {getClassLabel(val)}
          </Badge>
        );
      }
    },
    { accessorKey: "opOrbit", header: "ORBIT" },
    { 
      accessorKey: "massKg", 
      header: "MASS (KG)",
      cell: ({ row }: any) => {
        const kg = row.original.massKg;
        if (kg == null) return <span className="text-muted-foreground">---</span>;
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className={row.original.massEstimated ? "text-accent/80" : ""}>{kg.toLocaleString()}</span>
            {row.original.massEstimated && (
              <span
                className="text-[9px] font-mono uppercase border border-accent/60 text-accent px-1 leading-4 cursor-help"
                title="Mass not on file with GCAT. Value theorized by the Bureau's Office of Estimated Tonnage (median of comparable objects). Treat with appropriate suspicion."
              >
                EST
              </span>
            )}
          </span>
        );
      }
    },
    { 
      accessorKey: "satState", 
      header: "STATUS",
      cell: ({ row }: any) => {
        const state = row.original.satState;
        if (!state) return '---';
        const isActive = state === 'O' || state === 'OX';
        return (
          <div className="flex items-center gap-2 text-xs uppercase">
            <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-primary shadow-[0_0_5px_hsl(var(--primary))]' : 'bg-muted-foreground'}`} />
            {state}
          </div>
        );
      }
    },
  ];

  const table = useReactTable({
    data: catData?.data || [],
    columns,
    pageCount: catData?.pages ?? -1,
    state: { pagination, sorting },
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      <div className="flex items-center gap-3 border-b-2 border-border pb-4 mb-4">
        <Database className="w-8 h-8 text-primary animate-pulse" />
        <div>
          <h1 className="text-2xl font-display font-bold text-primary uppercase text-glow">Satcat Explorer</h1>
          <p className="text-muted-foreground text-sm uppercase">Global Catalog Query Interface</p>
        </div>
      </div>

      <div className="bg-card border-2 border-border p-4 box-glow flex flex-col md:flex-row gap-4 flex-wrap items-end relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-20" />
        
        <form onSubmit={handleSearch} className="flex-1 min-w-[250px] relative z-10 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="SEARCH NAME, JCAT, OR NORAD ID..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-background/50 border-primary/50 text-primary placeholder:text-primary/30 uppercase font-mono rounded-none focus-visible:ring-primary"
            />
          </div>
          <Button type="submit" variant="outline" className="rounded-none border-primary text-primary hover:bg-primary hover:text-primary-foreground uppercase">
            Execute Query
          </Button>
        </form>

        <div className="flex gap-2 flex-wrap relative z-10 w-full md:w-auto">
          <Select value={classFilter} onValueChange={(v) => {setObjectClassFilter(v); setPagination(p=>({...p, pageIndex: 0}));}}>
            <SelectTrigger className="w-[140px] rounded-none border-border bg-background uppercase text-xs">
              <SelectValue placeholder="CLASS" />
            </SelectTrigger>
            <SelectContent className="rounded-none">
              <SelectItem value="all">ALL CLASSES</SelectItem>
              {filters?.objectClasses.map(c => <SelectItem key={c} value={c}>{getClassLabel(c)}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={orbitFilter} onValueChange={(v) => {setOrbitFilter(v); setPagination(p=>({...p, pageIndex: 0}));}}>
            <SelectTrigger className="w-[140px] rounded-none border-border bg-background uppercase text-xs">
              <SelectValue placeholder="ORBIT" />
            </SelectTrigger>
            <SelectContent className="rounded-none">
              <SelectItem value="all">ALL ORBITS</SelectItem>
              {filters?.orbits.filter(Boolean).map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={ownerFilter} onValueChange={(v) => {setOwnerFilter(v); setPagination(p=>({...p, pageIndex: 0}));}}>
            <SelectTrigger className="w-[140px] rounded-none border-border bg-background uppercase text-xs">
              <SelectValue placeholder="OWNER" />
            </SelectTrigger>
            <SelectContent className="rounded-none">
              <SelectItem value="all">ALL OWNERS</SelectItem>
              {filters?.owners.filter(Boolean).map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={stateFilter} onValueChange={(v) => {setSatStateFilter(v); setPagination(p=>({...p, pageIndex: 0}));}}>
            <SelectTrigger className="w-[140px] rounded-none border-border bg-background uppercase text-xs">
              <SelectValue placeholder="STATUS" />
            </SelectTrigger>
            <SelectContent className="rounded-none">
              <SelectItem value="all">ALL STATUSES</SelectItem>
              {filters?.satStates.filter(Boolean).map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>

          {(filters?.gunterTypes?.length ?? 0) > 0 && (
            <Select value={gunterTypeFilter} onValueChange={(v) => {setGunterTypeFilter(v); setPagination(p=>({...p, pageIndex: 0}));}}>
              <SelectTrigger className="w-[170px] rounded-none border-border bg-background uppercase text-xs" title="Satellite type per Gunter's Space Page (space.skyrocket.de)">
                <SelectValue placeholder="GUNTER TYPE" />
              </SelectTrigger>
              <SelectContent className="rounded-none">
                <SelectItem value="all">ALL GUNTER TYPES</SelectItem>
                {filters?.gunterTypes.filter(Boolean).map(t => <SelectItem key={t} value={t}>{t.toUpperCase()}</SelectItem>)}
              </SelectContent>
            </Select>
          )}

          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={0}
              placeholder="MASS ≥ KG"
              value={massMinInput}
              onChange={(e) => setMassMinInput(e.target.value)}
              onBlur={applyMassFilter}
              onKeyDown={(e) => { if (e.key === "Enter") applyMassFilter(); }}
              className="w-[110px] rounded-none border-border bg-background uppercase text-xs font-mono placeholder:text-muted-foreground/60"
            />
            <span className="text-muted-foreground text-xs font-mono">—</span>
            <Input
              type="number"
              min={0}
              placeholder="MASS ≤ KG"
              value={massMaxInput}
              onChange={(e) => setMassMaxInput(e.target.value)}
              onBlur={applyMassFilter}
              onKeyDown={(e) => { if (e.key === "Enter") applyMassFilter(); }}
              className="w-[110px] rounded-none border-border bg-background uppercase text-xs font-mono placeholder:text-muted-foreground/60"
            />
          </div>
        </div>
      </div>

      <div className="border-2 border-border bg-card overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-10" />
        
        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-12 space-y-4">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-primary font-bold tracking-widest uppercase animate-pulse">GCAT UPLINK IN PROGRESS...</p>
          </div>
        ) : isError ? (
           <div className="p-12 text-center text-destructive uppercase font-bold">Error loading catalog data</div>
        ) : (
          <div className="overflow-x-auto relative z-10">
            <Table className="font-mono text-sm whitespace-nowrap">
              <TableHeader className="bg-muted/50 border-b-2 border-border hover:bg-muted/50">
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} className="border-b-border hover:bg-transparent">
                    {headerGroup.headers.map((header) => {
                      const canSort = header.column.getCanSort() && header.id !== 'expander' && header.id !== 'objectClass';
                      return (
                        <TableHead 
                          key={header.id} 
                          className={`text-muted-foreground uppercase text-xs tracking-wider ${canSort ? 'cursor-pointer hover:text-primary transition-colors select-none' : ''}`}
                          onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                        >
                          <div className="flex items-center gap-1">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {canSort && (
                              <span className="text-[10px]">
                                {{
                                  asc: ' ▲',
                                  desc: ' ▼',
                                }[header.column.getIsSorted() as string] ?? ' ↕'}
                              </span>
                            )}
                          </div>
                        </TableHead>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows?.length ? (
                  table.getRowModel().rows.map((row) => (
                    <React.Fragment key={row.id}>
                      <TableRow 
                        className={`border-b-border/50 hover:bg-primary/5 transition-colors cursor-pointer ${expandedRows[row.original.jcat] ? 'bg-primary/5' : ''}`}
                        onClick={() => toggleRow(row.original.jcat)}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id} className="py-3">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                      {expandedRows[row.original.jcat] && (
                        <TableRow className="bg-muted/20 border-b-border/50 hover:bg-muted/20">
                          <TableCell colSpan={columns.length} className="p-0">
                            <div className="border-l-4 border-primary ml-2 my-2 bg-background/60">
                              <div className="flex flex-col gap-0 divide-y divide-border/40">
                                <Suspense fallback={
                                  <div className="w-full h-[280px] sm:h-[420px] flex items-center justify-center bg-black/70 font-mono text-[10px] uppercase tracking-widest text-primary/70">
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Initializing ECI tracking display…
                                  </div>
                                }>
                                  <TrackingPanel
                                    satno={row.original.satno}
                                    apogeeKm={row.original.apogeeKm}
                                    perigeeKm={row.original.perigeeKm}
                                    incDeg={row.original.incDeg}
                                    name={row.original.plName || row.original.name}
                                  />
                                </Suspense>
                                <div className="flex-1 p-4 grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-4 text-xs font-mono">
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Apogee</span>
                                    <span className="text-accent font-bold">{row.original.apogeeKm != null ? `${row.original.apogeeKm.toLocaleString()} km` : '---'}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Perigee</span>
                                    <span className="text-secondary font-bold">{row.original.perigeeKm != null ? `${row.original.perigeeKm.toLocaleString()} km` : '---'}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Inclination</span>
                                    <span className="text-chart-4 font-bold">{row.original.incDeg != null ? `${row.original.incDeg}°` : '---'}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Mass</span>
                                    <span className={`font-bold ${row.original.massEstimated ? 'text-accent' : 'text-foreground'}`}>
                                      {row.original.massKg != null ? `${row.original.massKg.toLocaleString()} kg` : '---'}
                                      {row.original.massEstimated && <span className="ml-1 text-[9px] uppercase opacity-80">(Bureau estimate)</span>}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Period</span>
                                    <span className="text-primary">{row.original.periodMin != null ? `${row.original.periodMin} min` : '---'}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Owner / State</span>
                                    <span className="text-foreground">{row.original.owner || '---'}{row.original.state && row.original.state !== row.original.owner ? ` · ${row.original.state}` : ''}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Full Status</span>
                                    <span className={`font-bold uppercase ${row.original.satState === 'O' || row.original.satState === 'OX' ? 'text-primary' : row.original.decayDate ? 'text-destructive' : 'text-muted-foreground'}`}>
                                      {row.original.satState === 'O' ? 'Operational' :
                                       row.original.satState === 'OX' ? 'Operational (Extended)' :
                                       row.original.satState === 'D' ? 'Decayed / Re-entered' :
                                       row.original.satState === 'AB' ? 'Aborted' :
                                       row.original.satState === 'NEA' ? 'No Longer Exists' :
                                       row.original.satState === 'R' ? 'Retired' :
                                       row.original.satState || '---'}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Launch Vehicle</span>
                                    <span className="text-foreground">{row.original.lv || '---'}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Launch Site</span>
                                    <span className="text-foreground">{row.original.site || '---'}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground block mb-1 uppercase tracking-widest text-[10px]">Payload Name</span>
                                    <span className="text-foreground">{row.original.plName || row.original.name || '---'}</span>
                                  </div>
                                  {row.original.gunterUrl && (
                                    <div className="col-span-2 md:col-span-3 border-t border-border/40 pt-3 mt-1 space-y-1">
                                      <span className="text-muted-foreground block uppercase tracking-widest text-[10px]">
                                        Gunter Dossier — Type / Application
                                      </span>
                                      {(row.original.gunterNation || row.original.gunterOperator || row.original.gunterContractors) && (
                                        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 pb-1">
                                          {row.original.gunterNation && (
                                            <div>
                                              <span className="text-muted-foreground block mb-0.5 uppercase tracking-widest text-[10px]">Nation</span>
                                              <span className="text-foreground">{row.original.gunterNation}</span>
                                            </div>
                                          )}
                                          {row.original.gunterOperator && (
                                            <div>
                                              <span className="text-muted-foreground block mb-0.5 uppercase tracking-widest text-[10px]">Operator</span>
                                              <span className="text-foreground">{row.original.gunterOperator}</span>
                                            </div>
                                          )}
                                          {row.original.gunterContractors && (
                                            <div className={row.original.gunterContractors.length > 60 ? "col-span-2 md:col-span-3" : ""}>
                                              <span className="text-muted-foreground block mb-0.5 uppercase tracking-widest text-[10px]">Contractors</span>
                                              <span className="text-foreground whitespace-normal">{row.original.gunterContractors}</span>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                        {row.original.gunterType && (
                                          <Badge variant="outline" className="font-mono text-[10px] uppercase rounded-none border-accent/60 text-accent">
                                            {row.original.gunterType}
                                          </Badge>
                                        )}
                                        <a
                                          href={row.original.gunterUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          className="text-accent underline underline-offset-2 hover:text-primary transition-colors inline-flex items-center gap-1"
                                        >
                                          Full dossier — Gunter's Space Page
                                          <ChevronRight className="w-3 h-3" />
                                        </a>
                                      </div>
                                      <p className="text-muted-foreground/60 text-[10px] normal-case leading-relaxed">
                                        Krebs, Gunter D. "{row.original.gunterTitle || 'Satellite dossier'}". Gunter's Space Page.
                                        Retrieved {row.original.gunterRetrievedAt ? new Date(row.original.gunterRetrievedAt).toISOString().slice(0, 10) : '---'}, from{' '}
                                        {row.original.gunterUrl}
                                      </p>
                                    </div>
                                  )}
                                  {row.original.decayDate && (
                                    <div className="col-span-2 md:col-span-3 mt-1">
                                      <span className="text-destructive font-bold uppercase inline-flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full bg-destructive animate-pulse flex-shrink-0" />
                                        Re-entered / Decayed: {row.original.decayDate}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                      NO MATCHING RECORDS FOUND IN GCAT DATABASE.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {catData && !isLoading && (
          <div className="flex flex-col md:flex-row items-center justify-between p-4 border-t-2 border-border bg-muted/30 gap-4 relative z-10">
            <div className="text-xs text-muted-foreground uppercase font-mono space-y-1">
              <div>
                Displaying {(pagination.pageIndex * pagination.pageSize) + 1} - {Math.min((pagination.pageIndex + 1) * pagination.pageSize, catData.total)} of {catData.total.toLocaleString()} records
              </div>
              <div>
                <span className="text-primary">Total mass in selection: {formatTonnes(catData.filteredMassKg)}</span>
                {catData.filteredEstMassKg > 0 && (
                  <span
                    className="text-accent cursor-help"
                    title="Mass theorized by the Bureau's Office of Estimated Tonnage for objects GCAT has not weighed."
                  > + {formatTonnes(catData.filteredEstMassKg)} theorized</span>
                )}
              </div>
              {(filters?.gunterMatched ?? 0) > 0 && (
                <div
                  className="cursor-help"
                  title="Objects cross-matched by COSPAR id to a satellite dossier on Gunter's Space Page (space.skyrocket.de, Gunter Dirk Krebs). Coverage grows daily as the Bureau's crawler works through the backlog at a polite pace."
                >
                  <span className="text-accent">Gunter dossiers on file: {filters!.gunterMatched.toLocaleString()}</span>
                  {" "}of {filters!.totalObjects.toLocaleString()} objects
                  {" "}({((filters!.gunterMatched / Math.max(1, filters!.totalObjects)) * 100).toFixed(1)}%)
                </div>
              )}
            </div>
            
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                className="rounded-none border-primary/50 text-primary hover:bg-primary hover:text-primary-foreground disabled:border-border disabled:text-muted-foreground"
              >
                PREV
              </Button>
              <span className="text-xs font-mono px-4 text-primary">
                PAGE {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                className="rounded-none border-primary/50 text-primary hover:bg-primary hover:text-primary-foreground disabled:border-border disabled:text-muted-foreground"
              >
                NEXT
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
