import { useQuery } from "@tanstack/react-query";
import { useRef, useEffect, useCallback, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, TrendingDown, Play, Pause, RotateCcw } from "lucide-react";

type DeorbitObj   = { y: number; p: number; a: number; i: number; c: string };
type DeorbitData  = { objects: DeorbitObj[]; total: number; yearMin: number; yearMax: number };
type View         = "pi" | "ap";

const TRAIL       = 12;  // years of trail to show
const MS_PER_YEAR = 140; // playback speed

const CLS_COLOR: Record<string, string> = {
  P: "0,255,100",
  R: "255,165,40",
  D: "255,60,60",
  C: "80,200,255",
  U: "180,180,180",
};
const defaultRgb = "180,180,180";

const LEGEND = [
  { c: "P", label: "PAYLOAD"     },
  { c: "R", label: "ROCKET BODY" },
  { c: "D", label: "DEBRIS"      },
  { c: "C", label: "COMPONENT"   },
];

function buildYearMap(objects: DeorbitObj[]): Map<number, DeorbitObj[]> {
  const m = new Map<number, DeorbitObj[]>();
  for (const o of objects) {
    if (!m.has(o.y)) m.set(o.y, []);
    m.get(o.y)!.push(o);
  }
  return m;
}

function drawFrame(
  canvas: HTMLCanvasElement,
  yearMap: Map<number, DeorbitObj[]>,
  curYear: number,
  view: View,
  yearMin: number,
  total: number,
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

  const m  = { top: 32, right: 20, bottom: 52, left: 62 };
  const pw = W - m.left - m.right;
  const ph = H - m.top  - m.bottom;
  const font = '"Chakra Petch","Share Tech Mono",monospace';

  // Background
  ctx.fillStyle = "#050d0d";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#060e0e";
  ctx.fillRect(m.left, m.top, pw, ph);

  // Axes helpers
  const MAX_P = 2000;
  const MAX_X = view === "pi" ? 180 : 2500;

  const mapX = (v: number) =>
    m.left + Math.max(0, Math.min(v, MAX_X)) / MAX_X * pw;
  const mapY = (p: number) =>
    m.top + ph - Math.max(0, Math.min(p, MAX_P)) / MAX_P * ph;

  // Grid
  ctx.lineWidth = 0.4;
  const xTicks = view === "pi"
    ? [0, 30, 60, 90, 120, 150, 180]
    : [0, 500, 1000, 1500, 2000, 2500];
  const yTicks = [0, 400, 800, 1200, 1600, 2000];

  for (const v of xTicks) {
    ctx.strokeStyle = "rgba(0,255,100,0.06)";
    ctx.beginPath(); ctx.moveTo(mapX(v), m.top); ctx.lineTo(mapX(v), m.top + ph); ctx.stroke();
  }
  for (const p of yTicks) {
    ctx.strokeStyle = "rgba(0,255,100,0.06)";
    ctx.beginPath(); ctx.moveTo(m.left, mapY(p)); ctx.lineTo(m.left + pw, mapY(p)); ctx.stroke();
  }

  // Border
  ctx.strokeStyle = "rgba(0,255,100,0.20)";
  ctx.lineWidth = 1;
  ctx.strokeRect(m.left, m.top, pw, ph);

  // Draw trail
  let countThisYear = 0;
  for (let dy = TRAIL; dy >= 0; dy--) {
    const yr  = curYear - dy;
    const age = dy;
    if (yr < yearMin) continue;
    const objs = yearMap.get(yr) ?? [];
    if (dy === 0) countThisYear = objs.length;

    const alpha = dy === 0 ? 0.95 : Math.max(0, 0.75 * (1 - age / TRAIL));

    for (const o of objs) {
      const xVal = view === "pi" ? o.i : o.a;
      const yVal = o.p;
      const x = mapX(xVal);
      const y = mapY(yVal);
      if (x < m.left || x > m.left + pw || y < m.top || y > m.top + ph) continue;

      const rgb = CLS_COLOR[o.c] ?? defaultRgb;
      const r   = dy === 0 ? 2.2 : 1.4;

      if (dy === 0) {
        // Glow for current year
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},0.12)`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(2)})`;
      ctx.fill();
    }
  }

  // X axis labels
  ctx.font = `10px ${font}`;
  ctx.fillStyle = "rgba(0,255,100,0.50)";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const v of xTicks) {
    const label = view === "pi" ? `${v}°` : v >= 1000 ? `${v/1000}k` : `${v}`;
    ctx.fillText(label, mapX(v), m.top + ph + 8);
  }
  ctx.fillText(
    view === "pi" ? "INCLINATION  (deg)" : "APOGEE  (km)",
    m.left + pw / 2, m.top + ph + 32,
  );

  // Y axis labels
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const p of yTicks) {
    ctx.fillText(`${p}`, m.left - 6, mapY(p));
  }

  // Y axis title
  ctx.save();
  ctx.translate(14, m.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,255,100,0.38)";
  ctx.fillText("PERIGEE  (km)", 0, 0);
  ctx.restore();

  // Year overlay (big)
  ctx.font = `bold 52px ${font}`;
  ctx.fillStyle = "rgba(0,255,100,0.08)";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(`${curYear}`, m.left + pw - 8, m.top + 8);

  // Stats
  ctx.font = `9px ${font}`;
  ctx.fillStyle = "rgba(0,255,100,0.55)";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const logged = [...yearMap.entries()]
    .filter(([y]) => y <= curYear)
    .reduce((s, [, v]) => s + v.length, 0);
  ctx.fillText(`REENTRIES ${curYear}: ${countThisYear}`, m.left + 6, m.top + 6);
  ctx.fillStyle = "rgba(0,255,100,0.35)";
  ctx.fillText(`TOTAL LOGGED: ${logged.toLocaleString()} / ${total.toLocaleString()}`, m.left + 6, m.top + 19);

  // Legend
  ctx.textBaseline = "middle";
  let lgY = m.top + ph - 14;
  for (const { c, label } of LEGEND) {
    const rgb = CLS_COLOR[c];
    ctx.fillStyle = `rgba(${rgb},0.85)`;
    ctx.beginPath(); ctx.arc(m.left + pw - 78, lgY, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(180,220,180,0.55)";
    ctx.textAlign = "left";
    ctx.font = `8px ${font}`;
    ctx.fillText(label, m.left + pw - 70, lgY);
    lgY -= 16;
  }
}

