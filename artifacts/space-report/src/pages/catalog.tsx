import React, { useState } from "react";
import { 
  useGetSatcat, 
  useGetSatcatFilters, 
  getGetSatcatQueryKey 
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
import { Database, Loader2, Search, ChevronDown, ChevronUp, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Catalog() {
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
  const [sorting, setSorting] = useState<SortingState>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [classFilter, setObjectClassFilter] = useState<string>("all");
  const [orbitFilter, setOrbitFilter] = useState<string>("all");
  const [stateFilter, setSatStateFilter] = useState<string>("all");

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
    sort: sorting.length > 0 ? sorting[0].id : undefined,
    order: sorting.length > 0 ? (sorting[0].desc ? "desc" as const : "asc" as const) : undefined,
  };

  const { data: catData, isLoading, isError } = useGetSatcat(queryParams, {
    query: {
      enabled: true,
      queryKey: getGetSatcatQueryKey(queryParams)
    }
  });

  const toggleRow = (id: string) => {
    setExpandedRows(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setDebouncedSearch(search);
    setPagination(p => ({ ...p, pageIndex: 0 }));
  };

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
          title="CASE #JCAT-0001: Primary keys begin with 'S' — a mandatory string prefix with zero semantic value. Numeric sorting requires stripping it first. Case open."
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
              title="CASE #JCAT-0001: Unnecessary string prefix. Contributes nothing. The catalog is called the Satellite Catalog. We know."
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
      cell: ({ row }: any) => row.original.massKg?.toLocaleString() || '---'
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
              placeholder="SEARCH DESIGNATION OR NAME..." 
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
                            <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs font-mono border-l-4 border-primary ml-2 my-2 bg-background/50">
                              <div>
                                <span className="text-muted-foreground block mb-1">APOGEE/PERIGEE</span>
                                <span className="text-primary">{row.original.apogeeKm || '---'} / {row.original.perigeeKm || '---'} km</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground block mb-1">INCLINATION</span>
                                <span className="text-accent">{row.original.incDeg || '---'}°</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground block mb-1">PERIOD</span>
                                <span className="text-secondary">{row.original.periodMin || '---'} min</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground block mb-1">LAUNCH VEHICLE / SITE</span>
                                <span className="text-chart-4">{row.original.lv || '---'} ({row.original.site || '---'})</span>
                              </div>
                              {row.original.decayDate && (
                                <div className="col-span-2 md:col-span-4 mt-2">
                                  <span className="text-destructive font-bold uppercase inline-flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
                                    DECAYED / REENTERED: {row.original.decayDate}
                                  </span>
                                </div>
                              )}
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
            <div className="text-xs text-muted-foreground uppercase font-mono">
              Displaying {(pagination.pageIndex * pagination.pageSize) + 1} - {Math.min((pagination.pageIndex + 1) * pagination.pageSize, catData.total)} of {catData.total.toLocaleString()} records
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
