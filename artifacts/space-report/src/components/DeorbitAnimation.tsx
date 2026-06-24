import { useQuery } from "@tanstack/react-query";
import { useRef, useEffect, useCallback, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, TrendingDown, Play, Pause, RotateCcw } from "lucide-react";

// Each object: launch day, decay day, initial perigee/apogee/inc, class
type DeorbitObj  = { lday: number; dday: number; p: number; a: number; i: number; c: string };
type DeorbitData = { objects: DeorbitObj[]; total: number; dayMin: number; dayMax: number };
type View        = "pi" | "ap";

// Playback: 2ms per day ⟹ ~50 seconds for full 1957-2026 history
const MS_PER_DAY = 2;
const EPOCH_MS   = Date.UTC(1957, 0, 1);

const CLS_COLOR: Record<string, string> = {
  P: "0,255,100",
  R: "255,165,40",
  D: "255,60,60",
  C: "80,200,255",
  U: "180,180,180",
};
const LEGEND = [
  { c: "P", label: "PAYLOAD"     },
  { c: "R", label: "ROCKET BODY" },
  { c: "D", label: "DEBRIS"      },
  { c: "C", label: "COMPONENT"   },
];

function dayToDateStr(day: number): string {
  return new Date(EPOCH_MS + day * 86400000)
    .toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
function dayToYear(day: number): string {
  return new Date(EPOCH_MS + day * 86400000).getFullYear().toString();
}

// Rebuild active list for a given day from sorted-by-lday array
function buildActive(sorted: DeorbitObj[], day: number): { list: DeorbitObj[]; nextIdx: number } {
  const list: DeorbitObj[] = [];
  let nextIdx = 0;
  for (; nextIdx < sorted.length; nextIdx++) {
    const o = sorted[nextIdx];
    if (o.lday > day) break;
    if (o.dday >= day) list.push(o);
  }
  return { list, nextIdx };
}

function drawFrame(
  canvas: HTMLCanvasElement,
  active: DeorbitObj[],
  curDay: number,
  view: View,
  totalDecayed: number,
) {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (W === 0 || H === 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const m   = { top: 32, right: 20, bottom: 52, left: 62 };
  const pw  = W - m.left - m.right;
  const ph  = H - m.top  - m.bottom;
  const fnt = '"Chakra Petch","Share Tech Mono",monospace';

  ctx.fillStyle = "#050d0d";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#060e0e";
  ctx.fillRect(m.left, m.top, pw, ph);

  const MAX_P = 2000;
  const MAX_X = view === "pi" ? 180 : 2500;
  const mapX  = (v: number) => m.left + Math.max(0, Math.min(v, MAX_X)) / MAX_X * pw;
  const mapY  = (p: number) => m.top + ph - Math.max(0, Math.min(p, MAX_P)) / MAX_P * ph;

  // Grid
  const xTicks = view === "pi" ? [0, 30, 60, 90, 120, 150, 180] : [0, 500, 1000, 1500, 2000, 2500];
  const yTicks = [0, 400, 800, 1200, 1600, 2000];
  ctx.lineWidth = 0.4;
  for (const v of xTicks) {
    ctx.strokeStyle = "rgba(0,255,100,0.06)";
    ctx.beginPath(); ctx.moveTo(mapX(v), m.top); ctx.lineTo(mapX(v), m.top + ph); ctx.stroke();
  }
  for (const p of yTicks) {
    ctx.strokeStyle = "rgba(0,255,100,0.06)";
    ctx.beginPath(); ctx.moveTo(m.left, mapY(p)); ctx.lineTo(m.left + pw, mapY(p)); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(0,255,100,0.20)";
  ctx.lineWidth = 1;
  ctx.strokeRect(m.left, m.top, pw, ph);

  // Draw active objects at their interpolated position
  let nearReentryCount = 0;
  for (const o of active) {
    const lifetime = Math.max(1, o.dday - o.lday);
    const age      = curDay - o.lday;
    const frac     = Math.max(0, 1 - age / lifetime);   // 1.0 at launch → 0.0 at decay
    const curP     = o.p * frac;
    const curA     = o.a * frac;

    const xVal = view === "pi" ? o.i : curA;
    const yVal = curP;
    const x    = mapX(xVal);
    const y    = mapY(yVal);
    if (x < m.left - 2 || x > m.left + pw + 2 || y < m.top - 2 || y > m.top + ph + 2) continue;

    const rgb     = CLS_COLOR[o.c] ?? "180,180,180";
    const isHot   = curP < 100;   // approaching reentry
    if (isHot) nearReentryCount++;

    const alpha = isHot ? 1.0 : 0.70;
    const r     = isHot ? 2.6 : 1.6;

    if (isHot) {
      // Glow for imminent reentry
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb},0.18)`;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rgb},${alpha})`;
    ctx.fill();
  }

  // Axis labels
  ctx.font = `10px ${fnt}`;
  ctx.fillStyle = "rgba(0,255,100,0.50)";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const v of xTicks) {
    const label = view === "pi" ? `${v}°` : v >= 1000 ? `${v / 1000}k` : `${v}`;
    ctx.fillText(label, mapX(v), m.top + ph + 8);
  }
  ctx.fillText(
    view === "pi" ? "INCLINATION  (deg)" : "APOGEE  (km)",
    m.left + pw / 2, m.top + ph + 32,
  );
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const p of yTicks) ctx.fillText(`${p}`, m.left - 6, mapY(p));

  ctx.save();
  ctx.translate(14, m.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,255,100,0.38)";
  ctx.fillText("PERIGEE  (km)", 0, 0);
  ctx.restore();

  // Year watermark
  ctx.font = `bold 48px ${fnt}`;
  ctx.fillStyle = "rgba(0,255,100,0.07)";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(dayToYear(curDay), m.left + pw - 8, m.top + 8);

  // Stats overlay
  ctx.font = `9px ${fnt}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(0,255,100,0.65)";
  ctx.fillText(`IN ORBIT NOW: ${active.length.toLocaleString()}`, m.left + 6, m.top + 6);
  if (nearReentryCount > 0) {
    ctx.fillStyle = "rgba(255,100,60,0.75)";
    ctx.fillText(`REENTRY IMMINENT: ${nearReentryCount}`, m.left + 6, m.top + 19);
  } else {
    ctx.fillStyle = "rgba(0,255,100,0.32)";
    ctx.fillText(`TOTAL CATALOGUED: ${totalDecayed.toLocaleString()}`, m.left + 6, m.top + 19);
  }

  // Legend
  ctx.textBaseline = "middle";
  let lgY = m.top + ph - 14;
  for (const { c, label } of LEGEND) {
    const rgb = CLS_COLOR[c];
    ctx.fillStyle = `rgba(${rgb},0.85)`;
    ctx.beginPath(); ctx.arc(m.left + pw - 78, lgY, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(180,220,180,0.55)";
    ctx.textAlign = "left";
    ctx.font = `8px ${fnt}`;
    ctx.fillText(label, m.left + pw - 70, lgY);
    lgY -= 16;
  }
}

export function DeorbitAnimation() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [view,       setView]       = useState<View>("pi");
  const [curDay,     setCurDay]     = useState(0);
  const [isPlaying,  setIsPlaying]  = useState(false);
  const [hasStarted, setHasStarted] = useState(false);

  // Mutable refs — no re-render on update
  const curDayRef    = useRef(0);
  const playingRef   = useRef(false);
  const viewRef      = useRef<View>("pi");
  const activeRef    = useRef<DeorbitObj[]>([]);
  const sortedRef    = useRef<DeorbitObj[]>([]);
  const launchIdxRef = useRef(0);
  const rafIdRef     = useRef<number>(0);
  const lastRafTsRef = useRef<number>(0);

  const { data, isLoading, isError } = useQuery<DeorbitData>({
    queryKey: ["deorbit-history"],
    queryFn: () => fetch("/api/satcat/deorbit-history").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
  });

  const maxDay = data?.dayMax ?? 25400;
  const minDay = data?.dayMin ?? 0;

  // Load sorted data into ref once
  useEffect(() => {
    if (!data) return;
    sortedRef.current = data.objects; // already sorted by lday from API
    // Initialise to start
    curDayRef.current = minDay;
    setCurDay(minDay);
    activeRef.current = [];
    launchIdxRef.current = 0;
  }, [data, minDay]);

  // Keep viewRef in sync
  useEffect(() => { viewRef.current = view; }, [view]);

  // ── Canvas redraw (called from RAF loop or on demand) ──
  const redraw = useCallback(() => {
    if (!canvasRef.current || !data) return;
    drawFrame(canvasRef.current, activeRef.current, curDayRef.current, viewRef.current, data.total);
  }, [data]);

  // ── RAF loop ──
  const loop = useCallback((ts: number) => {
    if (playingRef.current) {
      const elapsed = ts - lastRafTsRef.current;
      // Advance time: at MS_PER_DAY ms per day, calculate how many days this frame covers
      const advance = Math.max(0, Math.floor(elapsed / MS_PER_DAY));
      if (advance > 0) {
        lastRafTsRef.current = ts;
        const newDay = Math.min(curDayRef.current + advance, maxDay);
        const sorted = sortedRef.current;

        // Add newly launched objects
        while (
          launchIdxRef.current < sorted.length &&
          sorted[launchIdxRef.current].lday <= newDay
        ) {
          activeRef.current.push(sorted[launchIdxRef.current]);
          launchIdxRef.current++;
        }

        // Remove objects that have re-entered
        if (advance > 0) {
          activeRef.current = activeRef.current.filter((o) => o.dday >= newDay);
        }

        curDayRef.current = newDay;
        setCurDay(newDay);

        if (newDay >= maxDay) {
          playingRef.current = false;
          setIsPlaying(false);
        }
      }
    }

    // Always redraw each frame for smooth visual
    if (canvasRef.current && data) {
      drawFrame(canvasRef.current, activeRef.current, curDayRef.current, viewRef.current, data.total);
    }

    rafIdRef.current = requestAnimationFrame(loop);
  }, [maxDay, data]);

  // Start RAF loop when data loads; keep it running for redraws
  useEffect(() => {
    if (!data) return;
    lastRafTsRef.current = performance.now();
    rafIdRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafIdRef.current);
  }, [data, loop]);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current || !data) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [redraw, data]);

  // ── Controls ──
  const handlePlay = () => {
    if (curDayRef.current >= maxDay) {
      // Reset to start
      curDayRef.current = minDay;
      activeRef.current = [];
      launchIdxRef.current = 0;
      setCurDay(minDay);
    }
    lastRafTsRef.current = performance.now();
    playingRef.current = true;
    setIsPlaying(true);
    setHasStarted(true);
  };

  const handlePause = () => {
    playingRef.current = false;
    setIsPlaying(false);
  };

  const handleReset = () => {
    playingRef.current = false;
    setIsPlaying(false);
    curDayRef.current = minDay;
    activeRef.current = [];
    launchIdxRef.current = 0;
    setCurDay(minDay);
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const day = parseInt(e.target.value);
    // Pause while scrubbing
    playingRef.current = false;
    setIsPlaying(false);

    // Rebuild active list for this exact day
    const { list, nextIdx } = buildActive(sortedRef.current, day);
    activeRef.current    = list;
    launchIdxRef.current = nextIdx;
    curDayRef.current    = day;
    setCurDay(day);
  };

  return (
    <Card className="border-2 border-border bg-card relative overflow-hidden lg:col-span-2">
      <CardHeader className="bg-muted/30 border-b border-border">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
            <TrendingDown className="w-4 h-4" />
            Orbital Decay — Live Reentry Simulation
            {data && (
              <span className="ml-2 text-muted-foreground font-normal text-xs normal-case">
                {data.total.toLocaleString()} catalogued reentries
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-1 font-mono text-xs border border-border rounded overflow-hidden">
            <button
              onClick={() => setView("pi")}
              className={`px-3 py-1.5 uppercase transition-colors ${view === "pi" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
            >
              Inc / Perigee
            </button>
            <button
              onClick={() => setView("ap")}
              className={`px-3 py-1.5 uppercase transition-colors ${view === "ap" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
            >
              Apogee / Perigee
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading && (
          <div className="flex flex-col items-center justify-center gap-4 text-primary" style={{ height: 460 }}>
            <Loader2 className="w-10 h-10 animate-spin" />
            <span className="text-xs font-mono uppercase animate-pulse tracking-widest">
              Loading reentry catalog...
            </span>
          </div>
        )}
        {isError && (
          <div className="flex items-center justify-center text-destructive font-mono text-sm" style={{ height: 460 }}>
            UPLINK FAILED — REENTRY DATA UNAVAILABLE
          </div>
        )}
        {data && (
          <>
            <div ref={containerRef} className="w-full" style={{ height: 420 }}>
              <canvas
                ref={canvasRef}
                style={{ width: "100%", height: "100%", display: "block" }}
              />
            </div>
            <div className="border-t border-border bg-muted/20 px-4 py-3 flex flex-col gap-2">
              <div className="flex items-center gap-3">
                {!isPlaying ? (
                  <button
                    onClick={handlePlay}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground font-mono text-xs uppercase rounded hover:bg-primary/90 transition-colors"
                  >
                    <Play className="w-3 h-3" />
                    {hasStarted && curDay < maxDay ? "Resume" : "Play"}
                  </button>
                ) : (
                  <button
                    onClick={handlePause}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground font-mono text-xs uppercase rounded hover:bg-primary/90 transition-colors"
                  >
                    <Pause className="w-3 h-3" /> Pause
                  </button>
                )}
                <button
                  onClick={handleReset}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-border font-mono text-xs uppercase rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  <RotateCcw className="w-3 h-3" /> Reset
                </button>
                <span className="ml-auto font-mono text-xs text-primary tabular-nums tracking-wide">
                  {dayToDateStr(curDay)}
                </span>
              </div>
              <input
                type="range"
                min={minDay}
                max={maxDay}
                value={curDay}
                onChange={handleScrub}
                className="w-full h-1 accent-primary cursor-pointer"
              />
              <p className="text-[10px] font-mono text-muted-foreground/50 leading-relaxed">
                <span className="text-primary/40">// </span>
                Each dot = a real catalogued object. Position interpolated from its catalogued perigee at launch to 0 km at actual decay date.
                Objects accumulate and physically drop off the plot as they re-enter. Bright glow = perigee &lt; 100 km (imminent reentry).
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
