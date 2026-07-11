import { useGetSatcatMassCdf, getGetSatcatMassCdfQueryKey } from "@workspace/api-client-react";
import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, BarChart2 } from "lucide-react";

type CDFPoint = { m: number; f: number };
type MassCDFData = {
  aggregate: CDFPoint[];
  byType: Record<string, CDFPoint[]>;
  byNation: Record<string, CDFPoint[]>;
  bySite: Record<string, CDFPoint[]>;
  total: number;
};

type Seg = "all" | "type" | "nation" | "site";

const PALETTE = [
  "#00ff64", "#00d4ff", "#ff8c00", "#ff4040",
  "#a855f7", "#facc15", "#f472b6", "#94a3b8",
];

const TYPE_LABELS: Record<string, string> = {
  P: "Payload",
  R: "Rocket Body",
  D: "Debris",
  C: "Component",
};

function massFmt(kg: number): string {
  if (kg >= 100000) return `${(kg / 1000).toFixed(0)}t`;
  if (kg >= 1000)   return `${(kg / 1000).toFixed(1)}t`;
  if (kg >= 1)      return `${kg.toFixed(0)}kg`;
  if (kg >= 0.001)  return `${(kg * 1000).toFixed(0)}g`;
  return `${kg}`;
}

// Ticks in log10(mass) space, with display values
const LOG_TICKS = [-2, -1, 0, 1, 2, 3, 4, 5];
const LOG_TICK_LABELS: Record<string, string> = {
  "-2": "10g", "-1": "100g", "0": "1kg", "1": "10kg",
  "2":  "100kg", "3": "1t", "4": "10t", "5": "100t",
};

function toChartData(
  series: Record<string, CDFPoint[]>,
): { logM: number; [key: string]: number }[] {
  // Merge all series into a single sorted array by logM
  const allLogM = new Set<number>();
  for (const pts of Object.values(series)) {
    for (const p of pts) allLogM.add(Math.round(Math.log10(p.m) * 100) / 100);
  }
  const sorted = [...allLogM].sort((a, b) => a - b);

  // For each series, build a lookup from logM → fraction (stepwise)
  const lookups: Record<string, { logM: number; f: number }[]> = {};
  for (const [key, pts] of Object.entries(series)) {
    lookups[key] = pts
      .map((p) => ({ logM: Math.log10(p.m), f: p.f }))
      .sort((a, b) => a.logM - b.logM);
  }

  function interpolate(arr: { logM: number; f: number }[], x: number): number {
    if (arr.length === 0) return 0;
    if (x <= arr[0].logM) return arr[0].f;
    if (x >= arr[arr.length - 1].logM) return arr[arr.length - 1].f;
    // stepwise (CDF is a step function)
    for (let i = 1; i < arr.length; i++) {
      if (x < arr[i].logM) return arr[i - 1].f;
    }
    return arr[arr.length - 1].f;
  }

  return sorted.map((logM) => {
    const row: { logM: number; [key: string]: number } = { logM };
    for (const key of Object.keys(series)) {
      row[key] = interpolate(lookups[key], logM);
    }
    return row;
  });
}

const pctFmt = (v: number) => `${(v * 100).toFixed(0)}%`;

