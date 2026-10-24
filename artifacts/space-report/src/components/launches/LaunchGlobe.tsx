import { lazy, Suspense, useEffect, useRef, useState } from "react";

/**
 * LaunchGlobe — collapsible (default OPEN) 3D globe of every recent + upcoming
 * ILLUSTRATIVE launch ascent in /launches/index.json.
 *
 * Perf: this shell is tiny. three.js + the scene live in LaunchGlobeCanvas,
 * which is code-split (React.lazy) and only imported once (a) the browser has
 * painted / gone idle and (b) the block is within 200px of the viewport.
 * Usage:  import LaunchGlobe from "@/components/launches/LaunchGlobe";
 *         <LaunchGlobe />            // optional: indexUrl, height
 */
const LaunchGlobeCanvas = lazy(() => import("./LaunchGlobeCanvas"));

const FALLBACK_PNG = "/launches/globe/fallback.png";

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export interface LaunchGlobeProps {
  indexUrl?: string;
  height?: number;
  defaultOpen?: boolean;
}

export default function LaunchGlobe({ indexUrl = "/launches/index.json", height = 560, defaultOpen = true }: LaunchGlobeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [ready, setReady] = useState(false);
  const [webgl, setWebgl] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || ready) return;
    let io: IntersectionObserver | null = null;
    let cancelled = false;
    const arm = () => {
      if (cancelled || !ref.current) return;
      setWebgl(hasWebGL());
      io = new IntersectionObserver(
        (es) => {
          if (es.some((e) => e.isIntersecting)) {
            setReady(true);
            io?.disconnect();
          }
        },
        { rootMargin: "200px" },
      );
      io.observe(ref.current);
    };
    // wait for first paint, then idle
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const raf = requestAnimationFrame(() => {
      if (w.requestIdleCallback) w.requestIdleCallback(arm, { timeout: 1500 });
      else setTimeout(arm, 200);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [open, ready]);

  return (
    <section className="bg-card border-2 border-border box-glow relative overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-2 border-b border-border font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/5"
      >
        <span>
          ▲ Ascent globe — all recent &amp; upcoming launches{" "}
          <span className="text-accent">· ILLUSTRATIVE trajectories</span>
        </span>
        <span className="text-muted-foreground">{open ? "[ collapse − ]" : "[ expand + ]"}</span>
      </button>
      {open && (
        <div ref={ref} style={{ height }} className="relative bg-black">
          {!webgl ? (
            <img src={FALLBACK_PNG} alt="Static snapshot of illustrative launch ascent trajectories on a globe" className="w-full h-full object-contain" loading="lazy" />
          ) : ready ? (
            <Suspense fallback={<Loading />}>
              <LaunchGlobeCanvas indexUrl={indexUrl} />
            </Suspense>
          ) : (
            <Loading />
          )}
        </div>
      )}
    </section>
  );
}

function Loading() {
  return (
    <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-widest text-primary/70">
      Spinning up the globe…
    </div>
  );
}
