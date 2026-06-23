import { useGetSatcatSummary } from "@workspace/api-client-react";
import { Link } from "wouter";
import { AlertTriangle, ChevronRight, Activity, Globe2, Rocket, Calendar, Database, Server, Radar } from "lucide-react";
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
                Data is beamed directly from the GCAT uplink. If the numbers look scary, it's because there is a lot of junk up there. Proceed to Analytics for mass evaluation or the Explorer to track specific targets.
              </p>
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
