import {
  useGetConstellationAnalytics,
  getGetConstellationAnalyticsQueryKey,
} from "@workspace/api-client-react";
import { useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  BarChart, Bar
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Globe, Satellite, Zap, Radar, PieChart, BarChart3 } from "lucide-react";

// Standard Bureau UI Colors
const COLORS = [
  'hsl(140 100% 50%)', // Neon Green
  'hsl(180 100% 50%)', // Cyan
  'hsl(35 100% 50%)',  // Amber
  'hsl(280 100% 60%)', // Purple
  'hsl(0 100% 60%)',   // Red
  'hsl(220 100% 70%)', // Light Blue
  'hsl(320 100% 60%)', // Pink
];

// Consistent target profile coloring
const CONSTELLATION_COLORS: Record<string, string> = {
  'Starlink': 'hsl(0 90% 60%)',    // Primary dominant threat (Red)
  'OneWeb': 'hsl(220 100% 65%)',   // Blue
  'Kuiper': 'hsl(35 100% 50%)',    // Amber
  'Qianfan': 'hsl(280 100% 60%)',  // Purple
  'Iridium': 'hsl(140 100% 50%)',  // Neon green
  'Flock': 'hsl(180 100% 50%)',    // Cyan
  'Globalstar': 'hsl(320 100% 60%)',
  'Lemur': 'hsl(60 100% 50%)',     
  'Orbcomm': 'hsl(200 100% 50%)',
  'Gonets': 'hsl(10 100% 50%)',
};

const getStableColor = (name: string, overallNames: string[]) => {
  if (CONSTELLATION_COLORS[name]) return CONSTELLATION_COLORS[name];
  const idx = overallNames.indexOf(name);
  return COLORS[Math.max(0, idx) % COLORS.length];
};

const MetricBox = ({ label, value, color, suffix }: { label: string, value: string | number, color?: string, suffix?: string }) => (
  <div className="border border-border bg-muted/20 rounded p-3 font-mono text-center flex flex-col justify-center">
    <div className="text-[10px] sm:text-[11px] text-muted-foreground uppercase mb-1">{label}</div>
    <div className="text-xl sm:text-2xl font-bold" style={{ color: color || 'hsl(var(--foreground))' }}>
      {typeof value === 'number' ? value.toLocaleString() : value}
      {suffix && <span className="text-sm ml-1 text-muted-foreground">{suffix}</span>}
    </div>
  </div>
);

// Standardized tooltip for all bureau charts
const BureauTooltip = ({ active, payload, label, valueFormatter }: any) => {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  
  const entries = payload.map((p: any) => ({
    name: p.dataKey || p.name,
    color: p.color || p.fill,
    value: row[p.dataKey || p.name] || 0
  })).sort((a: any, b: any) => b.value - a.value);

  return (
    <div className="bg-card border-2 border-primary p-3 shadow-xl font-mono text-sm z-50 min-w-[220px]">
      <p className="text-primary font-bold mb-2 pb-1 border-b border-primary/30 uppercase">
        {label}
      </p>
      <div className="space-y-1 text-card-foreground">
        {entries.map((entry: any, index: number) => {
          if (entry.value === 0) return null;
          return (
            <p key={index} className="flex justify-between items-center gap-4 leading-tight">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: entry.color }} />
                <span className="text-muted-foreground">{entry.name}</span>
              </span>
              <span className="font-bold">
                {valueFormatter ? valueFormatter(entry.value) : entry.value.toLocaleString()}
              </span>
            </p>
          );
        })}
      </div>
    </div>
  );
};

