import { useMemo } from "react";
import * as satellite from "satellite.js";
import worldOutlines from "./world-outlines.json";

/**
 * 2D equirectangular ground-track map for a selected pass.
 *
 * The sub-satellite track is propagated client-side (SGP4 via satellite.js)
 * from the same TLE the 3D viewer uses. We draw a context track covering the
 * pass window plus a lead-in/lead-out margin, with the segment during the
 * pass itself highlighted, and mark the observer's station.
 */

export interface GroundTrackPass {
  startTime: string;
  endTime: string;
}

const W = 720;
const H = 360;
const DEG = Math.PI / 180;
const MARGIN_MS = 8 * 60_000; // context before rise / after set
const STEP_MS = 10_000;

const projX = (lon: number) => ((lon + 180) / 360) * W;
const projY = (lat: number) => ((90 - lat) / 180) * H;

type LL = { lon: number; lat: number; inPass: boolean };

/** Propagate sub-satellite points across the window; null on SGP4 failure. */
function computeTrack(
  line1: string,
  line2: string,
  startMs: number,
  endMs: number,
): LL[] | null {
  const satrec = satellite.twoline2satrec(line1, line2);
  const pts: LL[] = [];
  for (let t = startMs - MARGIN_MS; t <= endMs + MARGIN_MS; t += STEP_MS) {
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;
    const gmst = satellite.gstime(date);
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    let lon = gd.longitude / DEG;
    // normalize to [-180, 180]
    lon = ((lon + 540) % 360) - 180;
    pts.push({ lon, lat: gd.latitude / DEG, inPass: t >= startMs && t <= endMs });
  }
  return pts.length >= 2 ? pts : null;
}

/** Split a point run into polylines at antimeridian wraps. */
function toPolylines(pts: LL[]): { d: string; inPass: boolean }[] {
  const out: { d: string; inPass: boolean }[] = [];
  let seg: LL[] = [];
  const flush = () => {
    if (seg.length >= 2) {
      // a segment is "in pass" only if every vertex is inside the window,
      // so the highlight never bleeds into the lead-in/lead-out margins
      const inPass = seg.every((p) => p.inPass);
      out.push({
        d: seg.map((p, i) => `${i === 0 ? "M" : "L"}${projX(p.lon).toFixed(1)},${projY(p.lat).toFixed(1)}`).join(""),
        inPass,
      });
    }
    seg = [];
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    if (prev && Math.abs(p.lon - prev.lon) > 180) {
      flush();
    } else if (prev && prev.inPass !== p.inPass) {
      // split at the rise/set boundary so styling changes there; the shared
      // vertex takes the pass state so the highlight meets the dashed track
      flush();
      seg = [{ ...prev, inPass: p.inPass }];
    }
    seg.push(p);
  }
  flush();
  return out;
}

export default function GroundTrackMap({ line1, line2, observer, pass }: {
  line1: string;
  line2: string;
  observer: { lat: number; lon: number };
  pass: GroundTrackPass;
}) {
  const startMs = Date.parse(pass.startTime);
  const endMs = Date.parse(pass.endTime);

  const track = useMemo(() => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    try {
      return computeTrack(line1, line2, startMs, endMs);
    } catch {
      return null; // malformed TLE — map just doesn't render
    }
  }, [line1, line2, startMs, endMs]);

  const outlines = useMemo(
    () =>
      (worldOutlines as [number, number][][]).map((poly) =>
        poly.map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${projX(lon).toFixed(1)},${projY(lat).toFixed(1)}`).join("") + "Z",
      ),
    [],
  );

  if (!track) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70 px-1">
        Ground track unavailable — element set could not be propagated over this window.
      </div>
    );
  }

  const lines = toPolylines(track);
  const riseP = track.find((p) => p.inPass);
  const setP = [...track].reverse().find((p) => p.inPass);

  return (
    <div className="space-y-1">
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
        Ground track — sub-satellite path during the selected pass
      </div>
      <div className="border border-border/60 bg-black/60 overflow-hidden">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="World map showing the satellite ground track for the selected pass">
          {/* graticule */}
          {[-60, -30, 0, 30, 60].map((lat) => (
            <line key={`lat${lat}`} x1={0} x2={W} y1={projY(lat)} y2={projY(lat)} stroke="hsl(var(--border))" strokeOpacity={lat === 0 ? 0.5 : 0.25} strokeWidth={0.5} />
          ))}
          {[-120, -60, 0, 60, 120].map((lon) => (
            <line key={`lon${lon}`} x1={projX(lon)} x2={projX(lon)} y1={0} y2={H} stroke="hsl(var(--border))" strokeOpacity={lon === 0 ? 0.5 : 0.25} strokeWidth={0.5} />
          ))}
          {/* continents */}
          {outlines.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="hsl(var(--muted-foreground))" strokeOpacity={0.55} strokeWidth={0.6} />
          ))}
          {/* context track (lead-in / lead-out) then highlighted pass segment */}
          {lines.filter((l) => !l.inPass).map((l, i) => (
            <path key={`c${i}`} d={l.d} fill="none" stroke="hsl(var(--muted-foreground))" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="3 3" />
          ))}
          {lines.filter((l) => l.inPass).map((l, i) => (
            <path key={`p${i}`} d={l.d} fill="none" stroke="hsl(var(--primary))" strokeWidth={2} />
          ))}
          {/* rise / set markers */}
          {riseP && <circle cx={projX(riseP.lon)} cy={projY(riseP.lat)} r={3} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.2} />}
          {setP && <rect x={projX(setP.lon) - 2.6} y={projY(setP.lat) - 2.6} width={5.2} height={5.2} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.2} />}
          {/* observer station */}
          <g>
            <line x1={projX(observer.lon) - 5} x2={projX(observer.lon) + 5} y1={projY(observer.lat)} y2={projY(observer.lat)} stroke="hsl(var(--accent))" strokeWidth={1.2} />
            <line x1={projX(observer.lon)} x2={projX(observer.lon)} y1={projY(observer.lat) - 5} y2={projY(observer.lat) + 5} stroke="hsl(var(--accent))" strokeWidth={1.2} />
            <circle cx={projX(observer.lon)} cy={projY(observer.lat)} r={2} fill="hsl(var(--accent))" />
          </g>
        </svg>
      </div>
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60">
        <span className="text-primary">━</span> during pass · <span>┄</span> approach / departure · ○ rise · □ set · <span className="text-accent">+</span> your station
      </div>
    </div>
  );
}
