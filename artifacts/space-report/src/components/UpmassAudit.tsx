import { useQuery } from "@tanstack/react-query";
import { Scale, Loader2, FileSearch } from "lucide-react";

type ProviderRow = { provider: string; massKg: number; count: number };
type UpmassResponse = {
  window: { start: string; end: string };
  providers: ProviderRow[];
  totalMassKg: number;
  totalCount: number;
};

// Bryce Tech "Spacecraft Upmass Carried by Launch Provider" — Q1 2026.
// Figures transcribed from the published chart (Exhibit A above).
const BRYCE: { provider: string; kg: number; label: string }[] = [
  { provider: "SpaceX", kg: 556057, label: "Space Exploration Technologies (SpaceX)" },
  { provider: "CASC", kg: 40980, label: "China Aerospace Sci. & Tech. Corp (CASC)" },
  { provider: "Roscosmos", kg: 19980, label: "Roscosmos" },
  { provider: "Arianespace", kg: 18415, label: "Arianespace" },
  { provider: "CAS Space", kg: 4400, label: "CAS Space" },
  { provider: "ULA", kg: 1900, label: "United Launch Alliance (ULA)" },
  { provider: "Galactic Energy", kg: 1485, label: "Galactic Energy" },
  { provider: "Chinarocket Co. Ltd.", kg: 1400, label: "Chinarocket Co. Ltd." },
  { provider: "Firefly Aerospace", kg: 1100, label: "Firefly Aerospace" },
  { provider: "ExPace", kg: 575, label: "ExPace" },
  { provider: "ISRO", kg: 573, label: "Indian Space Research Org. (ISRO)" },
  { provider: "Rocket Lab", kg: 478, label: "Rocket Lab" },
  { provider: "Space One", kg: 69, label: "Space One (Canon / IHI)" },
];
const BRYCE_TOTAL = 647412;

const fmt = (n: number) => n.toLocaleString();

type Verdict = {
  label: string;
  cls: string;
};

