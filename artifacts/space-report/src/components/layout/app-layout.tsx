import { Link, useLocation } from "wouter";
import { ReactNode } from "react";
import { Radar, Satellite, Database, TerminalSquare, Orbit, Crosshair } from "lucide-react";

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [location] = useLocation();

  const navItems = [
    { href: "/analytics", label: "MASS ANALYTICS", icon: Radar },
    { href: "/constellations", label: "CONSTELLATION WATCH", icon: Orbit },
    { href: "/catalog", label: "SATCAT EXPLORER", icon: Database },
    { href: "/rpod", label: "RPOD WATCH", icon: Crosshair },
    { href: "/briefing", label: "BRIEFING", icon: TerminalSquare },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
      <header className="border-b-2 border-primary mb-8 pb-4 flex flex-col md:flex-row items-start md:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 text-primary mb-2">
            <Satellite className="w-8 h-8 animate-pulse" />
            <h1 className="text-3xl md:text-4xl font-bold text-glow">PLANET 42069</h1>
          </div>
          <p className="text-muted-foreground text-sm uppercase tracking-widest font-sans flex items-center gap-2 flex-wrap">
            <span
              className="police-beacon shrink-0"
              role="img"
              aria-label="Space Police dispatch beacon active"
              title="Space Police — on duty"
            >
              <span className="beacon-dot beacon-red" />
              <span className="beacon-dot beacon-blue" />
            </span>
            Other Jonathan's Space Report // Orbital Bureaucracy Command
          </p>
        </div>

        <nav className="flex flex-wrap gap-2">
          {navItems.map((item) => {
            const isActive = item.href === "/briefing"
              ? (location === "/" || location === "/briefing")
              : location === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 px-4 py-2 uppercase text-sm font-bold transition-all border ${
                  isActive
                    ? "bg-primary text-primary-foreground border-primary box-glow"
                    : "bg-background text-foreground border-border hover:border-primary hover:text-primary"
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="flex-1">
        {children}
      </main>

      <footer className="mt-12 pt-6 border-t border-muted/50 text-center text-xs text-muted-foreground font-mono flex flex-col items-center gap-3">
        <div className="border border-muted/40 px-6 py-4 max-w-2xl space-y-2 text-left w-full">
          <p className="text-primary/80 uppercase tracking-widest text-[10px]">// DATA ATTRIBUTION</p>
          <p className="leading-relaxed normal-case">
            Orbital data is fused from multiple primary sources. The backbone is the{" "}
            <span className="text-primary font-bold">General Catalog of Artificial Space Objects (GCAT)</span>,
            maintained by{" "}
            <a
              href="https://planet4589.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:text-primary transition-colors"
            >
              Jonathan McDowell (planet4589.org)
            </a>
            , whose meticulous work tracking every nut, bolt, and derelict rocket stage
            in Earth orbit is what makes this parody possible — and frankly embarrassing to contemplate.
            Fresh catalog entries and orbital elements come from{" "}
            <a
              href="https://www.space-track.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:text-primary transition-colors"
            >
              space-track.org
            </a>{" "}
            (18th Space Defense Squadron, US Space Force). Satellite types and dossier
            cross-links come from{" "}
            <a
              href="https://space.skyrocket.de"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:text-primary transition-colors"
            >
              Gunter's Space Page
            </a>{" "}
            (© Gunter Dirk Krebs), the encyclopedia of who actually built all this stuff —
            each matched catalog entry links to his full dossier, where the real detail lives.
          </p>
          <p className="leading-relaxed normal-case text-muted-foreground/70">
            This site is a fan parody. It is not affiliated with Jonathan McDowell,
            Harvard-Smithsonian CfA, Gunter Dirk Krebs, the US Space Force,
            nor any actual Space Police force
            (which, for the record, we fully support creating).
          </p>
        </div>
        <div className="flex items-center gap-2 uppercase tracking-widest text-[10px]">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span>SYSTEM ONLINE</span>
        </div>
      </footer>
    </div>
  );
}
