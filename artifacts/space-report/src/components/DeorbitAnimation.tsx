import { useQuery } from "@tanstack/react-query";
import { useRef, useEffect, useCallback, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, TrendingDown, Play, Pause, RotateCcw } from "lucide-react";

type DeorbitObj  = { day: number; p: number; a: number; i: number; c: string };
type DeorbitData = { objects: DeorbitObj[]; total: number; dayMin: number; dayMax: number };
type View        = "pi" | "ap";

const TRAIL      = 90;   // day trail
const MS_PER_DAY = 2;    // playback speed (ms per day step)
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
  const d = new Date(EPOCH_MS + day * 86400000);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function dayToYearLabel(day: number): string {
  const d = new Date(EPOCH_MS + day * 86400000);
  return d.getFullYear().toString();
}

function buildDayMap(objects: DeorbitObj[]): Map<number, DeorbitObj[]> {
  const m = new Map<number, DeorbitObj[]>();
  for (const o of objects) {
    if (!m.has(o.day)) m.set(o.day, []);
    m.get(o.day)!.push(o);
  }
  return m;
}

function drawFrame(
  canvas: HTMLCanvasElement,
  dayMap: Map<number, DeorbitObj[]>,
  curDay: number,
  view: View,
  dayMin: number,
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

  ctx.fillStyle = "#050d0d";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#060e0e";
  ctx.fillRect(m.left, m.top, pw, ph);

  const MAX_P = 2000;
  const MAX_X = view === "pi" ? 180 : 2500;

  const mapX = (v: number) => m.left + Math.max(0, Math.min(v, MAX_X)) / MAX_X * pw;
  const mapY = (p: number) => m.top + ph - Math.max(0, Math.min(p, MAX_P)) / MAX_P * ph;

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

  // Draw trail — deadened fade: from 0.92 (age=0) down to 0.18 (age=TRAIL)
  let countToday = 0;
  for (let age = TRAIL; age >= 0; age--) {
    const day = curDay - age;
    if (day < dayMin) continue;
    const objs = dayMap.get(day) ?? [];
    if (age === 0) countToday = objs.length;

    // Deadened: minimum opacity 0.18 so old events stay visible
    const alpha = 0.18 + 0.74 * (1 - age / TRAIL);

    for (const o of objs) {
      const xVal = view === "pi" ? o.i : o.a;
      const yVal = o.p;
      const x = mapX(xVal);
      const y = mapY(yVal);
      if (x < m.left || x > m.left + pw || y < m.top || y > m.top + ph) continue;

      const rgb = CLS_COLOR[o.c] ?? "180,180,180";
      const r   = age === 0 ? 2.4 : 1.5;

      if (age === 0) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},0.14)`;
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
    const label = view === "pi" ? `${v}°` : v >= 1000 ? `${v / 1000}k` : `${v}`;
    ctx.fillText(label, mapX(v), m.top + ph + 8);
  }
  ctx.fillText(
    view === "pi" ? "INCLINATION  (deg)" : "APOGEE  (km)",
    m.left + pw / 2, m.top + ph + 32,
  );

  // Y axis labels
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

  // Year big label
  ctx.font = `bold 48px ${font}`;
  ctx.fillStyle = "rgba(0,255,100,0.08)";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(dayToYearLabel(curDay), m.left + pw - 8, m.top + 8);

  // Stats
  const logged = (() => {
    let n = 0;
    dayMap.forEach((v, k) => { if (k <= curDay) n += v.length; });
    return n;
  })();

  ctx.font = `9px ${font}`;
  ctx.fillStyle = "rgba(0,255,100,0.55)";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`REENTRIES TODAY: ${countToday}`, m.left + 6, m.top + 6);
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

  const [view,       setView]       = useState<View>("pi");
  const [curDay,     setCurDay]     = useState(0);
  const [isPlaying,  setIsPlaying]  = useState(false);
  const [hasStarted, setHasStarted] = useState(false);

  const dayRef     = useRef(0);
  const playingRef = useRef(false);
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, isLoading, isError } = useQuery<DeorbitData>({
    queryKey: ["deorbit-history"],
    queryFn: () => fetch("/api/satcat/deorbit-history").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
  });

  const dayMap = data ? buildDayMap(data.objects) : null;
  const maxDay = data?.dayMax ?? 25200;
  const minDay = data?.dayMin ?? 0;

  // Initialise slider to start of data
  useEffect(() => {
    if (data && curDay === 0) {
      dayRef.current = minDay;
      setCurDay(minDay);
    }
  }, [data, minDay, curDay]);

  const redraw = useCallback(() => {
    if (!canvasRef.current || !dayMap || !data) return;
    drawFrame(canvasRef.current, dayMap, dayRef.current, view, minDay, data.total);
  }, [dayMap, view, data, minDay]);

  useEffect(() => {
    if (!containerRef.current || !data) return;
    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [redraw, data]);

  const stopTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const startTimer = useCallback(() => {
    stopTimer();
    timerRef.current = setInterval(() => {
      if (!playingRef.current) return;
      const next = dayRef.current + 1;
      if (next > maxDay) {
        playingRef.current = false;
        setIsPlaying(false);
        stopTimer();
        return;
      }
      dayRef.current = next;
      setCurDay(next);
      redraw();
    }, MS_PER_DAY);
  }, [maxDay, redraw]);

  const handlePlay = () => {
    if (dayRef.current >= maxDay) {
      dayRef.current = minDay;
      setCurDay(minDay);
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
    dayRef.current = minDay;
    setCurDay(minDay);
    redraw();
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const d = parseInt(e.target.value);
    dayRef.current = d;
    setCurDay(d);
    redraw();
  };

  useEffect(() => () => stopTimer(), []);
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
            <div ref={containerRef} className="w-full" style={{ height: 400 }}>
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
                Day-precision reentry positions. Trail = {TRAIL}-day window — dots persist dimly so structural patterns remain visible.
                Green = payload · Orange = rocket body · Red = debris · Cyan = component.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