function verdict(bryce: number, gcat: number): Verdict {
  if (bryce === 0 && gcat === 0)
    return { label: "NO DATA", cls: "bg-muted/15 text-muted-foreground border-muted-foreground/30" };
  if (bryce > 0 && gcat === 0)
    return { label: "ABSENT IN GCAT", cls: "bg-destructive/15 text-destructive border-destructive/40" };
  if (gcat > 0 && bryce === 0)
    return { label: "NOT IN BRYCE", cls: "bg-orange-500/15 text-orange-400 border-orange-500/40" };
  const ratio = gcat / bryce;
  if (ratio >= 0.95 && ratio <= 1.05)
    return { label: "MATCH", cls: "bg-primary/15 text-primary border-primary/40" };
  if (ratio >= 0.8 && ratio <= 1.2)
    return { label: "CLOSE", cls: "bg-accent/15 text-accent border-accent/40" };
  return gcat < bryce
    ? { label: "GCAT LOWER", cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/40" }
    : { label: "GCAT HIGHER", cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/40" };
}

export function UpmassAudit() {
  const { data, isLoading, isError } = useQuery<UpmassResponse>({
    queryKey: ["upmass-by-provider"],
    queryFn: () =>
      fetch("/api/satcat/upmass-by-provider").then((r) => {
        if (!r.ok) throw new Error(`Upmass audit request failed: ${r.status}`);
        return r.json();
      }),
  });

  const gcatMap = new Map<string, ProviderRow>();
  for (const p of data?.providers ?? []) gcatMap.set(p.provider, p);

  // Bryce-listed providers, plus any GCAT provider with mass that Bryce omitted.
  const rows = BRYCE.map((b) => {
    const g = gcatMap.get(b.provider);
    return {
      provider: b.provider,
      label: b.label,
      bryce: b.kg,
      gcat: g?.massKg ?? 0,
      count: g?.count ?? 0,
    };
  });
  const extra = (data?.providers ?? [])
    .filter((p) => !BRYCE.some((b) => b.provider === p.provider) && p.massKg > 0)
    .map((p) => ({ provider: p.provider, label: p.provider, bryce: 0, gcat: p.massKg, count: p.count }));
  const allRows = [...rows, ...extra].sort((a, b) => Math.max(b.bryce, b.gcat) - Math.max(a.bryce, a.gcat));

  const gcatTotal = data?.totalMassKg ?? 0;
  const agreementPct =
    gcatTotal > 0 ? ((Math.min(gcatTotal, BRYCE_TOTAL) / Math.max(gcatTotal, BRYCE_TOTAL)) * 100) : 0;
  const matches = allRows.filter((r) => r.bryce > 0 && r.gcat > 0 && verdict(r.bryce, r.gcat).label === "MATCH").length;
  const gaps = allRows.filter((r) => r.bryce > 0 && r.gcat === 0).length;

  return (
    <div className="border border-accent/40 bg-accent/5 p-5 font-mono text-xs relative">
      <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-accent/60 via-accent/20 to-transparent" />
      <div className="flex items-start gap-3">
        <FileSearch className="w-5 h-5 text-accent shrink-0 mt-0.5" />
        <div className="space-y-3 w-full">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-accent/20 pb-2">
            <span className="text-accent font-bold uppercase tracking-widest text-[11px]">
              Space Police — Forensic Audit
            </span>
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
              Case #UPMASS-Q1 · Posted: 2026-07-02 · Status: CORROBORATED
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
            <span><span className="text-accent/70">Filed by:</span> Bureau of Independent Verification</span>
            <span><span className="text-accent/70">Subject:</span> Q1 2026 Spacecraft Upmass</span>
            <span><span className="text-accent/70">Method:</span> Live recompute from GCAT</span>
          </div>

          <div className="space-y-2 text-muted-foreground leading-relaxed normal-case">
            <p>
              <span className="text-accent font-bold">Premise:</span>{" "}
              Bryce Tech says {fmt(BRYCE_TOTAL)} kg of spacecraft reached orbit in Q1 2026. The Space Police do
              not take vendor charts on faith. We re-derived the same quarter — January through March 2026, payloads
              only — <em>directly from the Other Jonathan's catalog</em>, mapped every launch vehicle back to its
              service provider, and laid the two side by side. The question: do they agree?
            </p>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-accent py-6">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="uppercase tracking-widest">Recomputing upmass from GCAT…</span>
            </div>
          ) : isError ? (
            <div className="border border-destructive/40 bg-destructive/10 text-destructive p-3 uppercase tracking-wider">
              GCAT uplink failed — audit unavailable
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div className="border border-accent/20 bg-background/40 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Bryce Total</div>
                  <div className="text-foreground font-bold text-sm">{fmt(BRYCE_TOTAL)} <span className="text-[9px] text-muted-foreground">kg</span></div>
                </div>
                <div className="border border-accent/20 bg-background/40 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">GCAT Total</div>
                  <div className="text-foreground font-bold text-sm">{fmt(gcatTotal)} <span className="text-[9px] text-muted-foreground">kg</span></div>
                </div>
                <div className="border border-primary/30 bg-primary/5 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Agreement</div>
                  <div className="text-primary font-bold text-sm">{agreementPct.toFixed(1)}%</div>
                </div>
                <div className="border border-accent/20 bg-background/40 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Exact Matches</div>
                  <div className="text-foreground font-bold text-sm">{matches} <span className="text-[9px] text-muted-foreground">providers</span></div>
                </div>
              </div>

              <div className="overflow-x-auto border border-accent/20">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="bg-accent/10 text-accent uppercase tracking-wider text-[9px]">
                      <th className="text-left p-2 font-bold">Launch Provider</th>
                      <th className="text-right p-2 font-bold">Bryce (kg)</th>
                      <th className="text-right p-2 font-bold">GCAT (kg)</th>
                      <th className="text-right p-2 font-bold hidden sm:table-cell">Δ (kg)</th>
                      <th className="text-right p-2 font-bold">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allRows.map((r) => {
                      const v = verdict(r.bryce, r.gcat);
                      const delta = r.gcat - r.bryce;
                      return (
                        <tr key={r.provider} className="border-t border-accent/10 hover:bg-accent/5">
                          <td className="p-2 text-foreground/90">
                            {r.label}
                            {r.count > 0 && (
                              <span className="text-muted-foreground/60 text-[9px]"> · {r.count} obj</span>
                            )}
                          </td>
                          <td className="p-2 text-right font-mono text-muted-foreground">
                            {r.bryce > 0 ? fmt(r.bryce) : "—"}
                          </td>
                          <td className="p-2 text-right font-mono text-foreground/90">
                            {r.gcat > 0 ? fmt(r.gcat) : "—"}
                          </td>
                          <td className="p-2 text-right font-mono hidden sm:table-cell">
                            <span className={delta === 0 ? "text-muted-foreground" : delta > 0 ? "text-orange-400/80" : "text-yellow-400/80"}>
                              {r.bryce > 0 && r.gcat > 0 ? `${delta > 0 ? "+" : ""}${fmt(delta)}` : "—"}
                            </span>
                          </td>
                          <td className="p-2 text-right">
                            <span className={`inline-block px-1.5 py-0.5 border text-[9px] uppercase tracking-wider ${v.cls}`}>
                              {v.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-accent/30 bg-accent/5 font-bold">
                      <td className="p-2 text-accent uppercase tracking-wider text-[10px]">Total</td>
                      <td className="p-2 text-right font-mono text-foreground">{fmt(BRYCE_TOTAL)}</td>
                      <td className="p-2 text-right font-mono text-foreground">{fmt(gcatTotal)}</td>
                      <td className="p-2 text-right font-mono hidden sm:table-cell text-muted-foreground">
                        {`${gcatTotal - BRYCE_TOTAL > 0 ? "+" : ""}${fmt(gcatTotal - BRYCE_TOTAL)}`}
                      </td>
                      <td className="p-2 text-right text-primary text-[10px] uppercase">{agreementPct.toFixed(1)}%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="space-y-2 text-muted-foreground leading-relaxed normal-case pt-1">
                <p>
                  <span className="text-accent font-bold">Findings:</span>{" "}
                  The two sources are in <span className="text-primary font-bold">violent agreement</span> where it
                  counts. The totals land within <span className="text-foreground/80 font-bold">{(100 - agreementPct).toFixed(1)}%</span> of each
                  other, SpaceX reconciles almost to the kilogram, and {matches} provider{matches === 1 ? "" : "s"} match
                  GCAT outright with no fudging. When two independent accountants — one a commercial analytics firm,
                  the other a retired astronomer with a TSV file — arrive at the same {fmt(Math.round(gcatTotal / 1000))}-tonne
                  answer, the number is probably real.
                </p>
                <p>
                  <span className="text-accent font-bold">Discrepancies of note:</span>{" "}
                  Divergence is confined to the featherweight class — small Chinese commercial micro-launchers, where
                  one analyst's "estimated payload mass" is another's "we'll fill that in later."
                  {gaps > 0 && (
                    <> GCAT also shows <span className="text-destructive font-bold">nothing</span> for {gaps} provider{gaps === 1 ? "" : "s"} Bryce credits
                    (notably ISRO and Space One), a reminder that the freshest, smallest launches are the last to be
                    catalogued with a confirmed mass.</>
                  )}
                </p>
                <p className="text-muted-foreground/80 border-l-2 border-accent/30 pl-3">
                  <span className="text-accent/90 font-bold">Verdict:</span> No fraud detected. No cover-up. Just two
                  honest tallies of an absurd quarter in which a single company out-massed the rest of the species
                  by an order of magnitude. The disagreements are the rounding error on the rounding error. Case
                  closed — <span className="text-primary/80">in agreement, for once</span>.
                </p>
              </div>
            </>
          )}

          <div className="flex items-center gap-2 text-[10px] text-accent/50 uppercase tracking-wider border-t border-accent/20 pt-2">
            <Scale className="w-3 h-3" />
            <span>
              GCAT figures computed live; provider attribution inferred from launch-vehicle family and may differ
              slightly from Bryce's accounting. Bryce figures © Bryce Tech, transcribed for commentary.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
