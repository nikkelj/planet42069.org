import { useGetSatcatStats } from "@workspace/api-client-react";
import { useState } from "react";
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  BarChart, Bar, Cell, ReferenceArea, ReferenceLine, Label
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Radar, Activity, Loader2, TrendingUp, Zap } from "lucide-react";
import { OrbitalMap } from "@/components/OrbitalMap";

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

export default function Analytics() {
  const { data: stats, isLoading, isError } = useGetSatcatStats();
  const [chartView, setChartView] = useState<'all' | 'recent'>('all');

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
        {/* Orbital Distribution Map */}
        <OrbitalMap />

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
                  margin={{ top: 5, right: 60, left: 130, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 10 }} tickFormatter={(val: number) => `${(val / 1000).toFixed(0)}t`} />
                  <YAxis type="category" dataKey="label" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(180 100% 50%)', fontSize: 11 }} width={140} />
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
