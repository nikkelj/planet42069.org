import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { Link } from "wouter";

const COLORS = [
  'hsl(140 100% 50%)',
  'hsl(180 100% 50%)',
  'hsl(35 100% 50%)',
  'hsl(280 100% 60%)',
  'hsl(0 100% 60%)',
  'hsl(220 100% 70%)',
  'hsl(320 100% 60%)',
];

const ORBITER_COLOR = "hsl(0 80% 55%)";
const ORBITER_COLOR_THEORIZED = "hsl(25 90% 55%)";

type VehicleRow = { label: string; massKg: number; count: number; payloadCount: number };

export type ShuttleAudit = {
  gcat: { totalKg: number; orbiterKg: number; cargoKg: number; flights: number; cargoObjects: number };
  theorized: { orbiterDryKg: number; deliveredKg: number };
  perOrbiter: {
    ov: string;
    name: string;
    publishedDryKg: number;
    flights: number;
    gcatMassKg: number;
    theorizedDryTotalKg: number;
  }[];
  falcon9: { totalKg: number; payloadCount: number };
};

export function useShuttleAudit() {
  return useQuery<ShuttleAudit>({
    queryKey: ["shuttle-audit"],
    queryFn: () =>
      fetch("/api/satcat/shuttle-audit").then((r) => {
        if (!r.ok) throw new Error(`Shuttle audit request failed: ${r.status}`);
        return r.json();
      }),
  });
}

type ChartRow = {
  label: string;
  delivered: number;
  orbiter: number;
  derived: boolean;
  colorIdx: number;
};

function fmtT(kg: number) {
  return `${(kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}t`;
}

function SegTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartRow }[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="border border-border bg-card p-2 font-mono text-[11px] space-y-1">
      <div className="text-accent font-bold uppercase">{row.label}</div>
      {row.orbiter > 0 && (
        <>
          <div className="text-foreground/90">
            <span
              className="inline-block w-2 h-2 mr-1"
              style={{ background: row.derived ? ORBITER_COLOR_THEORIZED : ORBITER_COLOR }}
            />
            {row.derived ? "Theorized orbiter dry mass" : "Orbiter riding along (GCAT)"}: {fmtT(row.orbiter)}
          </div>
          <div className="text-foreground/90">
            <span className="inline-block w-2 h-2 mr-1" style={{ background: COLORS[row.colorIdx % COLORS.length] }} />
            {row.derived ? "Theorized delivered (crew, cargo, consumables)" : "Catalogued deployed cargo"}: {fmtT(row.delivered)}
          </div>
          <div className="text-muted-foreground border-t border-border pt-1">Total: {fmtT(row.orbiter + row.delivered)}</div>
          {row.derived && (
            <div className="text-orange-400/80 uppercase text-[9px] tracking-wider">Derived — see briefing, Case #DRYMASS-0090</div>
          )}
        </>
      )}
      {row.orbiter === 0 && <div className="text-foreground/90">Mass to orbit: {fmtT(row.delivered)}</div>}
    </div>
  );
}

export function VehicleMassChart({ byLaunchVehicle }: { byLaunchVehicle: VehicleRow[] }) {
  const { data: audit } = useShuttleAudit();

  const top = byLaunchVehicle.slice(0, 15);
  const rows: ChartRow[] = [];
  top.forEach((v, i) => {
    if (audit && v.label === "Space Shuttle") {
      rows.push({
        label: "Space Shuttle",
        delivered: audit.gcat.cargoKg,
        orbiter: audit.gcat.orbiterKg,
        derived: false,
        colorIdx: i,
      });
      rows.push({
        label: "Shuttle (theorized)",
        delivered: audit.theorized.deliveredKg,
        orbiter: audit.theorized.orbiterDryKg,
        derived: true,
        colorIdx: i,
      });
    } else {
      rows.push({ label: v.label, delivered: v.massKg, orbiter: 0, derived: false, colorIdx: i });
    }
  });

  return (
    <Card className="border-2 border-border bg-card relative overflow-hidden lg:col-span-2">
      <CardHeader className="bg-muted/30 border-b border-border">
        <CardTitle className="text-accent uppercase flex items-center gap-2 text-sm">
          <Activity className="w-4 h-4" /> Top Launch Vehicles by Mass to Orbit
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-6 pb-2 pl-0">
        <div className="h-[380px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 20, right: 60, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
              <XAxis
                type="number"
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 10 }}
                tickFormatter={(val: number) => `${(val / 1000).toFixed(0)}t`}
              />
              <YAxis
                type="category"
                dataKey="label"
                stroke="hsl(var(--muted-foreground))"
                tick={{ fill: 'hsl(180 100% 50%)', fontSize: 11 }}
                width={140}
                interval={0}
              />
              <RechartsTooltip content={<SegTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.3)' }} />
              <Bar dataKey="delivered" stackId="mass" radius={[0, 0, 0, 0]}>
                {rows.map((r, index) => (
                  <Cell
                    key={`d-${index}`}
                    fill={COLORS[r.colorIdx % COLORS.length]}
                    fillOpacity={r.derived ? 0.55 : 1}
                  />
                ))}
              </Bar>
              <Bar dataKey="orbiter" stackId="mass" radius={[0, 4, 4, 0]}>
                {rows.map((r, index) => (
                  <Cell
                    key={`o-${index}`}
                    fill={r.derived ? ORBITER_COLOR_THEORIZED : ORBITER_COLOR}
                    fillOpacity={r.derived ? 0.55 : 0.9}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {audit && (
          <div className="px-6 pb-3 pt-1 font-mono text-[10px] text-muted-foreground uppercase tracking-wider flex flex-wrap gap-x-4 gap-y-1 items-center">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2" style={{ background: ORBITER_COLOR }} /> Orbiter catalogued as payload (GCAT actual)
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2" style={{ background: ORBITER_COLOR_THEORIZED, opacity: 0.7 }} /> Theorized orbiter dry mass
            </span>
            <span className="text-muted-foreground/60 normal-case">
              98% of the Shuttle bar is the Shuttle itself —{" "}
              <Link href="/briefing" className="text-accent underline underline-offset-2 hover:text-primary">
                Case #DRYMASS-0090
              </Link>
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
