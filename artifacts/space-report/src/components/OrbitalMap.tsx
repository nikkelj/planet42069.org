import { useQuery } from "@tanstack/react-query";
import { useRef, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Radar } from "lucide-react";

type OrbitalPoint = { p: number; i: number; c: string };
type OrbitalMapData = { points: OrbitalPoint[]; total: number };

const CLASS_COLORS: Record<string, string> = {
  P: "rgba(0, 255, 100, 0.65)",
  R: "rgba(255, 165, 40, 0.55)",
  D: "rgba(255, 60, 60, 0.28)",
  C: "rgba(80, 200, 255, 0.90)",
};
const DEFAULT_COLOR = "rgba(180, 180, 180, 0.38)";
const DRAW_ORDER = ["D", "R", "_other", "P", "C"];
const DOT_RADIUS: Record<string, number> = { D: 0.85, R: 1.1, P: 1.2, C: 2.0, _other: 0.9 };

const X_MIN_LOG = Math.log10(150);
const X_MAX_LOG = Math.log10(62000);
const X_TICKS = [200, 500, 1000, 2000, 5000, 10000, 20000, 36000];
const Y_TICKS = [0, 30, 60, 90, 120, 150, 180];

const ANNOTATIONS = [
  { p: 420, i: 51.6, label: "ISS", color: "rgba(80, 200, 255, 0.90)", dx: 8, dy: -12 },
  { p: 560, i: 53, label: "STARLINK", color: "rgba(0, 255, 100, 0.75)", dx: 8, dy: -12 },
  { p: 20200, i: 55, label: "GPS / MEO", color: "rgba(255, 165, 40, 0.90)", dx: 8, dy: -12 },
  { p: 35786, i: 1, label: "GEO", color: "rgba(255, 220, 60, 0.90)", dx: 8, dy: -12 },
];

const LEGEND_ITEMS = [
  { label: "PAYLOAD", color: CLASS_COLORS["P"] },
  { label: "ROCKET BODY", color: CLASS_COLORS["R"] },
  { label: "DEBRIS", color: CLASS_COLORS["D"] },
  { label: "CREWED", color: CLASS_COLORS["C"] },
  { label: "OTHER / UNKNOWN", color: DEFAULT_COLOR },
];

