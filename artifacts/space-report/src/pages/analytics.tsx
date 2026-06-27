import { useGetSatcatStats, useGetSatcatByYearProvider } from "@workspace/api-client-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch, useLocation } from "wouter";
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  BarChart, Bar, Cell, ReferenceArea, ReferenceLine, Label, LabelList
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Radar, Activity, Loader2, TrendingUp, Zap, MapPin, Building2 } from "lucide-react";
import { OrbitalMap } from "@/components/OrbitalMap";
import { DeorbitAnimation } from "@/components/DeorbitAnimation";
import { MassCDFChart } from "@/components/MassCDFChart";

const COLORS = [
  'hsl(140 100% 50%)',
  'hsl(180 100% 50%)',
  'hsl(35 100% 50%)',
  'hsl(280 100% 60%)',
  'hsl(0 100% 60%)',
  'hsl(220 100% 70%)',
  'hsl(320 100% 60%)',
];

const ERAS = [
  { label: 'COLD WAR',  start: '1957', end: '1991', color: 'hsl(220 80% 50% / 0.08)', textColor: 'hsl(220 80% 70%)' },
  { label: 'SHUTTLE ERA', start: '1981', end: '2011', color: 'hsl(35 80% 50% / 0.07)',  textColor: 'hsl(35 80% 70%)' },
  { label: 'COMMERCIAL', start: '2010', end: '2019', color: 'hsl(140 80% 50% / 0.08)', textColor: 'hsl(140 80% 60%)' },
  { label: 'STARLINK ERA', start: '2020', end: '2026', color: 'hsl(0 80% 50% / 0.12)',   textColor: 'hsl(0 80% 65%)' },
];

