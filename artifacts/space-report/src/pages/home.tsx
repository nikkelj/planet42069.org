import { useGetSatcatSummary } from "@workspace/api-client-react";
import { Link } from "wouter";
import { AlertTriangle, ChevronRight, Activity, Globe2, Rocket, Calendar, Database, Server, Radar, FileWarning, Scale, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Home() {
  const { data: summary, isLoading, isError } = useGetSatcatSummary();

  const formatNumber = (num?: number) => {
    if (num === undefined) return "---";
    return num.toLocaleString();
  };

  const formatMass = (kg?: number) => {
    if (kg === undefined) return "---";
    return (kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-700">
      <div className="bg-card border-2 border-destructive p-6 relative overflow-hidden box-glow-cyan">
        <div className="absolute top-0 left-0 w-full h-1 bg-destructive animate-pulse" />
        <div className="flex items-start gap-4">
          <AlertTriangle className="w-8 h-8 text-destructive shrink-0 animate-pulse mt-1" />
          <div>
            <h2 className="text-xl font-bold text-destructive mb-2 uppercase text-glow">ATTENTION ALL PERSONNEL</h2>
            <div className="space-y-4 text-sm md:text-base font-sans leading-relaxed text-card-foreground">
              <p>
                Welcome to <span className="text-primary font-bold">PLANET 42069.ORG</span>. The Space Police have mandated total transparency regarding orbital litter. We track every satellite, every rocket body, and every piece of debris currently cluttering up the neighborhood.
              </p>
              <p>
                All data is sourced directly from the{" "}
                <a
                  href="https://planet4589.org/space/gcat/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent underline underline-offset-2 hover:text-primary transition-colors font-semibold"
                >
                  GCAT (General Catalog of Artificial Space Objects)
                </a>
                , maintained by the heroic{" "}
                <a
                  href="https://planet4589.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 hover:text-accent transition-colors font-semibold"
                >
                  Jonathan McDowell
                </a>
                , who has been painstakingly counting humanity's orbital mess since before half of it existed.
                If the numbers look scary, blame the humans — not the catalog.
              </p>
              <p className="text-muted-foreground text-xs uppercase tracking-wider">
                ⚠ This is a fan parody. Jonathan McDowell is not responsible for any of this.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* OFFICIAL COMPLAINT */}
      <div className="border border-yellow-500/40 bg-yellow-500/5 p-5 font-mono text-xs relative">
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-yellow-500/60 via-yellow-500/20 to-transparent" />
        <div className="flex items-start gap-3">
          <FileWarning className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
          <div className="space-y-3 w-full">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-yellow-500/20 pb-2">
              <span className="text-yellow-500 font-bold uppercase tracking-widest text-[11px]">
                Space Police — Official Complaint
              </span>
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Case #JCAT-0001 · Status: OPEN</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
              <span><span className="text-yellow-500/70">Filed by:</span> Numeric Standards Division</span>
              <span><span className="text-yellow-500/70">Against:</span> GCAT Primary Key Schema</span>
              <span><span className="text-yellow-500/70">Severity:</span> Mildly Infuriating</span>
            </div>
            <div className="space-y-2 text-muted-foreground leading-relaxed normal-case">
              <p>
                <span className="text-yellow-400 font-bold">Nature of offense:</span>{" "}
                All {summary?.totalObjects !== undefined ? formatNumber(summary.totalObjects) : "69,000+"} catalog primary keys (JCATs) are prefixed with the letter{" "}
                <span className="text-destructive font-bold">"S"</span>, as in <span className="font-bold text-foreground/70">S00001</span>,{" "}
                <span className="font-bold text-foreground/70">S00002</span>, etc. The "S" stands for "Satellite."
                The catalog is called the <em>Satellite</em> Catalog. We know. We have always known.
                Every consumer of this data must either perform string comparison on what is logically
                an integer, or strip the "S" off first — a manual operation that will, statistically,
                be forgotten by at least one developer per generation.
              </p>
              <p>
                <span className="text-yellow-400 font-bold">Proposed corrective action:</span>{" "}
                Remove the "S". If disambiguation is required, the column name "jcat" already implies satellite. 
                We humbly suggest renaming it <span className="text-primary font-bold">jnum</span> and sleeping better at night.
              </p>
              <p>
                <span className="text-yellow-400 font-bold">This site's unilateral remedy:</span>{" "}
                The offending "S" has been publicly struck through in the{" "}
                <Link href="/catalog" className="text-primary underline underline-offset-2 hover:text-accent transition-colors">
                  Satcat Explorer
                </Link>
                . It is aware of what it has done.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-yellow-500/50 uppercase tracking-wider border-t border-yellow-500/20 pt-2">
              <Scale className="w-3 h-3" />
              <span>No actual harm intended — Jonathan McDowell's catalog is otherwise an extraordinary achievement.</span>
            </div>
          </div>
        </div>
      </div>

      {/* FIELD DISPATCH */}
      <div className="border border-blue-400/25 bg-blue-950/20 p-5 font-mono text-xs relative">
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-blue-400/50 via-blue-400/15 to-transparent" />
        <div className="flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-blue-400/80 shrink-0 mt-0.5" />
          <div className="space-y-3 w-full">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-400/20 pb-2">
              <span className="text-blue-300/80 font-bold uppercase tracking-widest text-[11px]">
                Space Police — Field Dispatch
              </span>
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Dispatch #OC-0042 · Classification: Unclassified / For Public Record</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
              <span><span className="text-blue-400/60">From:</span> Commander, Orbital Bureaucracy Command</span>
              <span><span className="text-blue-400/60">Re:</span> The Commons, and What Is Being Done to Them</span>
              <span><span className="text-blue-400/60">Severity:</span> Civilization-Scale / Logged Under Protest</span>
            </div>
            <div className="space-y-3 text-muted-foreground leading-relaxed normal-case">
              <p>
                The Outer Space Treaty of 1967 declared orbital space the{" "}
                <em>"province of all mankind."</em> This was optimistic.
                It remains technically true. It is becoming increasingly theoretical in practice.
              </p>
              <p>
                Four nations have conducted direct-ascent anti-satellite weapons tests.
                Each one generated a debris cloud that raised collision risk for every operator
                in the affected altitude band — commercial, scientific, crewed, and military alike.
                None of the nations responsible offered to clean up afterward.{" "}
                <span className="text-blue-300/70">This is noted.</span>
              </p>
              <p>
                The major powers are openly developing co-orbital attack vehicles, electronic
                warfare platforms, and <em>"inspector"</em> satellites with maneuvering profiles
                inconsistent with their stated peaceful purposes. The Space Police maintain no
                illusions about what "inspection" means at those closing velocities.
              </p>
              <p>
                We would like to formally register our objection. We have been registering our
                objection since approximately 1985. We will continue to do so.
              </p>
              <p className="text-muted-foreground/80 border-l-2 border-blue-400/20 pl-3">
                We are also aware that space war — if not already underway in the gray zones of
                jamming, blinding, and spoofing — is a matter of <em>when</em> for the domain
                in its entirety. History has not identified a useful commons it was ultimately
                unwilling to militarize. We see no reason orbit should be different, and we
                resent this about history.
              </p>
              <p>
                The Space Police will track every object. Every debris fragment from every
                weapons test. Every "peaceful" dual-use constellation. Every maneuvering inspector.
                The catalog does not adjudicate intent. It simply records what is up there.
              </p>
              <p className="text-blue-200/60 font-semibold">
                Space belongs to everyone. It is also, apparently, becoming a warfighting domain.
                Both of these things are true simultaneously. We find this deeply inconvenient.
              </p>
            </div>
            <div className="flex flex-col gap-1 border-t border-blue-400/20 pt-2 text-[10px] text-blue-400/40 uppercase tracking-wider">
              <span>— Orbital Bureaucracy Command</span>
              <span>Filed under protest · Submitted for the record · Fully expecting to be ignored</span>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-5 h-5 text-accent" />
          <h2 className="text-xl font-display font-bold text-accent uppercase">Current Orbital Status</h2>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="border-border bg-card/50">
                <CardHeader className="pb-2">
                  <Skeleton className="h-4 w-24 bg-muted" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-32 bg-muted" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : isError ? (
          <div className="p-4 border border-destructive text-destructive text-center uppercase bg-destructive/10">
            Error establishing GCAT uplink. Retrying...
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard 
              title="Total Objects Tracked" 
              value={formatNumber(summary?.totalObjects)} 
              icon={Database}
              color="text-primary"
            />
            <StatCard 
              title="Total Payloads" 
              value={formatNumber(summary?.totalPayloads)} 
              icon={Satellite}
              color="text-accent"
            />
            <StatCard 
              title="Total Mass to Orbit (Tonnes)" 
              value={formatMass(summary?.totalMassKg)} 
              icon={Server}
              color="text-secondary"
            />
            <StatCard 
              title="Launch Vehicles" 
              value={formatNumber(summary?.launchVehicles)} 
              icon={Rocket}
              color="text-chart-4"
            />
            <StatCard 
              title="Nations & Orgs" 
              value={formatNumber(summary?.countries)} 
              icon={Globe2}
              color="text-chart-5"
            />
            <StatCard 
              title="Date Range" 
              value={`${summary?.firstLaunchYear} - ${summary?.lastLaunchYear}`} 
              icon={Calendar}
              color="text-primary"
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
        <Link href="/analytics" className="group relative block p-6 border-2 border-border bg-card hover:border-accent hover:bg-accent/10 transition-colors">
          <div className="absolute top-0 right-0 p-2 opacity-50 group-hover:opacity-100 group-hover:translate-x-1 transition-all">
            <ChevronRight className="text-accent w-6 h-6" />
          </div>
          <h3 className="text-xl font-bold text-accent mb-2 uppercase flex items-center gap-2">
            <Radar className="w-5 h-5" />
            Access Analytics
          </h3>
          <p className="text-muted-foreground text-sm font-sans">
            View historical mass-to-orbit trends, top polluting countries, and launch vehicle statistics across all time.
          </p>
        </Link>

        <Link href="/catalog" className="group relative block p-6 border-2 border-border bg-card hover:border-primary hover:bg-primary/10 transition-colors">
          <div className="absolute top-0 right-0 p-2 opacity-50 group-hover:opacity-100 group-hover:translate-x-1 transition-all">
            <ChevronRight className="text-primary w-6 h-6" />
          </div>
          <h3 className="text-xl font-bold text-primary mb-2 uppercase flex items-center gap-2">
            <Database className="w-5 h-5" />
            Search Catalog
          </h3>
          <p className="text-muted-foreground text-sm font-sans">
            Query the full Satcat database. Filter by owner, object class, orbit type, and operational status.
          </p>
        </Link>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, color }: { title: string, value: string, icon: any, color: string }) {
  return (
    <Card className="border-border bg-card hover:border-primary/50 transition-colors relative overflow-hidden group">
      <div className="absolute right-0 top-0 opacity-10 scale-150 -translate-y-1/4 translate-x-1/4 group-hover:scale-110 transition-transform duration-500">
        <Icon className={`w-32 h-32 ${color}`} />
      </div>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase text-muted-foreground flex items-center gap-2">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-bold font-display ${color} text-glow`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function Satellite(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 7 9 3 5 7l4 4" />
      <path d="m17 11 4 4-4 4-4-4" />
      <path d="m8 12 4 4 6-6-4-4Z" />
      <path d="m16 8 3-3" />
      <path d="M9 21a6 6 0 0 0-6-6" />
    </svg>
  );
}