function drawMap(canvas: HTMLCanvasElement, points: OrbitalPoint[]) {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (W === 0 || H === 0) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const m = { top: 32, right: 148, bottom: 52, left: 60 };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;

  const mapX = (km: number) => {
    const log = Math.log10(Math.max(150, Math.min(km, 62000)));
    return m.left + ((log - X_MIN_LOG) / (X_MAX_LOG - X_MIN_LOG)) * pw;
  };
  const mapY = (inc: number) =>
    m.top + ph - (Math.max(0, Math.min(inc, 180)) / 180) * ph;

  const font = '"Chakra Petch", "Share Tech Mono", monospace';

  ctx.fillStyle = "#050d0d";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#060e0e";
  ctx.fillRect(m.left, m.top, pw, ph);

  ctx.lineWidth = 0.5;
  for (const km of X_TICKS) {
    ctx.strokeStyle = "rgba(0,255,100,0.07)";
    ctx.beginPath();
    ctx.moveTo(mapX(km), m.top);
    ctx.lineTo(mapX(km), m.top + ph);
    ctx.stroke();
  }
  for (const inc of Y_TICKS) {
    ctx.strokeStyle = "rgba(0,255,100,0.07)";
    ctx.beginPath();
    ctx.moveTo(m.left, mapY(inc));
    ctx.lineTo(m.left + pw, mapY(inc));
    ctx.stroke();
  }

  ctx.lineWidth = 1;
  ctx.setLineDash([3, 6]);
  ctx.strokeStyle = "rgba(255,240,80,0.14)";
  ctx.beginPath();
  ctx.moveTo(m.left, mapY(98));
  ctx.lineTo(mapX(1400), mapY(98));
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,220,60,0.12)";
  ctx.beginPath();
  ctx.moveTo(mapX(35786), m.top);
  ctx.lineTo(mapX(35786), m.top + ph);
  ctx.stroke();
  ctx.setLineDash([]);

  const byClass = new Map<string, OrbitalPoint[]>();
  for (const pt of points) {
    const key = CLASS_COLORS[pt.c] ? pt.c : "_other";
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key)!.push(pt);
  }

  for (const cls of DRAW_ORDER) {
    const pts = byClass.get(cls) ?? [];
    ctx.fillStyle = CLASS_COLORS[cls] ?? DEFAULT_COLOR;
    const r = DOT_RADIUS[cls] ?? 1.0;
    for (const { p, i } of pts) {
      const x = mapX(p);
      const y = mapY(i);
      if (x < m.left - 2 || x > m.left + pw + 2) continue;
      if (y < m.top - 2 || y > m.top + ph + 2) continue;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = "rgba(0,255,100,0.30)";
  ctx.lineWidth = 1;
  ctx.strokeRect(m.left, m.top, pw, ph);

  ctx.font = `10px ${font}`;
  ctx.fillStyle = "rgba(0,255,100,0.52)";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const km of X_TICKS) {
    const label = km >= 1000 ? `${km / 1000}k` : `${km}`;
    ctx.fillText(label, mapX(km), m.top + ph + 9);
  }

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const inc of Y_TICKS) {
    ctx.fillText(`${inc}°`, m.left - 7, mapY(inc));
  }

  ctx.save();
  ctx.translate(12, m.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = `10px ${font}`;
  ctx.fillStyle = "rgba(0,255,100,0.38)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("INCLINATION (deg)", 0, 0);
  ctx.restore();

  ctx.font = `10px ${font}`;
  ctx.fillStyle = "rgba(0,255,100,0.38)";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("PERIGEE ALTITUDE  (km, log scale)", m.left + pw / 2, m.top + ph + 34);

  ctx.font = `10px ${font}`;
  ctx.fillStyle = "rgba(255,240,80,0.45)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("SSO", m.left + 4, mapY(98) - 8);

  for (const { p, i, label, color, dx, dy } of ANNOTATIONS) {
    const x = mapX(p);
    const y = mapY(i);
    if (x < m.left || x > m.left + pw || y < m.top || y > m.top + ph) continue;
    const cs = 5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(x - cs, y); ctx.lineTo(x + cs, y);
    ctx.moveTo(x, y - cs); ctx.lineTo(x, y + cs);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = `bold 9px ${font}`;
    ctx.textAlign = dx > 0 ? "left" : "right";
    ctx.textBaseline = dy < 0 ? "bottom" : "top";
    ctx.fillText(label, x + dx, y + dy);
  }

  const lgX = m.left + pw + 16;
  let lgY = m.top + 16;
  ctx.font = `9px ${font}`;
  for (const { label, color } of LEGEND_ITEMS) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lgX + 5, lgY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(180,220,180,0.65)";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lgX + 14, lgY);
    lgY += 19;
  }

  ctx.font = `bold 9px ${font}`;
  ctx.fillStyle = "rgba(0,255,100,0.10)";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText("PLANET 42069 // ORBITAL DISTRIBUTION", m.left + pw - 4, m.top + ph - 4);
}

export function OrbitalMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useQuery<OrbitalMapData>({
    queryKey: ["satcat-orbital-map"],
    queryFn: async () => {
      const res = await fetch("/api/satcat/orbital-map");
      if (!res.ok) throw new Error("orbital map fetch failed");
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
  });

  const redraw = useCallback(() => {
    if (canvasRef.current && data?.points) {
      drawMap(canvasRef.current, data.points);
    }
  }, [data]);

  useEffect(() => {
    if (!data?.points || !containerRef.current) return;
    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [data, redraw]);

  return (
    <Card className="border-2 border-border bg-card relative overflow-hidden lg:col-span-2">
      <CardHeader className="bg-muted/30 border-b border-border">
        <CardTitle className="text-primary uppercase flex items-center gap-2 text-sm">
          <Radar className="w-4 h-4 animate-[spin_6s_linear_infinite]" />
          Orbital Distribution — Perigee Altitude vs Inclination
          {data && (
            <span className="ml-auto text-muted-foreground font-normal text-xs normal-case">
              {data.total.toLocaleString()} objects plotted
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading && (
          <div className="flex flex-col items-center justify-center gap-4 text-primary" style={{ height: 500 }}>
            <Loader2 className="w-10 h-10 animate-spin" />
            <span className="text-xs font-mono uppercase animate-pulse tracking-widest">
              Plotting orbital elements...
            </span>
          </div>
        )}
        {isError && (
          <div className="flex items-center justify-center text-destructive font-mono text-sm" style={{ height: 500 }}>
            UPLINK FAILED — ORBITAL MAP UNAVAILABLE
          </div>
        )}
        {data && (
          <div ref={containerRef} className="w-full" style={{ height: 500 }}>
            <canvas
              ref={canvasRef}
              style={{ width: "100%", height: "100%", display: "block" }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