function OrbitPieChart({ byOrbit }: { byOrbit: Array<{ label: string; massKg: number; count: number; payloadCount: number }> }) {
  const orbitData = byOrbit.filter(o => o.massKg > 0).sort((a, b) => b.massKg - a.massKg).slice(0, 8);
  return (
    <Card className="border-2 border-border bg-card relative overflow-hidden">
      <CardHeader className="bg-muted/30 border-b border-border">
        <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
          <Activity className="w-4 h-4" /> Mass by Orbit Classification
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-6 pb-2 pl-0">
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={orbitData} layout="vertical" margin={{ top: 5, right: 50, left: 55, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
              <XAxis type="number" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 10 }} tickFormatter={(val: number) => `${(val / 1000).toFixed(0)}t`} />
              <YAxis type="category" dataKey="label" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(140 100% 50%)', fontSize: 12 }} width={65} />
              <RechartsTooltip
                formatter={(val: number) => [`${(val / 1000).toFixed(1)}t`, 'Mass']}
                contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontFamily: 'monospace' }}
                labelStyle={{ color: 'hsl(var(--primary))' }}
              />
              <Bar dataKey="massKg" radius={[0, 4, 4, 0]}>
                {orbitData.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

const FALCON_COLOR   = 'hsl(140 100% 50%)';
const STARSHIP_COLOR = 'hsl(35 100% 55%)';

function FalconVsStarshipChart() {
  const { data, isLoading } = useQuery<{
    rows: Array<{ year: string; falcon: number; starship: number }>;
    starshipTotal: number;
  }>({
    queryKey: ['falcon-vs-starship'],
    queryFn: () => fetch('/api/satcat/falcon-vs-starship').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading || !data) return (
    <div className="flex items-center justify-center h-[420px] text-muted-foreground font-mono text-sm animate-pulse uppercase lg:col-span-2">
      Computing vehicle trajectories...
    </div>
  );

  const rows = data.rows;
  const falconTotal = rows.reduce((s, r) => s + r.falcon, 0);
  const peakRow = [...rows].sort((a, b) => b.falcon - a.falcon)[0];
  const noStarship = data.starshipTotal === 0;

  const FvsTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const falcon   = payload.find((p: any) => p.dataKey === 'falcon')?.value ?? 0;
    const starship = payload.find((p: any) => p.dataKey === 'starship')?.value ?? 0;
    return (
      <div className="bg-card border-2 border-primary p-3 shadow-xl font-mono text-sm z-50">
        <p className="text-primary font-bold mb-2 pb-1 border-b border-primary/30 uppercase">{label}</p>
        <div className="space-y-1 text-card-foreground">
          <p><span style={{ color: FALCON_COLOR }}>■</span> <span className="text-muted-foreground">Falcon 9 / Heavy:</span> {(falcon / 1000).toFixed(1)}t</p>
          <p><span style={{ color: STARSHIP_COLOR }}>■</span> <span className="text-muted-foreground">Starship:</span> {starship > 0 ? `${(starship / 1000).toFixed(1)}t` : '—'}</p>
        </div>
      </div>
    );
  };

  return (
    <Card className="border-2 border-border bg-card lg:col-span-2 overflow-hidden relative">
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-30" />
      <CardHeader className="bg-muted/30 border-b border-border">
        <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
          <Zap className="w-4 h-4" /> Falcon vs Starship — Mass to Orbit (2010+)
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 pb-2 pl-0">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-6 pb-5">
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Falcon All-Time</div>
            <div className="text-lg font-bold" style={{ color: FALCON_COLOR }}>{(falconTotal / 1000).toFixed(0)}t</div>
            <div className="text-xs text-muted-foreground">Falcon 9 + Heavy</div>
          </div>
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Peak Year</div>
            <div className="text-lg font-bold" style={{ color: FALCON_COLOR }}>{peakRow?.year}</div>
            <div className="text-xs text-muted-foreground">{peakRow ? (peakRow.falcon / 1000).toFixed(0) : '—'}t</div>
          </div>
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Starship Total</div>
            <div className="text-lg font-bold" style={{ color: STARSHIP_COLOR }}>{noStarship ? '—' : `${(data.starshipTotal / 1000).toFixed(0)}t`}</div>
            <div className="text-xs text-muted-foreground">{noStarship ? 'Not yet in GCAT' : 'Orbital payloads'}</div>
          </div>
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Starship Capacity</div>
            <div className="text-lg font-bold" style={{ color: STARSHIP_COLOR }}>~150t</div>
            <div className="text-xs text-muted-foreground">per flight (LEO)</div>
          </div>
        </div>

        <div className="flex items-center gap-4 px-6 pb-4 font-mono text-xs flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: FALCON_COLOR }} />
            <span className="text-muted-foreground">Falcon 9 / Falcon Heavy</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: STARSHIP_COLOR }} />
            <span className="text-muted-foreground">Starship</span>
          </span>
          {noStarship && (
            <span className="ml-auto text-amber-400/70 border border-amber-400/30 px-2 py-0.5 rounded text-[10px] uppercase tracking-wide">
              ⚠ Starship: test flights catalogued — orbital payload deployments pending GCAT entry
            </span>
          )}
        </div>

        <div className="h-[360px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 10, right: 30, left: 20, bottom: 0 }} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="year" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
              <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}t`} width={55} />
              <RechartsTooltip content={<FvsTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.3)' }} />
              <Bar dataKey="falcon" name="Falcon" fill={FALCON_COLOR} radius={[3, 3, 0, 0]} />
              <Bar dataKey="starship" name="Starship" fill={STARSHIP_COLOR} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="px-6 pt-3 pb-1">
          <p className="text-xs font-mono text-muted-foreground/60">
            <span className="text-amber-400/70">// </span>
            {noStarship
              ? 'Starship has conducted orbital test flights but has not yet deployed commercially catalogued payloads in the GCAT database. When it does, a single Starship flight (~150t LEO) will dwarf an entire Falcon 9 year from before 2020.'
              : `Starship is now in the catalog. Watch this space.`
            }
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

const CAPE_COLOR    = 'hsl(180 100% 45%)';
const VAND_COLOR    = 'hsl(140 100% 50%)';
const OTHER_SITE_COLOR = 'hsl(35 100% 50%)';

function SpaceXBySiteChart() {
  const [view, setView] = useState<'annual' | 'monthly'>('annual');

  const { data, isLoading } = useQuery<{
    rows: Array<{ year: string; capeCanaveral: number; vandenberg: number; other: number }>;
  }>({
    queryKey: ['spacex-by-site'],
    queryFn: () => fetch('/api/satcat/spacex-by-site').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const currentYear = data?.rows.length
    ? data.rows[data.rows.length - 1].year
    : String(new Date().getFullYear());

  const { data: monthlyData, isLoading: monthlyLoading } = useQuery<{
    year: string;
    rows: Array<{ month: string; monthNum: number; capeCanaveral: number; vandenberg: number; other: number }>;
  }>({
    queryKey: ['spacex-by-site-monthly', currentYear],
    queryFn: () => fetch(`/api/satcat/spacex-by-site-monthly?year=${currentYear}`).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
    enabled: view === 'monthly',
  });

  if (isLoading || !data) return (
    <div className="flex items-center justify-center h-[360px] text-muted-foreground font-mono text-sm animate-pulse uppercase">
      Triangulating launch vectors...
    </div>
  );

  const annualRows  = data.rows;
  const monthlyRows = monthlyData?.rows ?? [];
  const activeRows  = view === 'monthly' ? monthlyRows : annualRows;

  const totalCape  = activeRows.reduce((s, r) => s + r.capeCanaveral, 0);
  const totalVand  = activeRows.reduce((s, r) => s + r.vandenberg, 0);
  const totalOther = activeRows.reduce((s, r) => s + r.other, 0);
  const totalAll   = totalCape + totalVand + totalOther;
  const pct = (n: number) => totalAll > 0 ? ((n / totalAll) * 100).toFixed(0) : '0';

  const currentMonthIdx = new Date().getMonth(); // 0-based

  const SiteTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const cape  = payload.find((p: any) => p.dataKey === 'capeCanaveral')?.value ?? 0;
    const vand  = payload.find((p: any) => p.dataKey === 'vandenberg')?.value ?? 0;
    const other = payload.find((p: any) => p.dataKey === 'other')?.value ?? 0;
    const total = cape + vand + other;
    return (
      <div className="bg-card border-2 border-primary p-3 shadow-xl font-mono text-sm z-50">
        <p className="text-primary font-bold mb-2 pb-1 border-b border-primary/30 uppercase">{label}</p>
        <div className="space-y-1 text-card-foreground">
          <p><span style={{ color: CAPE_COLOR }}>■</span> <span className="text-muted-foreground">Cape Canaveral / KSC:</span> {(cape / 1000).toFixed(1)}t</p>
          <p><span style={{ color: VAND_COLOR }}>■</span> <span className="text-muted-foreground">Vandenberg SFB:</span> {(vand / 1000).toFixed(1)}t</p>
          {other > 0 && <p><span style={{ color: OTHER_SITE_COLOR }}>■</span> <span className="text-muted-foreground">Other:</span> {(other / 1000).toFixed(1)}t</p>}
          {total > 0 && <p className="border-t border-border/50 mt-1 pt-1 text-muted-foreground">Total: {(total / 1000).toFixed(1)}t</p>}
          {total === 0 && <p className="text-muted-foreground/50 italic">No launches catalogued yet</p>}
        </div>
      </div>
    );
  };

  return (
    <Card className="border-2 border-border bg-card overflow-hidden relative">
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-30" />
      <CardHeader className="bg-muted/30 border-b border-border">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
            <MapPin className="w-4 h-4" />
            {view === 'annual'
              ? 'SpaceX — Mass by Launch Site (2010+)'
              : `SpaceX — ${currentYear} Monthly Launch Cadence`}
          </CardTitle>
          <div className="flex items-center gap-1 font-mono text-xs border border-border rounded overflow-hidden self-start sm:self-auto">
            <button
              onClick={() => setView('annual')}
              className={`px-3 py-1.5 uppercase transition-colors ${view === 'annual' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
            >
              Annual
            </button>
            <button
              onClick={() => setView('monthly')}
              className={`px-3 py-1.5 uppercase transition-colors flex items-center gap-1 ${view === 'monthly' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
            >
              <Zap className="w-3 h-3" /> {currentYear} Now
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4 pb-2 pl-0">
        {view === 'monthly' && monthlyLoading ? (
          <div className="flex items-center justify-center h-[360px] text-muted-foreground font-mono text-sm animate-pulse uppercase">
            Pulling monthly sortie data...
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 px-6 pb-4">
              {([
                { label: view === 'monthly' ? 'Cape YTD' : 'Cape / KSC', value: totalCape,  color: CAPE_COLOR },
                { label: view === 'monthly' ? 'Vand YTD' : 'Vandenberg',  value: totalVand,  color: VAND_COLOR },
                { label: view === 'monthly' ? 'Other YTD' : 'Other Sites', value: totalOther, color: OTHER_SITE_COLOR },
              ] as const).map(({ label, value, color }) => (
                <div key={label} className="border border-border bg-muted/20 p-2 font-mono text-center">
                  <div className="text-[9px] text-muted-foreground uppercase mb-0.5">{label}</div>
                  <div className="text-base font-bold" style={{ color }}>{(value / 1000).toFixed(0)}t</div>
                  <div className="text-[10px] text-muted-foreground">{pct(value)}%</div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3 px-6 pb-3 font-mono text-xs flex-wrap">
              {([
                { color: CAPE_COLOR, label: 'Cape Canaveral / KSC' },
                { color: VAND_COLOR, label: 'Vandenberg SFB' },
                { color: OTHER_SITE_COLOR, label: 'Other' },
              ] as const).map(({ color, label }) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ background: color }} />
                  <span className="text-muted-foreground">{label}</span>
                </span>
              ))}
              {view === 'monthly' && (
                <span className="ml-auto text-primary/60 text-[10px] uppercase tracking-wide font-mono">
                  YTD · {new Date().toLocaleString('en', { month: 'long' })} {currentYear}
                </span>
              )}
            </div>

            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={view === 'monthly' ? monthlyRows : annualRows}
                  margin={{ top: 5, right: 20, left: 20, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey={view === 'monthly' ? 'month' : 'year'}
                    stroke="hsl(var(--muted-foreground))"
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                    tickFormatter={(v) => `${(v / 1000).toFixed(1)}t`}
                    width={48}
                  />
                  <RechartsTooltip content={<SiteTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.3)' }} />
                  {view === 'monthly' && (
                    <ReferenceLine
                      x={['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][currentMonthIdx]}
                      stroke="hsl(var(--primary) / 0.6)"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                    >
                      <Label value="◀ NOW" position="insideTopRight" fill="hsl(var(--primary))" fontSize={9} fontFamily="monospace" fontWeight="bold" />
                    </ReferenceLine>
                  )}
                  <Bar dataKey="capeCanaveral" stackId="a" fill={CAPE_COLOR} />
                  <Bar dataKey="vandenberg"    stackId="a" fill={VAND_COLOR} />
                  <Bar dataKey="other"         stackId="a" fill={OTHER_SITE_COLOR} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {view === 'monthly' && (
              <div className="px-6 pt-2 pb-1">
                <p className="text-xs font-mono text-muted-foreground/60">
                  <span className="text-primary/50">// </span>
                  Each bar = all Falcon 9 / Heavy payloads catalogued in GCAT for that month.
                  Empty bars ahead are open launch windows — waiting to be filled.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const STARLINK_COLOR   = 'hsl(0 90% 60%)';
const USGOV_COLOR      = 'hsl(220 100% 65%)';
const COMMERCIAL_COLOR = 'hsl(35 100% 50%)';

function SpaceXByEntityChart() {
  const { data, isLoading } = useQuery<{
    rows: Array<{ year: string; starlink: number; usGov: number; commercial: number }>;
  }>({
    queryKey: ['spacex-by-entity'],
    queryFn: () => fetch('/api/satcat/spacex-by-entity').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading || !data) return (
    <div className="flex items-center justify-center h-[360px] text-muted-foreground font-mono text-sm animate-pulse uppercase">
      Classifying payload customers...
    </div>
  );

  const rows = data.rows;
  const totalStarlink = rows.reduce((s, r) => s + r.starlink, 0);
  const totalGov      = rows.reduce((s, r) => s + r.usGov, 0);
  const totalComm     = rows.reduce((s, r) => s + r.commercial, 0);
  const totalAll      = totalStarlink + totalGov + totalComm;
  const pct = (n: number) => totalAll > 0 ? ((n / totalAll) * 100).toFixed(0) : '0';

  const EntityTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const sl   = payload.find((p: any) => p.dataKey === 'starlink')?.value ?? 0;
    const gov  = payload.find((p: any) => p.dataKey === 'usGov')?.value ?? 0;
    const comm = payload.find((p: any) => p.dataKey === 'commercial')?.value ?? 0;
    const total = sl + gov + comm;
    return (
      <div className="bg-card border-2 border-primary p-3 shadow-xl font-mono text-sm z-50">
        <p className="text-primary font-bold mb-2 pb-1 border-b border-primary/30 uppercase">{label}</p>
        <div className="space-y-1 text-card-foreground">
          <p><span style={{ color: STARLINK_COLOR }}>■</span> <span className="text-muted-foreground">Starlink:</span> {(sl / 1000).toFixed(1)}t</p>
          <p><span style={{ color: USGOV_COLOR }}>■</span> <span className="text-muted-foreground">US Government:</span> {(gov / 1000).toFixed(1)}t</p>
          <p><span style={{ color: COMMERCIAL_COLOR }}>■</span> <span className="text-muted-foreground">Commercial / Intl:</span> {(comm / 1000).toFixed(1)}t</p>
          <p className="border-t border-border/50 mt-1 pt-1 text-muted-foreground">Total: {(total / 1000).toFixed(1)}t</p>
        </div>
      </div>
    );
  };

  return (
    <Card className="border-2 border-border bg-card overflow-hidden relative">
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-30" />
      <CardHeader className="bg-muted/30 border-b border-border">
        <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
          <Building2 className="w-4 h-4" /> SpaceX — Mass by Customer Segment (2010+)
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 pb-2 pl-0">
        <div className="grid grid-cols-3 gap-2 px-6 pb-4">
          {([
            { label: 'Starlink', value: totalStarlink, color: STARLINK_COLOR },
            { label: 'US Government', value: totalGov, color: USGOV_COLOR },
            { label: 'Commercial/Intl', value: totalComm, color: COMMERCIAL_COLOR },
          ] as const).map(({ label, value, color }) => (
            <div key={label} className="border border-border bg-muted/20 p-2 font-mono text-center">
              <div className="text-[9px] text-muted-foreground uppercase mb-0.5">{label}</div>
              <div className="text-base font-bold" style={{ color }}>{(value / 1000).toFixed(0)}t</div>
              <div className="text-[10px] text-muted-foreground">{pct(value)}%</div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 px-6 pb-3 font-mono text-xs flex-wrap">
          {([
            { color: STARLINK_COLOR, label: 'Starlink (SpaceX own)' },
            { color: USGOV_COLOR, label: 'US Government' },
            { color: COMMERCIAL_COLOR, label: 'Commercial & International' },
          ] as const).map(({ color, label }) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: color }} />
              <span className="text-muted-foreground">{label}</span>
            </span>
          ))}
        </div>
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 5, right: 20, left: 20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="year" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
              <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}t`} width={45} />
              <RechartsTooltip content={<EntityTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.3)' }} />
              <Bar dataKey="starlink" stackId="a" fill={STARLINK_COLOR} />
              <Bar dataKey="usGov" stackId="a" fill={USGOV_COLOR} />
              <Bar dataKey="commercial" stackId="a" fill={COMMERCIAL_COLOR} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

const SPACEX_COLOR = 'hsl(0 90% 60%)';
const OTHERS_COLOR = 'hsl(180 100% 45%)';

function SpaceXComparisonChart() {
  const { data, isLoading, isError } = useGetSatcatByYearProvider();
  const [view, setView] = useState<'all' | 'recent'>('all');

  if (isLoading) return (
    <div className="flex items-center justify-center h-[400px] text-muted-foreground font-mono text-sm animate-pulse uppercase">
      Aggregating provider vectors...
    </div>
  );
  if (isError || !data) return null;

  const rows = view === 'recent'
    ? data.byYearProvider.filter((r) => parseInt(r.year) >= 2010)
    : data.byYearProvider;

  const totalSpaceX = rows.reduce((s, r) => s + r.spacex, 0);
  const totalOthers = rows.reduce((s, r) => s + r.others, 0);
  const totalAll = totalSpaceX + totalOthers;
  const spacexPct = totalAll > 0 ? ((totalSpaceX / totalAll) * 100).toFixed(1) : '—';

  const postRows = data.byYearProvider.filter((r) => parseInt(r.year) >= 2020);
  const postSpaceX = postRows.reduce((s, r) => s + r.spacex, 0);
  const postOthers = postRows.reduce((s, r) => s + r.others, 0);
  const postAll = postSpaceX + postOthers;
  const postSpaceXPct = postAll > 0 ? ((postSpaceX / postAll) * 100).toFixed(1) : '—';

  const ProviderTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const spacexVal = payload.find((p: any) => p.dataKey === 'spacex')?.value ?? 0;
    const othersVal = payload.find((p: any) => p.dataKey === 'others')?.value ?? 0;
    const total = spacexVal + othersVal;
    const pct = total > 0 ? ((spacexVal / total) * 100).toFixed(0) : '0';
    return (
      <div className="bg-card border-2 border-primary p-3 box-glow-cyan shadow-xl font-mono text-sm z-50">
        <p className="text-primary font-bold mb-2 pb-1 border-b border-primary/30 uppercase">{label}</p>
        <div className="space-y-1 text-card-foreground">
          <p><span style={{ color: SPACEX_COLOR }}>■</span> <span className="text-muted-foreground">SpaceX (Falcon):</span> {(spacexVal / 1000).toFixed(1)}t</p>
          <p><span style={{ color: OTHERS_COLOR }}>■</span> <span className="text-muted-foreground">Rest of World:</span> {(othersVal / 1000).toFixed(1)}t</p>
          <p className="border-t border-border/50 mt-1 pt-1"><span className="text-muted-foreground">SpaceX share:</span> <span style={{ color: SPACEX_COLOR }}>{pct}%</span></p>
        </div>
      </div>
    );
  };

  return (
    <Card className="border-2 border-border bg-card lg:col-span-2 overflow-hidden relative">
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-30" />

      <CardHeader className="bg-muted/30 border-b border-border">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
            <Zap className="w-4 h-4" /> SpaceX vs Rest-of-World — Annual Mass to Orbit
          </CardTitle>
          <div className="flex items-center gap-1 font-mono text-xs border border-border rounded overflow-hidden self-start sm:self-auto">
            <button
              onClick={() => setView('all')}
              className={`px-3 py-1.5 uppercase transition-colors ${view === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
            >
              All Years
            </button>
            <button
              onClick={() => setView('recent')}
              className={`px-3 py-1.5 uppercase transition-colors ${view === 'recent' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
            >
              2010+
            </button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-6 pb-2 pl-0">
        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-6 pb-5">
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">SpaceX All-Time</div>
            <div className="text-lg font-bold" style={{ color: SPACEX_COLOR }}>{(totalSpaceX / 1000).toFixed(0)}t</div>
            <div className="text-xs text-muted-foreground">{spacexPct}% of total</div>
          </div>
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Rest of World</div>
            <div className="text-lg font-bold" style={{ color: OTHERS_COLOR }}>{(totalOthers / 1000).toFixed(0)}t</div>
            <div className="text-xs text-muted-foreground">{totalAll > 0 ? (100 - parseFloat(spacexPct)).toFixed(1) : '—'}% of total</div>
          </div>
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">SpaceX Post-2020</div>
            <div className="text-lg font-bold" style={{ color: SPACEX_COLOR }}>{(postSpaceX / 1000).toFixed(0)}t</div>
            <div className="text-xs text-muted-foreground">{postSpaceXPct}% of launches</div>
          </div>
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Others Post-2020</div>
            <div className="text-lg font-bold" style={{ color: OTHERS_COLOR }}>{(postOthers / 1000).toFixed(0)}t</div>
            <div className="text-xs text-muted-foreground">{postAll > 0 ? (100 - parseFloat(postSpaceXPct)).toFixed(1) : '—'}% of launches</div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 px-6 pb-4 font-mono text-xs">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: SPACEX_COLOR }} />
            <span className="text-muted-foreground">SpaceX (Falcon 9 / Falcon Heavy)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: OTHERS_COLOR }} />
            <span className="text-muted-foreground">All Other Providers</span>
          </span>
        </div>

        <div className="h-[380px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
              <ReferenceArea x1="2020" x2={rows[rows.length - 1]?.year ?? "2026"} fill="hsl(0 80% 50% / 0.06)" fillOpacity={1} />
              <ReferenceLine x="2020" stroke="hsl(0 80% 60% / 0.6)" strokeWidth={1.5} strokeDasharray="4 4">
                <Label value="▲ STARLINK ERA" position="insideTopRight" fill="hsl(0 80% 65%)" fontSize={9} fontFamily="monospace" fontWeight="bold" offset={4} />
              </ReferenceLine>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="year"
                stroke="hsl(var(--muted-foreground))"
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: view === 'all' ? 9 : 11 }}
                interval={view === 'all' ? 4 : 0}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                tickFormatter={(val) => `${(val / 1000).toFixed(0)}t`}
                width={55}
              />
              <RechartsTooltip content={<ProviderTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.3)' }} />
              <Bar dataKey="others" name="Rest of World" stackId="a" fill={OTHERS_COLOR} radius={[0, 0, 0, 0]} />
              <Bar dataKey="spacex" name="SpaceX" stackId="a" fill={SPACEX_COLOR} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="px-6 pt-3 pb-1">
          <p className="text-xs font-mono text-muted-foreground/60">
            <span className="text-red-400/70">// </span>
            After 2020, SpaceX Falcon 9 batch launches for Starlink swamp every other operator on the planet.
            One rocket family. One company. {postSpaceXPct}% of all mass to orbit since 2020.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

