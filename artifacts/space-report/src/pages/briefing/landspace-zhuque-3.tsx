import { useEffect } from "react";
import { Link } from "wouter";
import { ChevronLeft, Scale, Rocket, FileWarning, ExternalLink } from "lucide-react";
import { Area, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart, ReferenceLine, Label, Legend } from "recharts";
import zhuqueLandingImage from "@assets/image_1787153683827.png";

const PAGE_TITLE = "Zhuque-3 Has Legs. The Paperwork Begins. | Other Jonathan's Space Report";
const PAGE_DESCRIPTION =
  "Landspace reached orbit and landed Zhuque-3 on flight two. The Orbital Bureau models 15–18 tonnes of routine reusable LEO upmass by 2028.";

const chartData = [
  { year: 2026, officialGroundReturn: 12.5, f9Mass: 10.45, f9SourceYear: 2010 },
  { year: 2027, forecastCenter: 14.0, forecastRange: [12.8, 15.0] },
  { year: 2028, forecastCenter: 16.5, forecastRange: [15.0, 18.0] },
  { year: 2029, forecastCenter: 18.3, forecastRange: [16.5, 19.2], f9Mass: 13.15, f9SourceYear: 2013 },
  { year: 2030, forecastCenter: 19.4, forecastRange: [17.5, 20.0] },
  { year: 2031, forecastCenter: 20.2, forecastRange: [18.0, 20.7] },
  { year: 2032, forecastCenter: 21.0, forecastRange: [18.5, 21.3], f9Mass: 22.8, f9SourceYear: 2016 },
];

// GCAT launch attempts in Falcon 9's first seven program years (2010–2016).
// This deliberately preserves the real early-life pauses instead of pretending
// every reusable program gets a smooth cadence ramp.
const F9_EARLY_LIFECYCLE_FLIGHTS = [2, 0, 2, 3, 6, 7, 8] as const;

let cumulativeUpmass = 0;
const integratedUpmassData = chartData.map((row, index) => {
  const perFlightUpmass = row.forecastCenter ?? row.officialGroundReturn ?? 0;
  const f9AnalogFlights = F9_EARLY_LIFECYCLE_FLIGHTS[index] ?? 0;
  const annualUpmass = f9AnalogFlights * perFlightUpmass;
  cumulativeUpmass += annualUpmass;

  return {
    ...row,
    perFlightUpmass,
    f9AnalogFlights,
    f9AnalogYear: 2010 + index,
    annualUpmass,
    cumulativeUpmass,
  };
});

