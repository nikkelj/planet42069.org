import { useGetSatcatStats } from "@workspace/api-client-react";
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, Legend
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Radar, Activity, Loader2 } from "lucide-react";

const COLORS = [
  'hsl(140 100% 50%)', // primary
  'hsl(180 100% 50%)', // accent
  'hsl(35 100% 50%)',  // secondary
  'hsl(280 100% 60%)', // chart-4
  'hsl(0 100% 60%)',   // destructive
  'hsl(220 100% 70%)',
  'hsl(320 100% 60%)',
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
        {/* Mass by Year - Full Width on large screens if we wanted, but let's keep 2-col layout */}
        <Card className="border-2 border-border bg-card lg:col-span-2 overflow-hidden relative">
          <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-30" />
          <CardHeader className="bg-muted/30 border-b border-border">
            <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
              <Activity className="w-4 h-4" /> Temporal Mass Distribution (Yearly)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 pb-2 pl-0">
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.byYear} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorMassYear" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(180 100% 50%)" stopOpacity={0.8}/>
                      <stop offset="95%" stopColor="hsl(180 100% 50%)" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
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
                    {stats.byCountry.slice(0, 10).map((entry, index) => (
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
                  data={(stats as any).byObjectClass ?? []}
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
                    {((stats as any).byObjectClass ?? []).map((_: any, index: number) => (
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

      </div>
    </div>
  );
}