export function MassCDFChart() {
  const [seg, setSeg] = useState<Seg>("all");

  const { data, isLoading, isError } = useGetSatcatMassCdf({
    query: { queryKey: getGetSatcatMassCdfQueryKey(), staleTime: 30 * 60 * 1000 },
  });

  const { series, chartData } = useMemo(() => {
    if (!data) return { series: {}, chartData: [] };
    let raw: Record<string, CDFPoint[]>;
    if (seg === "all") {
      raw = { "ALL OBJECTS": data.aggregate };
    } else if (seg === "type") {
      raw = {};
      for (const [k, v] of Object.entries(data.byType)) {
        raw[TYPE_LABELS[k] ?? k] = v;
      }
    } else if (seg === "nation") {
      raw = data.byNation;
    } else {
      raw = data.bySite;
    }
    return { series: raw, chartData: toChartData(raw) };
  }, [data, seg]);

  const keys = Object.keys(series);

  const SEGS: { key: Seg; label: string }[] = [
    { key: "all",    label: "Aggregate" },
    { key: "type",   label: "By Type"   },
    { key: "nation", label: "By Nation" },
    { key: "site",   label: "By Site"   },
  ];

  return (
    <Card className="border-2 border-border bg-card relative overflow-hidden lg:col-span-2">
      <CardHeader className="bg-muted/30 border-b border-border">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
            <BarChart2 className="w-4 h-4" />
            Object Mass Distribution — Cumulative
            {data && (
              <span className="ml-2 text-muted-foreground font-normal text-xs normal-case">
                {data.total.toLocaleString()} objects with known mass
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-1 font-mono text-xs border border-border rounded overflow-hidden">
            {SEGS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSeg(key)}
                className={`px-3 py-1.5 uppercase transition-colors ${
                  seg === key
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4 pb-2 px-2">
        {isLoading && (
          <div className="flex flex-col items-center justify-center gap-4 text-primary" style={{ height: 380 }}>
            <Loader2 className="w-8 h-8 animate-spin" />
            <span className="text-xs font-mono uppercase animate-pulse tracking-widest">
              Computing mass distributions...
            </span>
          </div>
        )}
        {isError && (
          <div className="flex items-center justify-center text-destructive font-mono text-sm" style={{ height: 380 }}>
            UPLINK FAILED — MASS DATA UNAVAILABLE
          </div>
        )}
        {data && (
          <>
            <ResponsiveContainer width="100%" height={360}>
              <LineChart data={chartData} margin={{ top: 8, right: 24, left: 8, bottom: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,255,100,0.06)" />
                <XAxis
                  dataKey="logM"
                  type="number"
                  domain={[-2, 5]}
                  ticks={LOG_TICKS}
                  tickFormatter={(v) => LOG_TICK_LABELS[String(Math.round(v))] ?? ""}
                  stroke="rgba(0,255,100,0.30)"
                  tick={{ fill: "rgba(0,255,100,0.55)", fontSize: 10, fontFamily: '"Chakra Petch",monospace' }}
                  label={{
                    value: "MASS",
                    position: "insideBottom",
                    offset: -14,
                    fill: "rgba(0,255,100,0.35)",
                    fontSize: 10,
                    fontFamily: '"Chakra Petch",monospace',
                  }}
                />
                <YAxis
                  tickFormatter={pctFmt}
                  domain={[0, 1]}
                  ticks={[0, 0.25, 0.5, 0.75, 1.0]}
                  stroke="rgba(0,255,100,0.30)"
                  tick={{ fill: "rgba(0,255,100,0.55)", fontSize: 10, fontFamily: '"Chakra Petch",monospace' }}
                  label={{
                    value: "CUMULATIVE FRACTION",
                    angle: -90,
                    position: "insideLeft",
                    offset: 16,
                    fill: "rgba(0,255,100,0.35)",
                    fontSize: 10,
                    fontFamily: '"Chakra Petch",monospace',
                  }}
                />
                <Tooltip
                  contentStyle={{
                    background: "#050d0d",
                    border: "1px solid rgba(0,255,100,0.25)",
                    borderRadius: 4,
                    fontFamily: '"Chakra Petch",monospace',
                    fontSize: 11,
                  }}
                  labelFormatter={(v: number) => `Mass ≈ ${massFmt(Math.pow(10, v))}`}
                  formatter={(val: number, name: string) => [`${(val * 100).toFixed(1)}%`, name]}
                  itemStyle={{ color: "rgba(0,255,100,0.85)" }}
                  labelStyle={{ color: "rgba(0,255,100,0.55)" }}
                />
                <Legend
                  wrapperStyle={{
                    fontSize: 10,
                    fontFamily: '"Chakra Petch",monospace',
                    color: "rgba(180,220,180,0.70)",
                    paddingTop: 8,
                  }}
                />
                {keys.map((key, idx) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={PALETTE[idx % PALETTE.length]}
                    strokeWidth={seg === "all" ? 2 : 1.5}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <p className="text-[10px] font-mono text-muted-foreground/45 leading-relaxed px-3 pb-2">
              <span className="text-primary/35">// </span>
              CDF: read as "X% of objects in this group have mass ≤ Y." Only objects with known mass are included.
              Debris skews light; rocket bodies cluster at characteristic engine masses; payloads span orders of magnitude.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