interface LaunchRateResponse {
  years: string[];
  data: Record<string, {
    providers: Array<{ name: string; count: number; vehicles: Array<{ name: string; count: number }> }>;
    vehicles: Array<{ name: string; count: number; provider: string }>;
    total: number;
  }>;
  anticipated: Array<{
    vehicle: string;
    provider: string;
    status: 'FLYING' | 'AWAITING';
    firstYear: string | null;
    totalLaunches: number;
  }>;
}

const ROCKET_LAB_COLOR = 'hsl(140 100% 50%)';
const PROVIDER_DIM = 'hsl(180 60% 40%)';

function LaunchRateChart() {
  const { data, isLoading, isError } = useQuery<LaunchRateResponse>({
    queryKey: ['launch-rate'],
    queryFn: () => fetch('/api/satcat/launch-rate').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const [view, setView] = useState<'provider' | 'vehicle'>('provider');
  const [year, setYear] = useState<string | null>(null);

  if (isLoading) return (
    <Card className="border-2 border-border bg-card lg:col-span-2 overflow-hidden relative">
      <div className="flex items-center justify-center h-[460px] text-muted-foreground font-mono text-sm animate-pulse uppercase">
        Tabulating launch cadence vectors...
      </div>
    </Card>
  );
  if (isError || !data || data.years.length === 0) return null;

  // Default to the latest COMPLETE year (current year tends to be partial).
  const latest = data.years[data.years.length - 1];
  const defaultYear = data.years.length > 1 ? data.years[data.years.length - 2] : latest;
  const selectedYear = year && data.data[year] ? year : defaultYear;
  const yd = data.data[selectedYear];

  const HIGHLIGHT = 'Rocket Lab';

  const providerRows = yd.providers.slice(0, 12).map((p) => ({
    name: p.name,
    count: p.count,
    vehicles: p.vehicles,
    isHighlight: p.name === HIGHLIGHT,
  }));

  const vehicleRows = yd.vehicles.slice(0, 14).map((v) => ({
    name: v.name,
    count: v.count,
    provider: v.provider,
    isHighlight: v.provider === HIGHLIGHT,
  }));

  const rows = view === 'provider' ? providerRows : vehicleRows;

  // Stats: Rocket Lab cadence callout
  const rlIdx = yd.providers.findIndex((p) => p.name === HIGHLIGHT);
  const rl = rlIdx >= 0 ? yd.providers[rlIdx] : null;
  const rlRank = rlIdx >= 0 ? rlIdx + 1 : null;
  const topProvider = yd.providers[0];
  const topShare = yd.total > 0 ? ((topProvider.count / yd.total) * 100).toFixed(0) : '—';

  const LaunchTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const row = payload[0].payload;
    return (
      <div className="bg-card border-2 border-primary p-3 box-glow-cyan shadow-xl font-mono text-sm z-50 max-w-[260px]">
        <p className="text-primary font-bold mb-1 pb-1 border-b border-primary/30 uppercase">{row.name}</p>
        <p className="text-card-foreground mb-1">
          <span className="text-muted-foreground">Orbital launches:</span> {row.count}
        </p>
        {view === 'provider' && row.vehicles?.length > 0 && (
          <div className="border-t border-border/50 mt-1 pt-1 space-y-0.5">
            {row.vehicles.slice(0, 6).map((v: any) => (
              <p key={v.name} className="text-xs text-muted-foreground">
                {v.name}: <span className="text-card-foreground">{v.count}</span>
              </p>
            ))}
            {row.vehicles.length > 6 && (
              <p className="text-xs text-muted-foreground/60">+{row.vehicles.length - 6} more…</p>
            )}
          </div>
        )}
        {view === 'vehicle' && (
          <p className="text-xs text-muted-foreground border-t border-border/50 mt-1 pt-1">{row.provider}</p>
        )}
      </div>
    );
  };

  const recentYears = data.years.slice(-6);

  return (
    <Card className="border-2 border-border bg-card lg:col-span-2 overflow-hidden relative">
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-30" />

      <CardHeader className="bg-muted/30 border-b border-border">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
            <TrendingUp className="w-4 h-4" /> Orbital Launch Cadence — by Provider & Vehicle
          </CardTitle>
          <div className="flex items-center gap-1 font-mono text-xs border border-border rounded overflow-hidden self-start sm:self-auto">
            <button
              onClick={() => setView('provider')}
              className={`px-3 py-1.5 uppercase transition-colors ${view === 'provider' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
            >
              By Provider
            </button>
            <button
              onClick={() => setView('vehicle')}
              className={`px-3 py-1.5 uppercase transition-colors ${view === 'vehicle' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
            >
              By Vehicle
            </button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-6 pb-2 px-4 sm:px-6">
        {/* Year selector */}
        <div className="flex flex-wrap items-center gap-1.5 pb-5 font-mono text-xs">
          <span className="text-muted-foreground uppercase mr-1">Year:</span>
          {recentYears.map((y) => (
            <button
              key={y}
              onClick={() => setYear(y)}
              className={`px-2.5 py-1 rounded border transition-colors ${y === selectedYear ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
            >
              {y}{y === latest ? '*' : ''}
            </button>
          ))}
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pb-5">
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Orbital Launches {selectedYear}</div>
            <div className="text-lg font-bold text-primary">{yd.total}</div>
            <div className="text-xs text-muted-foreground">all providers</div>
          </div>
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Cadence Leader</div>
            <div className="text-lg font-bold" style={{ color: SPACEX_COLOR }}>{topProvider.name}</div>
            <div className="text-xs text-muted-foreground">{topProvider.count} ({topShare}%)</div>
          </div>
          <div className="border rounded p-3 font-mono text-center" style={{ borderColor: ROCKET_LAB_COLOR, background: 'hsl(140 100% 50% / 0.06)' }}>
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Rocket Lab Rank</div>
            <div className="text-lg font-bold" style={{ color: ROCKET_LAB_COLOR }}>{rlRank ? `#${rlRank}` : '—'}</div>
            <div className="text-xs text-muted-foreground">{rl ? `${rl.count} Electron flights` : 'no orbital flights'}</div>
          </div>
          <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
            <div className="text-[10px] text-muted-foreground uppercase mb-1">Distinct Vehicles</div>
            <div className="text-lg font-bold text-primary">{yd.vehicles.length}</div>
            <div className="text-xs text-muted-foreground">families flown</div>
          </div>
        </div>

        <div style={{ height: Math.max(320, rows.length * 30 + 40) }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 5, right: 40, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
              <XAxis type="number" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
              <YAxis
                type="category"
                dataKey="name"
                stroke="hsl(var(--muted-foreground))"
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                width={view === 'provider' ? 120 : 110}
              />
              <RechartsTooltip content={<LaunchTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.3)' }} />
              <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                {rows.map((r, i) => (
                  <Cell key={i} fill={r.isHighlight ? ROCKET_LAB_COLOR : PROVIDER_DIM} />
                ))}
                <LabelList dataKey="count" position="right" fill="hsl(var(--muted-foreground))" fontSize={10} fontFamily="monospace" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="pt-2">
          <p className="text-xs font-mono text-muted-foreground/60">
            <span className="text-primary/50">// </span>
            {selectedYear === latest && <span className="text-amber-400/70">* {latest} partial (year-to-date). </span>}
            Cadence ≠ tonnage. Rocket Lab's Electron lofts tiny payloads, yet its flight count rivals national programs —
            proof that launch <span className="text-primary">rate</span> and mass <span className="text-primary">to orbit</span> are very different scoreboards.
          </p>
        </div>

        {/* Anticipated contenders watchlist */}
        <div className="mt-5 border border-border rounded bg-muted/10 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Radar className="w-4 h-4 text-primary" />
            <h3 className="font-mono text-xs uppercase text-primary tracking-wider">Anticipated Heavy-Lift Contenders — Cadence Watchlist</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {data.anticipated.map((a) => (
              <div
                key={a.vehicle}
                className="flex items-center justify-between gap-2 border border-border/60 rounded px-3 py-2 font-mono text-xs bg-card/40"
              >
                <div className="min-w-0">
                  <div className="text-card-foreground truncate">{a.vehicle}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{a.provider}</div>
                </div>
                <div className="text-right shrink-0">
                  {a.status === 'FLYING' ? (
                    <>
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: 'hsl(140 100% 50% / 0.15)', color: ROCKET_LAB_COLOR }}>
                        FLYING
                      </span>
                      <div className="text-[10px] text-muted-foreground mt-0.5">{a.totalLaunches} since {a.firstYear}</div>
                    </>
                  ) : (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: 'hsl(35 100% 50% / 0.12)', color: 'hsl(35 100% 60%)' }}>
                      AWAITING
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] font-mono text-muted-foreground/50 mt-3">
            <span className="text-amber-400/60">// </span>
            These vehicles surface automatically the moment GCAT logs their first orbital flight — just like Starship did.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Analytics() {
  const { data: stats, isLoading, isError } = useGetSatcatStats();
  const search = useSearch();
  const [location, navigate] = useLocation();

  const chartView: 'all' | 'recent' =
    new URLSearchParams(search).get('chartView') === 'recent' ? 'recent' : 'all';

  const setChartView = (view: 'all' | 'recent') => {
    const params = new URLSearchParams(search);
    if (view === 'all') {
      params.delete('chartView');
    } else {
      params.set('chartView', view);
    }
    const qs = params.toString();
    navigate(location + (qs ? '?' + qs : ''));
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-6 text-primary">
        <Loader2 className="w-16 h-16 animate-spin" />
        <div className="text-xl font-bold font-display uppercase tracking-widest text-glow animate-pulse">
          GCAT UPLINK IN PROGRESS...
        </div>
        <p className="text-muted-foreground font-mono">Aggregating orbital mass data vectors</p>
      </div>
    );
  }

  if (isError || !stats) {
    return (
      <div className="p-6 border-2 border-destructive bg-destructive/10 text-destructive text-center uppercase font-bold text-lg">
        Critical Error: Failed to establish GCAT uplink.
      </div>
    );
  }

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-card border-2 border-primary p-3 box-glow-cyan shadow-xl font-mono text-sm z-50">
          <p className="text-primary font-bold mb-2 pb-1 border-b border-primary/30 uppercase">{label || data.label}</p>
          <div className="space-y-1 text-card-foreground">
            <p><span className="text-muted-foreground">Mass:</span> {(data.massKg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} Tonnes</p>
            <p><span className="text-muted-foreground">Objects:</span> {data.count.toLocaleString()}</p>
            <p><span className="text-muted-foreground">Payloads:</span> {data.payloadCount.toLocaleString()}</p>
          </div>
        </div>
      );
    }
    return null;
  };

  // Surge stats: compare pre-2020 decade vs 2020-present
  const recentYears = stats.byYear.filter((y: any) => parseInt(y.label) >= 2010);
  const pre2020 = stats.byYear.filter((y: any) => parseInt(y.label) >= 2010 && parseInt(y.label) < 2020);
  const post2020 = stats.byYear.filter((y: any) => parseInt(y.label) >= 2020);
  const pre2020Total = pre2020.reduce((s: number, y: any) => s + y.massKg, 0);
  const post2020Total = post2020.reduce((s: number, y: any) => s + y.massKg, 0);
  const pre2020Avg = pre2020.length ? pre2020Total / pre2020.length : 0;
  const post2020Avg = post2020.length ? post2020Total / post2020.length : 0;
  const peakYear = [...stats.byYear].sort((a: any, b: any) => b.massKg - a.massKg)[0];

  return (
    <div className="space-y-8 animate-in fade-in duration-700">
      <div className="flex items-center gap-3 border-b-2 border-border pb-4 mb-6">
        <Radar className="w-8 h-8 text-accent animate-[spin_4s_linear_infinite]" />
        <div>
          <h1 className="text-2xl font-display font-bold text-accent uppercase text-glow">Mass to Orbit Analytics</h1>
          <p className="text-muted-foreground text-sm uppercase">Historical tonnage distribution across temporal and spatial vectors</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* SpaceX segmented by launch site */}
        <SpaceXBySiteChart />

        {/* SpaceX segmented by customer */}
        <SpaceXByEntityChart />

        {/* Falcon vs Starship vehicle comparison */}
        <FalconVsStarshipChart />

        {/* SpaceX vs Rest-of-World comparison */}
        <SpaceXComparisonChart />

        {/* Orbital launch cadence by provider & vehicle */}
        <LaunchRateChart />

        {/* Orbital Distribution Map */}
        <OrbitalMap />

        {/* Deorbit Animation */}
        <DeorbitAnimation />

        {/* Mass CDF */}
        <MassCDFChart />

        {/* Orbital map context note */}
        <div className="lg:col-span-2 -mt-2 px-1">
          <p className="text-xs font-mono text-muted-foreground/60 leading-relaxed">
            <span className="text-primary/50">// NOTE:</span>{" "}
            The clusters you see are not merely data points. Several represent debris fields from anti-satellite weapons tests —
            objects launched not to orbit, but to destroy something already orbiting. They are in the catalog now, alongside everything else.
            The catalog does not distinguish between science and ordnance. It simply records what is up there.
            <span className="text-muted-foreground/40"> What goes up is everyone's problem.</span>
          </p>
        </div>

        {/* ── TEMPORAL CHART ── */}
        <Card className="border-2 border-border bg-card lg:col-span-2 overflow-hidden relative">
          <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-30" />

          <CardHeader className="bg-muted/30 border-b border-border">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
                <Activity className="w-4 h-4" />
                {chartView === 'all' ? 'Temporal Mass Distribution — Full History' : 'Starlink Era Zoom — 2010 to 2026'}
              </CardTitle>
              <div className="flex items-center gap-1 font-mono text-xs border border-border rounded overflow-hidden self-start sm:self-auto">
                <button
                  onClick={() => setChartView('all')}
                  className={`px-3 py-1.5 uppercase transition-colors ${chartView === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
                >
                  All Years
                </button>
                <button
                  onClick={() => setChartView('recent')}
                  className={`px-3 py-1.5 uppercase transition-colors flex items-center gap-1 ${chartView === 'recent' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
                >
                  <Zap className="w-3 h-3" /> Starlink Surge
                </button>
              </div>
            </div>
          </CardHeader>

          <CardContent className="pt-6 pb-2 pl-0">
            {chartView === 'all' ? (
              <>
                {/* Era legend */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 px-6 pb-4 font-mono text-xs">
                  {ERAS.map(era => (
                    <span key={era.label} style={{ color: era.textColor }} className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-sm" style={{ background: era.textColor, opacity: 0.7 }} />
                      {era.label}
                    </span>
                  ))}
                </div>
                <div className="h-[380px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={stats.byYear} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorMassYear" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(180 100% 50%)" stopOpacity={0.8}/>
                          <stop offset="95%" stopColor="hsl(180 100% 50%)" stopOpacity={0}/>
                        </linearGradient>
                      </defs>

                      {/* Era shading bands */}
                      {ERAS.map(era => (
                        <ReferenceArea key={era.label} x1={era.start} x2={era.end} fill={era.color} fillOpacity={1} />
                      ))}

                      {/* Era boundary lines with labels */}
                      <ReferenceLine x="1957" stroke="hsl(220 80% 60% / 0.4)" strokeDasharray="3 3">
                        <Label value="SPUTNIK" position="insideTopRight" fill="hsl(220 80% 70%)" fontSize={9} fontFamily="monospace" offset={4} />
                      </ReferenceLine>
                      <ReferenceLine x="1981" stroke="hsl(35 80% 60% / 0.4)" strokeDasharray="3 3">
                        <Label value="STS-1" position="insideTopRight" fill="hsl(35 80% 70%)" fontSize={9} fontFamily="monospace" offset={4} />
                      </ReferenceLine>
                      <ReferenceLine x="2011" stroke="hsl(35 80% 60% / 0.4)" strokeDasharray="3 3">
                        <Label value="SHUTTLE END" position="insideTopRight" fill="hsl(35 80% 70%)" fontSize={9} fontFamily="monospace" offset={4} />
                      </ReferenceLine>
                      <ReferenceLine x="2020" stroke="hsl(0 80% 60% / 0.6)" strokeWidth={1.5}>
                        <Label value="▲ STARLINK" position="insideTopRight" fill="hsl(0 80% 65%)" fontSize={10} fontFamily="monospace" fontWeight="bold" offset={4} />
                      </ReferenceLine>

                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="label"
                        stroke="hsl(var(--muted-foreground))"
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                        interval={9}
                      />
                      <YAxis
                        stroke="hsl(var(--muted-foreground))"
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                        tickFormatter={(val) => `${(val / 1000).toFixed(0)}t`}
                        width={60}
                      />
                      <RechartsTooltip content={<CustomTooltip />} cursor={{ stroke: 'hsl(var(--primary))', strokeWidth: 1, strokeDasharray: '4 4' }} />
                      <Area type="monotone" dataKey="massKg" stroke="hsl(180 100% 50%)" strokeWidth={2} fillOpacity={1} fill="url(#colorMassYear)" activeDot={{ r: 6, fill: 'hsl(var(--primary))', stroke: 'hsl(var(--background))', strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </>
            ) : (
              <>
                {/* Starlink surge surge stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-6 pb-5">
                  <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
                    <div className="text-[10px] text-muted-foreground uppercase mb-1">Peak Year</div>
                    <div className="text-lg font-bold text-red-400">{peakYear?.label}</div>
                    <div className="text-xs text-muted-foreground">{peakYear ? (peakYear.massKg / 1000).toFixed(0) : '—'}t</div>
                  </div>
                  <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
                    <div className="text-[10px] text-muted-foreground uppercase mb-1">2020–Now Total</div>
                    <div className="text-lg font-bold text-red-400">{(post2020Total / 1000).toFixed(0)}t</div>
                    <div className="text-xs text-muted-foreground">{post2020.length} years</div>
                  </div>
                  <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
                    <div className="text-[10px] text-muted-foreground uppercase mb-1">Avg/yr 2010–19</div>
                    <div className="text-lg font-bold text-primary">{(pre2020Avg / 1000).toFixed(0)}t</div>
                  </div>
                  <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center">
                    <div className="text-[10px] text-muted-foreground uppercase mb-1">Avg/yr 2020+</div>
                    <div className="text-lg font-bold text-red-400 flex items-center justify-center gap-1">
                      <TrendingUp className="w-3.5 h-3.5" />
                      {(post2020Avg / 1000).toFixed(0)}t
                    </div>
                    <div className="text-xs text-red-400/70">
                      {pre2020Avg > 0 ? `${(post2020Avg / pre2020Avg).toFixed(1)}× prior decade` : ''}
                    </div>
                  </div>
                </div>

                <div className="h-[380px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={recentYears} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="starlinkGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(0 80% 60%)" stopOpacity={0.9}/>
                          <stop offset="95%" stopColor="hsl(0 80% 40%)" stopOpacity={0.7}/>
                        </linearGradient>
                      </defs>

                      {/* Shade the Starlink era */}
                      <ReferenceArea x1="2020" x2="2026" fill="hsl(0 80% 50% / 0.07)" fillOpacity={1} />

                      {/* Starlink boundary */}
                      <ReferenceLine x="2020" stroke="hsl(0 80% 60% / 0.8)" strokeWidth={2} strokeDasharray="4 4">
                        <Label value="◀ Pre-Starlink   Starlink Era ▶" position="top" fill="hsl(0 80% 65%)" fontSize={10} fontFamily="monospace" />
                      </ReferenceLine>

                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="label"
                        stroke="hsl(var(--muted-foreground))"
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                      />
                      <YAxis
                        stroke="hsl(var(--muted-foreground))"
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                        tickFormatter={(val) => `${(val / 1000).toFixed(0)}t`}
                        width={60}
                      />
                      <RechartsTooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.3)' }} />
                      <Bar dataKey="massKg" radius={[3, 3, 0, 0]}>
                        {recentYears.map((entry: any) => {
                          const yr = parseInt(entry.label);
                          const isStarlink = yr >= 2020;
                          const isPeak = entry.label === peakYear?.label;
                          return (
                            <Cell
                              key={`cell-${entry.label}`}
                              fill={isPeak ? 'hsl(0 100% 65%)' : isStarlink ? 'hsl(0 80% 55%)' : 'hsl(180 100% 45%)'}
                              opacity={isPeak ? 1 : 0.85}
                            />
                          );
                        })}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Footnote */}
                <div className="px-6 pt-3 pb-1">
                  <p className="text-xs font-mono text-muted-foreground/60">
                    <span className="text-red-400/70">// </span>
                    Bars after 2020 reflect the Starlink mass-to-orbit surge driven by SpaceX Falcon 9 batch launches.
                    The {peakYear?.label} peak of {peakYear ? (peakYear.massKg / 1000).toFixed(0) : '?'}t exceeds the entire Cold War decade output.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Top Countries */}
        <Card className="border-2 border-border bg-card relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-30" />
          <CardHeader className="bg-muted/30 border-b border-border">
            <CardTitle className="text-secondary uppercase flex items-center gap-2 text-sm">
              <Activity className="w-4 h-4" /> Top Nations by Mass
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 pb-2 pl-0">
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.byCountry.slice(0, 10)} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 10 }} tickFormatter={(val) => `${(val / 1000).toFixed(0)}t`} />
                  <YAxis type="category" dataKey="label" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--secondary))', fontSize: 12, fontWeight: 'bold' }} width={80} />
                  <RechartsTooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.5)' }} />
                  <Bar dataKey="massKg" fill="hsl(35 100% 50%)" radius={[0, 4, 4, 0]}>
                    {stats.byCountry.slice(0, 10).map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Object Class Breakdown */}
        <Card className="border-2 border-border bg-card relative overflow-hidden">
          <CardHeader className="bg-muted/30 border-b border-border">
            <CardTitle className="text-chart-4 uppercase flex items-center gap-2 text-sm">
              <Activity className="w-4 h-4" /> Objects by Class (Count)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 pb-2 pl-0">
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.byObjectClass}
                  layout="vertical"
                  margin={{ top: 5, right: 50, left: 90, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 10 }} tickFormatter={(val: number) => val.toLocaleString()} />
                  <YAxis type="category" dataKey="label" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(280 100% 60%)', fontSize: 11 }} width={100} />
                  <RechartsTooltip
                    formatter={(val: number, name: string) => [val.toLocaleString(), name === 'count' ? 'Objects' : 'Mass (kg)']}
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontFamily: 'monospace' }}
                    labelStyle={{ color: 'hsl(var(--primary))' }}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {stats.byObjectClass.map((_: unknown, index: number) => (
                      <Cell key={`cell-${index}`} fill={COLORS[(index + 2) % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Orbit Types */}
        <OrbitPieChart byOrbit={stats.byOrbit} />

        {/* Top Launch Vehicles by Mass */}
        <Card className="border-2 border-border bg-card relative overflow-hidden lg:col-span-2">
          <CardHeader className="bg-muted/30 border-b border-border">
            <CardTitle className="text-accent uppercase flex items-center gap-2 text-sm">
              <Activity className="w-4 h-4" /> Top Launch Vehicles by Mass to Orbit
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 pb-2 pl-0">
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.byLaunchVehicle.slice(0, 15)}
                  layout="vertical"
                  margin={{ top: 20, right: 60, left: 10, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 10 }} tickFormatter={(val: number) => `${(val / 1000).toFixed(0)}t`} />
                  <YAxis type="category" dataKey="label" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(180 100% 50%)', fontSize: 11 }} width={140} interval={0} />
                  <RechartsTooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.3)' }} />
                  <Bar dataKey="massKg" radius={[0, 4, 4, 0]}>
                    {stats.byLaunchVehicle.slice(0, 15).map((_: unknown, index: number) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