function useBriefingMetadata(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    const previousTitle = document.title;
    const selectors = [
      ["meta[name='description']", PAGE_DESCRIPTION],
      ["meta[property='og:title']", PAGE_TITLE],
      ["meta[property='og:description']", PAGE_DESCRIPTION],
      ["meta[name='twitter:title']", PAGE_TITLE],
      ["meta[name='twitter:description']", PAGE_DESCRIPTION],
    ] as const;
    const previousContent = selectors.map(([selector]) => {
      const element = document.querySelector<HTMLMetaElement>(selector);
      return [element, element?.content] as const;
    });

    document.title = PAGE_TITLE;
    selectors.forEach(([selector, content]) => {
      const element = document.querySelector<HTMLMetaElement>(selector);
      if (element) element.content = content;
    });

    return () => {
      document.title = previousTitle;
      previousContent.forEach(([element, content]) => {
        if (element && content !== undefined) element.content = content;
      });
    };
  }, [enabled]);
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-card/95 border border-border p-3 font-mono text-xs shadow-xl backdrop-blur-sm">
        <p className="text-primary font-bold mb-2 uppercase border-b border-primary/20 pb-1">{label}</p>
        <div className="space-y-1">
          {payload.map((p: any, i: number) => {
            if (p.dataKey === "forecastRange") {
              return (
                <div key={i} className="flex justify-between gap-4 text-purple-300">
                  <span>Bureau estimate range:</span>
                  <span>{p.value[0].toFixed(1)} – {p.value[1].toFixed(1)} t</span>
                </div>
              );
            }
            if (p.dataKey === "forecastCenter") {
              return (
                <div key={i} className="flex justify-between gap-4 text-purple-400 font-bold">
                  <span>Bureau central estimate:</span>
                  <span>{p.value.toFixed(1)} t</span>
                </div>
              );
            }
            if (p.dataKey === "officialGroundReturn") {
              return (
                <div key={i} className="flex justify-between gap-4 text-primary mt-2 pt-1 border-t border-border/50">
                  <span>Published ground-return ceiling:</span>
                  <span>{p.value.toFixed(1)} t</span>
                </div>
              );
            }
            if (p.dataKey === "f9Mass" && p.value !== undefined) {
              return (
                <div key={i} className="flex justify-between gap-4 text-muted-foreground mt-2 pt-1 border-t border-border/50">
                  <span>Falcon 9 actual (same lifecycle age):</span>
                  <span>{p.value.toFixed(2)} t</span>
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
    );
  }
  return null;
};

const IntegratedUpmassTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload as (typeof integratedUpmassData)[number] | undefined;
  if (!row) return null;

  return (
    <div className="bg-card/95 border border-border p-3 font-mono text-xs shadow-xl backdrop-blur-sm">
      <p className="text-primary font-bold mb-2 uppercase border-b border-primary/20 pb-1">
        {row.year} scenario · F9 program year {row.year - 2025}
      </p>
      <div className="space-y-1 text-muted-foreground">
        <div className="flex justify-between gap-4">
          <span>F9 analogue ({row.f9AnalogYear}):</span>
          <span>{row.f9AnalogFlights} launches</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>Bureau upmass / flight:</span>
          <span>{row.perFlightUpmass.toFixed(1)} t</span>
        </div>
        <div className="flex justify-between gap-4 text-purple-300 border-t border-border/50 mt-2 pt-1">
          <span>Integrated annual upmass:</span>
          <span>{row.annualUpmass.toFixed(1)} t</span>
        </div>
        <div className="flex justify-between gap-4 text-primary font-bold">
          <span>Cumulative scenario:</span>
          <span>{row.cumulativeUpmass.toFixed(1)} t</span>
        </div>
      </div>
    </div>
  );
};

export default function LandspaceZhuque3({ embedded = false }: { embedded?: boolean }) {
  useBriefingMetadata(!embedded);

  return (
    <article
      id={embedded ? "zq3-0002" : undefined}
      className="space-y-8 animate-in fade-in duration-700 max-w-4xl mx-auto scroll-mt-24"
      data-testid={embedded ? "briefing-zq3-0002" : "page-landspace-zhuque-3"}
    >
      {/* HEADER NAV */}
      {!embedded && (
        <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider mb-8">
          <Link href="/#zq3-0002" className="hover:text-primary transition-colors flex items-center gap-1" data-testid="link-briefing-docket">
            <ChevronLeft className="w-3 h-3" />
            Docket
          </Link>
          <span>/</span>
          <span className="text-purple-400/80">Case #ZQ3-0002</span>
        </div>
      )}

      {/* BRIEFING HEADER */}
      <div className="border-2 border-purple-900/50 bg-purple-950/10 p-6 relative overflow-hidden box-glow-purple">
        <div className="absolute top-0 left-0 w-full h-1 bg-purple-500/50 animate-pulse" />
        <div className="flex items-start gap-4">
          <Rocket className="w-8 h-8 text-purple-400 shrink-0 mt-1" />
          <div className="space-y-3 w-full">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-purple-500/20 pb-3">
              <h1 className="text-2xl md:text-3xl font-bold text-purple-300 uppercase tracking-wide text-glow">
                Zhuque-3 Has Legs. The Paperwork Begins.
              </h1>
              <div className="text-right">
                <div className="text-purple-400/80 text-[10px] uppercase tracking-wider">Filed: 2026-08-19</div>
                <div className="text-purple-400/80 text-[10px] uppercase tracking-wider">Status: R-3 FORM PENDING</div>
              </div>
            </div>
            
            <p className="text-base font-sans leading-relaxed text-foreground/90">
              On <span className="text-purple-300 font-bold">2026-08-18 23:35 UTC</span>, Landspace's Zhuque-3 Y2 lifted off, reached orbit, and approximately eight minutes later, successfully landed its first stage on deployable legs at a downrange recovery pad.
            </p>
            <p className="text-sm font-sans leading-relaxed text-muted-foreground">
              This makes Landspace only the third organization in history—following SpaceX and Blue Origin—to land an orbital-class booster on legs. The Bureau extends its formal, deadpan congratulations. We also politely remind Landspace that Form R-3, <span className="italic">Reusable Hardware With Legs</span>, must be filed in triplicate before any reflight attempts. 
            </p>
          </div>
        </div>
      </div>

      {/* EVIDENCE & ATTRIBUTION */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <figure className="border border-purple-900/40 bg-black/40 p-2 relative group">
          <img 
            src={zhuqueLandingImage} 
            alt="Zhuque-3 Y2 first stage booster descending towards a desert landing pad with its legs deployed" 
            className="w-full h-auto object-cover border border-purple-900/20 opacity-90 group-hover:opacity-100 transition-opacity"
            data-testid="img-zhuque-landing"
          />
          <figcaption className="text-[10px] text-purple-400/60 uppercase tracking-wider pt-3 pb-1 text-center font-mono border-t border-purple-900/40 mt-2">
            Exhibit A · ZQ-3 Y2 Downrange Landing
          </figcaption>
        </figure>

        <div className="space-y-4 font-mono text-xs">
          <div className="border border-border bg-card/40 p-4 space-y-3">
            <h3 className="text-primary uppercase tracking-widest text-[11px] border-b border-border pb-2 mb-2 flex items-center gap-2">
              <FileWarning className="w-3 h-3" />
              Source Material
            </h3>
            <a 
              href="https://x.com/cnspaceflight/status/2090096664363311271"
              target="_blank"
              rel="noopener noreferrer"
              className="block p-2 border border-primary/20 hover:border-primary/50 hover:bg-primary/5 transition-colors group"
              data-testid="link-x-source"
            >
              <div className="text-primary/70 mb-1 flex justify-between items-center">
                <span>Visual Confirmation (X)</span>
                <ExternalLink className="w-3 h-3 opacity-50 group-hover:opacity-100" />
              </div>
              <div className="text-muted-foreground truncate">@cnspaceflight / Mission recovery footage</div>
            </a>
            <a 
              href="https://spacenews.com/chinas-landspace-recovers-booster-with-second-orbital-launch-of-zhuque-3-rocket/"
              target="_blank"
              rel="noopener noreferrer"
              className="block p-2 border border-primary/20 hover:border-primary/50 hover:bg-primary/5 transition-colors group"
              data-testid="link-spacenews-source"
            >
              <div className="text-primary/70 mb-1 flex justify-between items-center">
                <span>Mission Dossier (SpaceNews)</span>
                <ExternalLink className="w-3 h-3 opacity-50 group-hover:opacity-100" />
              </div>
              <div className="text-muted-foreground truncate">Landspace recovers booster with second launch...</div>
            </a>
          </div>

          <div className="border border-border bg-card/40 p-4 space-y-3">
            <h3 className="text-primary uppercase tracking-widest text-[11px] border-b border-border pb-2 mb-2 flex items-center gap-2">
              <Scale className="w-3 h-3" />
              Published Ceilings
            </h3>
            <ul className="space-y-2 text-muted-foreground">
              <li className="flex justify-between border-b border-border/50 pb-1">
                <span>Return to Launch Site:</span>
                <span className="text-foreground">12.5 t</span>
              </li>
              <li className="flex justify-between border-b border-border/50 pb-1">
                <span>Downrange Recovery:</span>
                <span className="text-foreground">18.3 t</span>
              </li>
              <li className="flex justify-between">
                <span>Fully Expendable:</span>
                <span className="text-foreground">21.3 t <span className="text-[9px] opacity-60">(SpaceNews rounds to 21t)</span></span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* ANALYSIS CHART */}
      <div className="border border-purple-900/50 bg-black/40 p-5 font-mono text-xs relative">
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-purple-500/60 via-purple-500/20 to-transparent" />
        
        <div className="mb-6 space-y-2">
          <h2 className="text-purple-300 font-bold uppercase tracking-widest text-sm flex items-center gap-2">
            <Rocket className="w-4 h-4" />
            Upmass Projection Model
          </h2>
          <p className="text-muted-foreground normal-case leading-relaxed">
            Purple is the Bureau's estimate for routine reusable upmass, mapped against the Falcon 9 historical improvement curve.
            The cyan marker and horizontal references are published Zhuque-3 capabilities, not forecasts. Falcon 9 is provided strictly for shape and ramp-rate comparison—it is not proof of Landspace's outcome.
            The estimate is capped at the hardware's published 21.3 t expendable ceiling.
          </p>
          <div className="inline-block bg-amber-950/30 text-amber-500/80 px-2 py-1 border border-amber-900/50 mt-2 text-[10px] uppercase tracking-wider">
            Disclaimer: Orbital Bureau Estimate. Not Official Guidance.
          </div>
        </div>

        <div
          className="h-[400px] w-full"
          data-testid="chart-upmass-projection"
          role="img"
          aria-label="Published Zhuque-3 capability references: 12.5 tonnes with return-site recovery, 18.3 tonnes with downrange recovery, and a 21.3 tonne expendable ceiling. Separately, an Orbital Bureau forecast shows a 15 to 18 tonne routine-reusable range in 2028, compared with Falcon 9's historical six-year payload-capacity ramp."
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis 
                dataKey="year"
                stroke="hsl(var(--muted-foreground))" 
                fontSize={10}
                tickMargin={10}
                tick={{ fill: "hsl(var(--muted-foreground))" }}
                padding={{ left: 20, right: 20 }}
              />
              <YAxis 
                stroke="hsl(var(--muted-foreground))"
                fontSize={10}
                tickFormatter={(value) => `${value} t`}
                domain={[0, 25]}
                tick={{ fill: "hsl(var(--muted-foreground))" }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
              
              <ReferenceLine y={21.3} stroke="hsl(var(--destructive)/0.5)" strokeDasharray="3 3">
                <Label value="Published expendable ceiling · 21.3 t" position="insideTopLeft" fill="hsl(var(--destructive))" fontSize={10} />
              </ReferenceLine>
              <ReferenceLine y={18.3} stroke="hsl(var(--primary)/0.55)" strokeDasharray="3 3">
                <Label value="Published downrange-recovery ceiling · 18.3 t" position="insideTopLeft" fill="hsl(var(--primary))" fontSize={10} />
              </ReferenceLine>

              {/* Bureau estimate — deliberately separate from the published references above. */}
              <Area 
                type="monotone" 
                dataKey="forecastRange" 
                fill="hsl(270 50% 50% / 0.15)" 
                stroke="none" 
                name="Bureau estimate range"
                legendType="none"
              />
              
              <Line 
                type="monotone" 
                dataKey="forecastCenter" 
                stroke="hsl(270 60% 60%)" 
                strokeWidth={3}
                dot={{ r: 4, fill: "hsl(270 60% 60%)", strokeWidth: 0 }}
                activeDot={{ r: 6, fill: "hsl(270 80% 80%)", strokeWidth: 0 }}
                name="Bureau estimate (not official)"
              />

              <Line
                type="linear"
                dataKey="officialGroundReturn"
                stroke="transparent"
                strokeWidth={0}
                dot={{ r: 6, fill: "hsl(var(--primary))", stroke: "hsl(var(--background))", strokeWidth: 2 }}
                activeDot={{ r: 7 }}
                name="Published return-site rating · 12.5 t"
                legendType="diamond"
              />

              <Line 
                type="stepAfter" 
                dataKey="f9Mass" 
                stroke="hsl(var(--muted-foreground))" 
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={{ r: 3, fill: "hsl(var(--muted-foreground))", strokeWidth: 0 }}
                name="Falcon 9 actual ramp (lifecycle-mapped)"
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 text-[10px] normal-case text-muted-foreground" data-testid="chart-series-guide">
          <p className="border border-primary/20 bg-primary/5 px-2 py-1.5">
            <span className="text-primary font-bold">Published record:</span> 12.5 t return-site recovery, 18.3 t downrange recovery, 21.3 t expendable.
          </p>
          <p className="border border-purple-500/20 bg-purple-500/5 px-2 py-1.5">
            <span className="text-purple-300 font-bold">Bureau model:</span> 2027–2032 routine-reuse estimate; 2028 range is 15–18 t, not Landspace guidance.
          </p>
        </div>

        <div className="mt-8 border-t border-purple-900/50 pt-6" data-testid="integrated-upmass-model">
          <div className="mb-5 space-y-2">
            <h3 className="text-purple-300 font-bold uppercase tracking-widest text-sm">
              Integrated Upmass Scenario
            </h3>
            <p className="text-muted-foreground normal-case leading-relaxed">
              This extends the per-flight estimate into a total-delivery scenario: each year&apos;s Bureau upmass midpoint
              is multiplied by the matching early-life Falcon 9 launch rate from GCAT. The result preserves Falcon 9&apos;s
              real early pause in program year two instead of quietly drawing a smooth exponential. It is a cadence
              analogue, not a Landspace launch manifest or company forecast.
            </p>
          </div>

          <div
            className="h-[360px] w-full"
            role="img"
            aria-label="Illustrative integrated Zhuque-3 upmass scenario. It combines the first seven years of Falcon 9 launch cadence with the Bureau's increasing Zhuque-3 per-flight upmass estimate. The scenario reaches 538.7 tonnes cumulatively by 2032 and is not Landspace guidance."
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={integratedUpmassData} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="year"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickMargin={10}
                  tick={{ fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis
                  yAxisId="annual"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickFormatter={(value) => `${value} t`}
                  tick={{ fill: "hsl(var(--muted-foreground))" }}
                  label={{ value: "ANNUAL TONNES", angle: -90, position: "insideLeft", fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis
                  yAxisId="cumulative"
                  orientation="right"
                  stroke="hsl(var(--primary))"
                  fontSize={10}
                  tickFormatter={(value) => `${value} t`}
                  tick={{ fill: "hsl(var(--primary))" }}
                  label={{ value: "CUMULATIVE TONNES", angle: 90, position: "insideRight", fontSize: 10, fill: "hsl(var(--primary))" }}
                />
                <Tooltip content={<IntegratedUpmassTooltip />} />
                <Legend wrapperStyle={{ fontSize: "10px", paddingTop: "10px" }} />
                <Bar
                  yAxisId="annual"
                  dataKey="annualUpmass"
                  fill="hsl(270 60% 60% / 0.55)"
                  stroke="hsl(270 60% 60%)"
                  name="Annual Bureau scenario"
                />
                <Line
                  yAxisId="cumulative"
                  type="monotone"
                  dataKey="cumulativeUpmass"
                  stroke="hsl(var(--primary))"
                  strokeWidth={3}
                  dot={{ r: 4, fill: "hsl(var(--primary))", strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: "hsl(var(--primary))", strokeWidth: 0 }}
                  name="Cumulative Bureau scenario"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3 text-[10px] normal-case text-muted-foreground">
            <p className="border border-border/70 bg-background/30 px-2 py-1.5">
              <span className="text-purple-300 font-bold">Cadence input:</span> Falcon 9 program years 1–7: 2, 0, 2, 3, 6, 7, 8 launches.
            </p>
            <p className="border border-border/70 bg-background/30 px-2 py-1.5">
              <span className="text-purple-300 font-bold">Formula:</span> annual tonnes = F9 analogue flights × Bureau tonnes per flight.
            </p>
            <p className="border border-primary/20 bg-primary/5 px-2 py-1.5">
              <span className="text-primary font-bold">2032 result:</span> 168.0 t that year; 538.7 t cumulative scenario.
            </p>
          </div>
        </div>
      </div>

      {/* EDITORIAL CONCLUSION */}
      <div className="border-l-2 border-purple-500/50 pl-4 py-1 space-y-3 font-sans text-sm md:text-base text-foreground/80 leading-relaxed">
        <p>
          <strong className="text-purple-300 font-mono text-xs uppercase tracking-widest block mb-2">Editorial Conclusion</strong>
          A routine reusable capability of <span className="text-foreground font-bold">15–18 tonnes by 2028</span> is credible, provided flight cadence, engine life, and reflight data cooperate. 
        </p>
        <p>
          The successful landing proves atmospheric control authority and terminal guidance. It does not immediately guarantee airline-like operational turnaround. The hard part of reusability is not landing once; it is landing fifty times without replacing the rocket in between. 
        </p>
        <p className="text-muted-foreground italic">
          We will be watching the turnaround times closely. The Bureau's tracking radars never sleep, though our analysts occasionally require coffee.
        </p>
        {embedded && (
          <Link
            href="/briefing/landspace-zhuque-3"
            className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-wider text-purple-300 hover:text-primary transition-colors"
          >
            Open standalone case file <ExternalLink className="w-3 h-3" />
          </Link>
        )}
      </div>
    </article>
  );
}
