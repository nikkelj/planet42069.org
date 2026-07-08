import { Loader2, Scale, FileWarning } from "lucide-react";
import { Link } from "wouter";
import { useShuttleAudit } from "@/components/VehicleMassChart";

const fmt = (n: number) => n.toLocaleString();
const fmtT = (kg: number) => `${(kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} t`;

function SegBar({
  label,
  segments,
  maxKg,
}: {
  label: string;
  segments: { kg: number; color: string; title: string }[];
  maxKg: number;
}) {
  const total = segments.reduce((s, x) => s + x.kg, 0);
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px] uppercase tracking-wider">
        <span className="text-foreground/80">{label}</span>
        <span className="text-muted-foreground">{fmtT(total)}</span>
      </div>
      <div className="h-4 w-full bg-background/60 border border-yellow-500/15 flex overflow-hidden">
        {segments.map((s, i) => (
          <div
            key={i}
            title={`${s.title}: ${fmtT(s.kg)}`}
            style={{ width: `${(s.kg / maxKg) * 100}%`, background: s.color }}
          />
        ))}
      </div>
    </div>
  );
}

export function ShuttleMassComplaint() {
  const { data, isLoading, isError } = useShuttleAudit();

  const maxKg = data ? Math.max(data.gcat.totalKg, data.falcon9.totalKg) : 1;
  const orbiterPct = data ? (data.gcat.orbiterKg / data.gcat.totalKg) * 100 : 0;

  return (
    <div className="border border-yellow-500/40 bg-yellow-500/5 p-5 font-mono text-xs relative">
      <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-yellow-500/60 via-yellow-500/20 to-transparent" />
      <div className="flex items-start gap-3">
        <FileWarning className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
        <div className="space-y-3 w-full">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-yellow-500/20 pb-2">
            <span className="text-yellow-500 font-bold uppercase tracking-widest text-[11px]">
              Space Police — Official Complaint
            </span>
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
              Case #DRYMASS-0090 · Posted: 2026-07-08 · Status: SOLVED — CHARGES DISMISSED, TECHNICALLY
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
            <span><span className="text-yellow-500/70">Filed by:</span> Bureau of Gravimetric Integrity</span>
            <span><span className="text-yellow-500/70">Against:</span> The Space Shuttle Program (Posthumously)</span>
            <span><span className="text-yellow-500/70">Severity:</span> 12,911 Tonnes of Chutzpah</span>
          </div>

          <div className="space-y-2 text-muted-foreground leading-relaxed normal-case">
            <p>
              <span className="text-yellow-400 font-bold">Nature of offense:</span>{" "}
              A routine review of our own{" "}
              <Link href="/analytics" className="text-primary underline underline-offset-2 hover:text-accent transition-colors">
                Top Launch Vehicles by Mass to Orbit
              </Link>{" "}
              chart revealed the Space Shuttle sitting comfortably in first place — above Falcon 9 — despite retiring
              in 2011 after 134 orbital missions, while Falcon 9 has lofted over fifteen <em>thousand</em> catalogued
              payloads. The Bureau smelled a rat. The rat weighed ninety tonnes and had wings.
            </p>
            <p>
              <span className="text-yellow-400 font-bold">The investigation:</span>{" "}
              GCAT catalogs the <span className="text-foreground/80 font-bold">orbiter itself as a payload</span> on
              every single flight. Columbia, Challenger, Discovery, Atlantis, and Endeavour each appear in the
              satellite catalog once per mission — spacecraft, wings, crew cabin, thermal tiles, and all — at roughly
              90–100 tonnes a pop. The Shuttle was not carrying the payload. The Shuttle <em>was</em> the payload.
            </p>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-yellow-500 py-6">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="uppercase tracking-widest">Weighing the orbiters…</span>
            </div>
          ) : isError || !data ? (
            <div className="border border-destructive/40 bg-destructive/10 text-destructive p-3 uppercase tracking-wider">
              GCAT uplink failed — the orbiters remain unweighed
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div className="border border-yellow-500/20 bg-background/40 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Shuttle chart total</div>
                  <div className="text-foreground font-bold text-sm">{fmtT(data.gcat.totalKg)}</div>
                </div>
                <div className="border border-destructive/30 bg-destructive/5 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Of which: the orbiter</div>
                  <div className="text-destructive font-bold text-sm">{fmtT(data.gcat.orbiterKg)} <span className="text-[9px]">({orbiterPct.toFixed(1)}%)</span></div>
                </div>
                <div className="border border-yellow-500/20 bg-background/40 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Catalogued deployed cargo</div>
                  <div className="text-foreground font-bold text-sm">{fmtT(data.gcat.cargoKg)} <span className="text-[9px] text-muted-foreground">· {data.gcat.cargoObjects} obj</span></div>
                </div>
                <div className="border border-primary/30 bg-primary/5 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Falcon 9, for reference</div>
                  <div className="text-primary font-bold text-sm">{fmtT(data.falcon9.totalKg)} <span className="text-[9px] text-muted-foreground">· all genuine</span></div>
                </div>
              </div>

              <div className="border border-yellow-500/20 bg-background/30 p-3 space-y-2">
                <div className="text-[9px] text-yellow-500/70 uppercase tracking-widest">Exhibit A — Where the tonnage actually lives</div>
                <SegBar
                  label="Space Shuttle — GCAT actual"
                  maxKg={maxKg}
                  segments={[
                    { kg: data.gcat.orbiterKg, color: "hsl(0 80% 55% / 0.85)", title: "Orbiter catalogued as payload" },
                    { kg: data.gcat.cargoKg, color: "hsl(140 100% 50% / 0.9)", title: "Catalogued deployed cargo" },
                  ]}
                />
                <SegBar
                  label="Space Shuttle — theorized split"
                  maxKg={maxKg}
                  segments={[
                    { kg: data.theorized.orbiterDryKg, color: "hsl(25 90% 55% / 0.7)", title: "Theorized orbiter dry mass (published figures)" },
                    { kg: data.theorized.deliveredKg, color: "hsl(140 100% 50% / 0.6)", title: "Theorized delivered: crew, consumables, cargo" },
                  ]}
                />
                <SegBar
                  label="Falcon 9 — GCAT actual"
                  maxKg={maxKg}
                  segments={[{ kg: data.falcon9.totalKg, color: "hsl(140 100% 50% / 0.9)", title: "Genuine catalogued payloads" }]}
                />
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-muted-foreground uppercase tracking-wider pt-1">
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2" style={{ background: "hsl(0 80% 55% / 0.85)" }} /> Orbiter (GCAT)</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2" style={{ background: "hsl(25 90% 55% / 0.7)" }} /> Orbiter dry (theorized)</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2" style={{ background: "hsl(140 100% 50% / 0.9)" }} /> Delivered payload</span>
                </div>
              </div>

              <div className="overflow-x-auto border border-yellow-500/20">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="bg-yellow-500/10 text-yellow-500 uppercase tracking-wider text-[9px]">
                      <th className="text-left p-2 font-bold">Suspect</th>
                      <th className="text-right p-2 font-bold">Flights</th>
                      <th className="text-right p-2 font-bold">GCAT logged (kg)</th>
                      <th className="text-right p-2 font-bold hidden sm:table-cell">Published dry (kg)</th>
                      <th className="text-right p-2 font-bold">Theorized dry total (kg)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perOrbiter.map((o) => (
                      <tr key={o.ov} className="border-t border-yellow-500/10 hover:bg-yellow-500/5">
                        <td className="p-2 text-foreground/90">
                          {o.name} <span className="text-muted-foreground/60 text-[9px]">({o.ov})</span>
                        </td>
                        <td className="p-2 text-right font-mono text-muted-foreground">{o.flights}</td>
                        <td className="p-2 text-right font-mono text-foreground/90">{fmt(o.gcatMassKg)}</td>
                        <td className="p-2 text-right font-mono text-muted-foreground hidden sm:table-cell">{fmt(o.publishedDryKg)}</td>
                        <td className="p-2 text-right font-mono text-orange-400/80">{fmt(o.theorizedDryTotalKg)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-yellow-500/30 bg-yellow-500/5 font-bold">
                      <td className="p-2 text-yellow-500 uppercase tracking-wider text-[10px]">Total orbiter tonnage</td>
                      <td className="p-2 text-right font-mono text-foreground">{data.gcat.flights}</td>
                      <td className="p-2 text-right font-mono text-foreground">{fmt(data.gcat.orbiterKg)}</td>
                      <td className="p-2 text-right font-mono hidden sm:table-cell text-muted-foreground">—</td>
                      <td className="p-2 text-right font-mono text-orange-400">{fmt(data.theorized.orbiterDryKg)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="space-y-2 text-muted-foreground leading-relaxed normal-case pt-1">
                <p>
                  <span className="text-yellow-400 font-bold">Findings:</span>{" "}
                  Of the Shuttle's {fmtT(data.gcat.totalKg)} chart-topping total,{" "}
                  <span className="text-destructive font-bold">{orbiterPct.toFixed(1)}%</span> is the orbiter fleet
                  weighing itself — {data.gcat.flights} flights averaging{" "}
                  {fmt(Math.round(data.gcat.orbiterKg / data.gcat.flights))} kg each. Actual catalogued deployed cargo
                  over thirty years: <span className="text-foreground/80 font-bold">{fmtT(data.gcat.cargoKg)}</span>.
                  Even under the generous theorized accounting — subtracting only the published dry masses and
                  crediting the Shuttle with every kilogram of crew, fuel cells, Spacelab racks, and sandwiches —
                  it delivered perhaps <span className="text-foreground/80 font-bold">{fmtT(data.theorized.deliveredKg)}</span>.
                  Falcon 9 has delivered <span className="text-primary font-bold">{fmtT(data.falcon9.totalKg)}</span> of
                  payloads that are not, themselves, the rocket.
                </p>
                <p>
                  <span className="text-yellow-400 font-bold">The defense:</span>{" "}
                  GCAT is <em>technically correct</em> — the best kind of correct. The orbiter genuinely reached
                  orbit, genuinely weighed ninety tonnes, and genuinely did it 134 times. It was a spacecraft in its
                  own right, not a fairing. If your reusable spaceplane happens to be the heaviest object you ever
                  put in orbit, that is between you and your program accountants.
                </p>
                <p className="text-muted-foreground/80 border-l-2 border-yellow-500/30 pl-3">
                  <span className="text-yellow-400/90 font-bold">Verdict:</span> Charges dismissed. The catalog did
                  nothing wrong. The chart, however, has been sentenced to{" "}
                  <Link href="/analytics" className="text-primary underline underline-offset-2 hover:text-accent transition-colors">
                    mandatory segmentation
                  </Link>{" "}
                  — the Shuttle bar now discloses how much of it is Shuttle. The Space Shuttle's greatest payload
                  was <span className="text-yellow-300/80 font-bold">always itself</span>, and frankly, we respect it.
                </p>
              </div>
            </>
          )}

          <div className="flex items-center gap-2 text-[10px] text-yellow-500/50 uppercase tracking-wider border-t border-yellow-500/20 pt-2">
            <Scale className="w-3 h-3" />
            <span>
              GCAT figures computed live. Published orbiter dry masses from NASA reference data; "theorized" split is
              our derivation, not GCAT's. No orbiters were re-weighed in the making of this complaint.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