export function DeorbitAnimation() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [view,        setView]        = useState<View>("pi");
  const [curYear,     setCurYear]     = useState(1957);
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [hasStarted,  setHasStarted]  = useState(false);

  const yearRef      = useRef(1957);
  const playingRef   = useRef(false);
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, isLoading, isError } = useQuery<DeorbitData>({
    queryKey: ["deorbit-history"],
    queryFn: () => fetch("/api/satcat/deorbit-history").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
  });

  const yearMap = data ? buildYearMap(data.objects) : null;
  const maxYear = data?.yearMax ?? 2026;
  const minYear = data?.yearMin ?? 1957;

  const redraw = useCallback(() => {
    if (!canvasRef.current || !yearMap || !data) return;
    drawFrame(canvasRef.current, yearMap, yearRef.current, view, minYear, data.total);
  }, [yearMap, view, data, minYear]);

  // Redraw on resize
  useEffect(() => {
    if (!containerRef.current || !data) return;
    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [redraw, data]);

  // Playback timer
  const stopTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const startTimer = useCallback(() => {
    stopTimer();
    timerRef.current = setInterval(() => {
      if (!playingRef.current) return;
      const next = yearRef.current + 1;
      if (next > maxYear) {
        playingRef.current = false;
        setIsPlaying(false);
        stopTimer();
        return;
      }
      yearRef.current = next;
      setCurYear(next);
      redraw();
    }, MS_PER_YEAR);
  }, [maxYear, redraw]);

  const handlePlay = () => {
    if (yearRef.current >= maxYear) {
      yearRef.current = minYear;
      setCurYear(minYear);
    }
    playingRef.current = true;
    setIsPlaying(true);
    setHasStarted(true);
    startTimer();
  };

  const handlePause = () => {
    playingRef.current = false;
    setIsPlaying(false);
    stopTimer();
  };

  const handleReset = () => {
    handlePause();
    yearRef.current = minYear;
    setCurYear(minYear);
    redraw();
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const yr = parseInt(e.target.value);
    yearRef.current = yr;
    setCurYear(yr);
    redraw();
  };

  useEffect(() => () => stopTimer(), []);

  // Redraw when view changes
  useEffect(() => { redraw(); }, [view, redraw]);

  return (
    <Card className="border-2 border-border bg-card relative overflow-hidden lg:col-span-2">
      <CardHeader className="bg-muted/30 border-b border-border">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
            <TrendingDown className="w-4 h-4" />
            Orbital Decay — Reentry History
            {data && (
              <span className="ml-2 text-muted-foreground font-normal text-xs normal-case">
                {data.total.toLocaleString()} catalogued reentries
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
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
            <div ref={containerRef} className="w-full" style={{ height: 400 }}>
              <canvas
                ref={canvasRef}
                style={{ width: "100%", height: "100%", display: "block" }}
              />
            </div>
            {/* Controls */}
            <div className="border-t border-border bg-muted/20 px-4 py-3 flex flex-col gap-2">
              <div className="flex items-center gap-3">
                {!isPlaying ? (
                  <button
                    onClick={handlePlay}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground font-mono text-xs uppercase rounded hover:bg-primary/90 transition-colors"
                  >
                    <Play className="w-3 h-3" />
                    {hasStarted && curYear < maxYear ? "Resume" : "Play"}
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
                <span className="ml-auto font-mono text-xs text-primary tabular-nums">
                  {curYear}
                </span>
              </div>
              <input
                type="range"
                min={minYear}
                max={maxYear}
                value={curYear}
                onChange={handleScrub}
                className="w-full h-1 accent-primary cursor-pointer"
              />
              <p className="text-[10px] font-mono text-muted-foreground/50 leading-relaxed">
                <span className="text-primary/40">// </span>
                Each dot = one catalogued reentry at that year's final perigee altitude and inclination.
                Trailing glow = last {TRAIL} years. Green = payload · Orange = rocket body · Red = debris.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
