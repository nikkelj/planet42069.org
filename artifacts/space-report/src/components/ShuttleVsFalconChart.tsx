import {
  useGetSatcatShuttleVsFalconRate,
  getGetSatcatShuttleVsFalconRateQueryKey,
} from "@workspace/api-client-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, ReferenceDot, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GitCompareArrows } from "lucide-react";

const SHUTTLE_COLOR = "hsl(35 100% 55%)";
const FALCON_COLOR = "hsl(140 100% 50%)";

export function ShuttleVsFalconChart({ compact = false }: { compact?: boolean }) {
  const { data, isLoading } = useGetSatcatShuttleVsFalconRate({
    query: { queryKey: getGetSatcatShuttleVsFalconRateQueryKey(), staleTime: 5 * 60 * 1000 },
  });

  if (isLoading || !data) {
    return (
      <div
        className={
          compact
            ? "flex items-center justify-center h-[260px] text-muted-foreground font-mono text-xs animate-pulse uppercase"
            : "flex items-center justify-center h-[420px] text-muted-foreground font-mono text-sm animate-pulse uppercase lg:col-span-2"
        }
      >
        Aligning program epochs...
      </div>
    );
  }

  const { rows, events } = data;

  const eventsAt = (programYear: number) =>
    events.filter((e) => e.programYear === programYear);

  const valueFor = (e: (typeof events)[number]) => {
    const row = rows.find((r) => r.programYear === e.programYear);
    if (!row) return null;
    return e.program === "shuttle" ? row.shuttleCount : row.falconCount;
  };

  const CadenceTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const row = payload[0]?.payload as (typeof rows)[number] | undefined;
    if (!row) return null;
    const evts = eventsAt(row.programYear);
    return (
      <div className="bg-card border-2 border-primary p-3 shadow-xl font-mono text-xs z-50 max-w-[320px]">
        <p className="text-primary font-bold mb-2 pb-1 border-b border-primary/30 uppercase">
          Program Year {row.programYear}
        </p>
        <div className="space-y-1 text-card-foreground">
          {row.shuttleCount != null && (
            <p>
              <span style={{ color: SHUTTLE_COLOR }}>■</span>{" "}
              <span className="text-muted-foreground">Shuttle ({row.shuttleYear}):</span>{" "}
              {row.shuttleCount} launches
            </p>
          )}
          {row.falconCount != null && (
            <p>
              <span style={{ color: FALCON_COLOR }}>■</span>{" "}
              <span className="text-muted-foreground">Falcon 9 ({row.falconYear}):</span>{" "}
              {row.falconCount} launches
            </p>
          )}
        </div>
        {evts.length > 0 && (
          <div className="mt-2 pt-2 border-t border-primary/20 space-y-2">
            {evts.map((e) => (
              <div key={`${e.program}-${e.label}`}>
                <p
                  className="font-bold uppercase tracking-wider"
                  style={{ color: e.program === "shuttle" ? SHUTTLE_COLOR : FALCON_COLOR }}
                >
                  ◆ {e.label} ({e.calendarYear})
                </p>
                <p className="text-muted-foreground leading-snug normal-case">{e.detail}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const chart = (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 15, right: 25, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="programYear"
                type="number"
                domain={[1, rows.length]}
                tickCount={Math.min(rows.length, 16)}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 10 }}
                label={{ value: "YEARS SINCE FIRST FLIGHT", position: "insideBottom", offset: -2, fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 10 }}
                allowDecimals={false}
                label={{ value: "LAUNCHES / YR", angle: -90, position: "insideLeft", fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              />
              <RechartsTooltip content={<CadenceTooltip />} />
              <Legend
                formatter={(value: string) => (
                  <span className="font-mono text-xs uppercase text-muted-foreground">{value}</span>
                )}
              />
              <Line
                name={`Space Shuttle (${data.shuttleTotal} launches)`}
                type="monotone"
                dataKey="shuttleCount"
                stroke={SHUTTLE_COLOR}
                strokeWidth={2}
                dot={{ r: 2, fill: SHUTTLE_COLOR }}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                name={`Falcon 9 (${data.falconTotal} launches)`}
                type="monotone"
                dataKey="falconCount"
                stroke={FALCON_COLOR}
                strokeWidth={2}
                dot={{ r: 2, fill: FALCON_COLOR }}
                connectNulls={false}
                isAnimationActive={false}
              />
              {events.map((e) => {
                const v = valueFor(e);
                if (v == null) return null;
                return (
                  <ReferenceDot
                    key={`${e.program}-${e.label}`}
                    x={e.programYear}
                    y={v}
                    r={5}
                    fill="transparent"
                    stroke={e.program === "shuttle" ? SHUTTLE_COLOR : FALCON_COLOR}
                    strokeWidth={2}
                  />
                );
              })}
      </LineChart>
    </ResponsiveContainer>
  );

  if (compact) {
    return (
      <div className="border border-orange-400/20 bg-background/40 p-3" data-testid="chart-shuttle-vs-falcon-compact">
        <p className="text-[10px] font-mono uppercase tracking-wider text-orange-400/60 mb-2">
          Exhibit A · Launch attempts per program year · Year 1 = first flight ({data.shuttleFirstYear} / {data.falconFirstYear})
        </p>
        <div className="h-[260px] w-full">{chart}</div>
      </div>
    );
  }

  return (
    <Card className="border-2 border-border bg-card lg:col-span-2 overflow-hidden relative" data-testid="chart-shuttle-vs-falcon">
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none border-scanline opacity-30" />
      <CardHeader className="bg-muted/30 border-b border-border">
        <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
          <GitCompareArrows className="w-4 h-4" /> Case Study: Where Did the Exponential Go? — Shuttle vs Falcon 9 Cadence
        </CardTitle>
        <p className="text-muted-foreground text-xs font-mono uppercase tracking-wider">
          Launch attempts per program year · Year 1 = first flight ({data.shuttleFirstYear} / {data.falconFirstYear}) · Source: GCAT launch log
        </p>
      </CardHeader>
      <CardContent className="pt-6 pb-4">
        <div className="h-[380px] w-full">{chart}</div>

        {/* Event ledger */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 font-mono text-[11px]">
          {(["shuttle", "falcon9"] as const).map((program) => (
            <div key={program} className="border border-border/60 p-3 space-y-1.5">
              <p
                className="font-bold uppercase tracking-widest text-[10px] border-b border-border/60 pb-1.5"
                style={{ color: program === "shuttle" ? SHUTTLE_COLOR : FALCON_COLOR }}
              >
                {program === "shuttle" ? "◆ Shuttle — Docket of Events" : "◆ Falcon 9 — Docket of Events"}
              </p>
              {events
                .filter((e) => e.program === program)
                .map((e) => (
                  <p key={e.label} className="text-muted-foreground leading-snug">
                    <span className="text-card-foreground font-bold">
                      Y{e.programYear} · {e.calendarYear} — {e.label}:
                    </span>{" "}
                    {e.detail}
                  </p>
                ))}
            </div>
          ))}
        </div>

        <p className="text-xs font-mono text-muted-foreground/60 leading-relaxed mt-4 px-1">
          <span className="text-primary/50">// FINDING:</span>{" "}
          Both programs left the pad on the same trajectory — cadence roughly doubling every two years. The curves separate at program
          year 6. The difference is not engineering ambition; it is what happens after a failure. A crewed vehicle that fails stands
          down for years. An uncrewed vehicle that fails stands down for months. Compounding does not forgive multi-year pauses.
          The full complaint is filed in the{" "}
          <a href="/#cadence-0135" className="text-accent underline underline-offset-2 hover:text-primary transition-colors">
            Briefing docket, Case #CADENCE-0135
          </a>.
        </p>
      </CardContent>
    </Card>
  );
}
