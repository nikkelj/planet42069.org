import { Link, useLocation } from "wouter";
import { ReactNode } from "react";
import { Radar, Satellite, Database, TerminalSquare } from "lucide-react";

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "MISSION BRIEFING", icon: TerminalSquare },
    { href: "/analytics", label: "MASS ANALYTICS", icon: Radar },
    { href: "/catalog", label: "SATCAT EXPLORER", icon: Database },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
      <header className="border-b-2 border-primary mb-8 pb-4 flex flex-col md:flex-row items-start md:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 text-primary mb-2">
            <Satellite className="w-8 h-8 animate-pulse" />
            <h1 className="text-3xl md:text-4xl font-bold text-glow">PLANET 42069</h1>
          </div>
          <p className="text-muted-foreground text-sm uppercase tracking-widest font-sans">
            Other Jonathan's Space Report // Orbital Bureaucracy Command
          </p>
        </div>

        <nav className="flex flex-wrap gap-2">
          {navItems.map((item) => {
            const isActive = location === item.href;
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

      <footer className="mt-12 pt-6 border-t border-muted/50 text-center text-xs text-muted-foreground uppercase flex flex-col items-center gap-2">
        <p>A PARODY OF JONATHAN MCDOWELL'S PLANET4589.ORG</p>
        <p>NOT AFFILIATED WITH ANY ACTUAL SPACE POLICE OR SPACE AGENCY.</p>
        <div className="flex items-center gap-2 mt-2">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span>SYSTEM ONLINE</span>
        </div>
      </footer>
    </div>
  );
}