function BreakoutCard({ breakout, quarters, overallNames }: { breakout: any, quarters: string[], overallNames: string[] }) {
  const shellChartData = useMemo(() => {
    return quarters.map((q, i) => {
      const row: any = { quarter: q };
      breakout.shells.forEach((s: any) => { row[s.label] = s.active[i] || 0; });
      return row;
    });
  }, [quarters, breakout.shells]);

  const variantChartData = useMemo(() => {
    return quarters.map((q, i) => {
      const row: any = { quarter: q };
      breakout.variants.forEach((s: any) => { row[s.label] = s.active[i] || 0; });
      return row;
    });
  }, [quarters, breakout.variants]);

  const mainColor = getStableColor(breakout.name, overallNames);

  return (
    <Card className="border-2 border-border bg-card relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-20" />
      <CardHeader className="bg-muted/30 border-b border-border">
        <CardTitle className="uppercase flex items-center gap-2 text-sm" style={{ color: mainColor }}>
          <Satellite className="w-4 h-4" /> {breakout.name} SUB-ANALYSIS
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 pb-4 px-4 sm:px-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pb-6">
          <MetricBox label="Total Launched" value={breakout.totals.launched} />
          <MetricBox label="Currently Active" value={breakout.totals.active} color={mainColor} />
          <MetricBox label="Decayed / Dead" value={breakout.totals.decayed} color="hsl(var(--muted-foreground))" />
          <MetricBox label="Total Mass" value={breakout.totals.massTonnes} suffix="t" color="hsl(35 100% 50%)" />
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-2">
            <h4 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Globe className="w-3.5 h-3.5" /> Active Assets by Orbital Shell
            </h4>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                 <AreaChart data={shellChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                     <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                     <XAxis dataKey="quarter" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                     <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} width={45} />
                     <RechartsTooltip content={<BureauTooltip />} cursor={{ stroke: 'hsl(var(--muted) / 0.5)', strokeWidth: 2 }} />
                     {breakout.shells.map((s: any, i: number) => (
                        <Area key={s.label} type="monotone" dataKey={s.label} stackId="1" fill={COLORS[i % COLORS.length]} stroke={COLORS[i % COLORS.length]} />
                     ))}
                 </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Zap className="w-3.5 h-3.5" /> Hardware Variants Over Time
            </h4>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                 <AreaChart data={variantChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                     <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                     <XAxis dataKey="quarter" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                     <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} width={45} />
                     <RechartsTooltip content={<BureauTooltip />} cursor={{ stroke: 'hsl(var(--muted) / 0.5)', strokeWidth: 2 }} />
                     {breakout.variants.map((s: any, i: number) => (
                        <Area key={s.label} type="monotone" dataKey={s.label} stackId="1" fill={COLORS[(i + 3) % COLORS.length]} stroke={COLORS[(i + 3) % COLORS.length]} />
                     ))}
                 </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[10px] font-mono text-muted-foreground/60 leading-tight">
              <span className="text-amber-400/70">≈</span> Denotes theorized Bureau mass estimates due to unverified public telemetry.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Constellations() {
  const { data, isLoading, isError } = useGetConstellationAnalytics({
    query: { queryKey: getGetConstellationAnalyticsQueryKey(), staleTime: 5 * 60 * 1000 },
  });

  const overallNames = useMemo(() => data?.overall.map(c => c.name) || [], [data]);

  const { overallChartData, shareChartData, cadenceChartData, currentActive } = useMemo(() => {
    if (!data) return { overallChartData: [], shareChartData: [], cadenceChartData: [], currentActive: [] };

    const currentActive = data.overall.map(c => ({
      name: c.name,
      active: c.active[c.active.length - 1] || 0,
    })).sort((a, b) => b.active - a.active);

    const overallChartData = data.quarters.map((q, i) => {
      const row: any = { quarter: q };
      data.overall.forEach(c => {
        row[c.name] = c.active[i] || 0;
      });
      return row;
    });

    const shareChartData = data.quarters.map((q, i) => {
      const row: any = { quarter: q };
      let total = 0;
      data.overall.forEach(c => { total += c.active[i] || 0; });
      data.overall.forEach(c => {
        row[c.name] = total > 0 ? ((c.active[i] || 0) / total) * 100 : 0;
      });
      return row;
    });

    const cadenceChartData = data.launchYears.map((y, i) => {
      const row: any = { year: y };
      data.launchedPerYear.forEach(c => {
        row[c.name] = c.counts[i] || 0;
      });
      return row;
    });

    return { overallChartData, shareChartData, cadenceChartData, currentActive };
  }, [data]);

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center font-mono text-primary text-sm uppercase space-y-4">
        <Radar className="w-8 h-8 animate-spin" />
        <p className="animate-pulse">Synchronizing with orbital tracking network...</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center font-mono text-destructive text-sm uppercase">
        Failed to retrieve constellation telemetry.
      </div>
    );
  }

  return (
    <div className="container max-w-7xl mx-auto py-8 px-4 space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="space-y-2 border-b border-primary/30 pb-4 relative">
        <div className="absolute right-0 top-0 police-beacon">
          <div className="beacon-dot beacon-red"></div>
          <div className="beacon-dot beacon-blue"></div>
        </div>
        <h1 className="text-3xl font-display text-primary uppercase text-glow tracking-wider">
          Constellation Network Analytics
        </h1>
        <p className="text-muted-foreground font-mono text-sm max-w-3xl leading-relaxed">
          MONITORING OF MEGA-CONSTELLATION DEPLOYMENTS, MASS-TO-ORBIT DOMINANCE, AND HARDWARE ATTRITION VECTORS.
        </p>
      </div>

      {/* Overall Active Track */}
      <Card className="border-2 border-border bg-card relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-20" />
        <CardHeader className="bg-muted/30 border-b border-border">
          <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
            <Activity className="w-4 h-4" /> ACTIVE ORBITAL ASSETS — SYSTEM AGGREGATES
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-6 pb-4 px-4 sm:px-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-3 pb-6">
            {currentActive.slice(0, 10).map(c => (
              <MetricBox key={c.name} label={c.name} value={c.active} color={getStableColor(c.name, overallNames)} />
            ))}
          </div>
          
          <div className="h-[450px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={overallChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="quarter" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v} width={45} />
                <RechartsTooltip content={<BureauTooltip />} cursor={{ stroke: 'hsl(var(--muted) / 0.5)', strokeWidth: 2 }} />
                {data.overall.map((c, i) => (
                  <Area key={c.name} type="monotone" dataKey={c.name} stackId="1" fill={getStableColor(c.name, overallNames)} stroke={getStableColor(c.name, overallNames)} strokeWidth={1} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs font-mono text-muted-foreground/60 mt-4 leading-relaxed">
            <span className="text-primary/50">// </span>
            NOTE: Starlink deployments vastly outscale all other networks combined. 
            The cumulative visual displacement on this aggregate chart directly reflects real spatial density parity.
          </p>
        </CardContent>
      </Card>

      {/* Two Column Grid for Market Share and Cadence */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="border-2 border-border bg-card relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-20" />
          <CardHeader className="bg-muted/30 border-b border-border">
            <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
              <PieChart className="w-4 h-4" /> PROPORTIONAL DOMINANCE (MARKET SHARE)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 pb-4 px-4 sm:px-6">
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={shareChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="quarter" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                  <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} width={45} allowDataOverflow tickFormatter={(v) => `${Math.round(v)}%`} />
                  <RechartsTooltip content={<BureauTooltip valueFormatter={(v: number) => `${v.toFixed(1)}%`} />} cursor={{ stroke: 'hsl(var(--muted) / 0.5)', strokeWidth: 2 }} />
                  {data.overall.map((c, i) => (
                    <Area key={c.name} type="monotone" dataKey={c.name} stackId="1" fill={getStableColor(c.name, overallNames)} stroke={getStableColor(c.name, overallNames)} strokeWidth={1} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="border-2 border-border bg-card relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-20" />
          <CardHeader className="bg-muted/30 border-b border-border">
            <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
              <BarChart3 className="w-4 h-4" /> DEPLOYMENT CADENCE BY YEAR
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 pb-4 px-4 sm:px-6">
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={cadenceChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="year" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                  <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} width={45} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                  <RechartsTooltip content={<BureauTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.3)' }} />
                  {data.launchedPerYear.map((c, i) => (
                    <Bar key={c.name} dataKey={c.name} stackId="1" fill={getStableColor(c.name, overallNames)} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Breakouts Title */}
      <div className="pt-6 pb-2 border-b border-border">
        <h2 className="text-xl font-display text-primary uppercase text-glow flex items-center gap-2">
          <Radar className="w-5 h-5" /> PER-CONSTELLATION TARGET PROFILES
        </h2>
      </div>

      {/* Breakouts List */}
      <div className="grid grid-cols-1 gap-8">
        {data.breakouts.slice(0, 6).map((breakout, index) => (
          <BreakoutCard 
            key={breakout.name} 
            breakout={breakout} 
            quarters={data.quarters} 
            overallNames={overallNames} 
          />
        ))}
      </div>
    </div>
  );
}
