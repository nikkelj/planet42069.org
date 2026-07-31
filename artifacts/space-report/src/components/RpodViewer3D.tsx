import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import worldOutlines from "./world-outlines.json";

/**
 * Multi-spacecraft ECI viewer for RPOD events. Same conventions as
 * OrbitViewer3D (z-up ECI, units in Earth radii, true GMST Earth spin,
 * one shared sim clock) but draws EVERY event participant at once, with the
 * clock centered on the predicted time of closest approach and the slider
 * clamped to a window around it.
 */

const EARTH_R_KM = 6371;
const D2R = Math.PI / 180;
const GREEN = "#22ff88";
const DIM = "#1a5c3a";

/** Distinct participant colors (repeat if somehow >8 craft). */
const SAT_COLORS = ["#ff4455", "#22ddff", "#ffb020", "#c77dff", "#7dffb2", "#ff7de2", "#a4ff4f", "#4f9dff"];

const RATE = 30;
const WINDOW_HALF_MS = 2 * 3600_000;

function gmstRad(ms: number): number {
  const d = (ms - 946_728_000_000) / 86_400_000;
  const deg = (280.46061837 + 360.98564736629 * d) % 360;
  return ((deg + 360) % 360) * D2R;
}

export interface RpodTleInfo {
  incDeg: number;
  raanDeg: number;
  argPerigeeDeg: number;
  meanAnomalyDeg: number;
  eccentricity: number;
  meanMotionRevPerDay: number;
  epoch: string;
}

export interface RpodSat {
  norad: number;
  name: string | null;
  tle: RpodTleInfo | null;
}

interface Elements {
  a: number;
  e: number;
  rot: THREE.Matrix4;
  meanAnomalyRad: number;
  meanMotionRadPerMs: number;
  epochMs: number;
  periodMin: number;
}

function makeRot(incRad: number, raanRad: number, argpRad: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationZ(raanRad)
    .multiply(new THREE.Matrix4().makeRotationX(incRad))
    .multiply(new THREE.Matrix4().makeRotationZ(argpRad));
}

function elementsFromTle(t: RpodTleInfo): Elements | null {
  if (!Number.isFinite(t.meanMotionRevPerDay) || t.meanMotionRevPerDay <= 0) return null;
  const periodMin = 1440 / t.meanMotionRevPerDay;
  const MU = 398600.4418 / (EARTH_R_KM ** 3);
  const a = Math.cbrt(MU * ((periodMin * 60) / (2 * Math.PI)) ** 2);
  const epochMs = Date.parse(t.epoch);
  if (!Number.isFinite(epochMs)) return null;
  return {
    a,
    e: Math.min(0.995, Math.max(0, t.eccentricity)),
    rot: makeRot(t.incDeg * D2R, t.raanDeg * D2R, t.argPerigeeDeg * D2R),
    meanAnomalyRad: t.meanAnomalyDeg * D2R,
    meanMotionRadPerMs: (t.meanMotionRevPerDay * 2 * Math.PI) / 86400000,
    epochMs,
    periodMin,
  };
}

function trueAnomaly(M: number, e: number): number {
  let E = M;
  for (let i = 0; i < 5; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

function orbitPoint(el: Elements, nu: number, out: THREE.Vector3): THREE.Vector3 {
  const r = (el.a * (1 - el.e * el.e)) / (1 + el.e * Math.cos(nu));
  return out.set(r * Math.cos(nu), r * Math.sin(nu), 0).applyMatrix4(el.rot);
}

function satPosAt(el: Elements, ms: number, out: THREE.Vector3): THREE.Vector3 {
  const M = el.meanAnomalyRad + (ms - el.epochMs) * el.meanMotionRadPerMs;
  const nu = trueAnomaly(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), el.e);
  return orbitPoint(el, nu, out);
}

function orbitCurve(el: Elements, segments = 256): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) pts.push(orbitPoint(el, (i / segments) * 2 * Math.PI, new THREE.Vector3()));
  return pts;
}

interface SimClock { ms: number; playing: boolean; minMs: number; maxMs: number; }

function SimDriver({ clock }: { clock: SimClock }) {
  useFrame((_, dt) => {
    if (!clock.playing) return;
    clock.ms += dt * 1000 * RATE;
    if (clock.ms >= clock.maxMs) { clock.ms = clock.maxMs; clock.playing = false; }
    if (clock.ms < clock.minMs) clock.ms = clock.minMs;
  });
  return null;
}

const worldGeometry = (() => {
  const verts: number[] = [];
  const R = 1.004;
  for (const ring of worldOutlines as [number, number][][]) {
    let prev: [number, number, number] | null = null;
    for (const [lon, lat] of ring) {
      const cl = Math.cos(lat * D2R);
      const p: [number, number, number] = [R * cl * Math.cos(lon * D2R), R * cl * Math.sin(lon * D2R), R * Math.sin(lat * D2R)];
      if (prev) verts.push(...prev, ...p);
      prev = p;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  return geo;
})();

function Earth({ clock }: { clock: SimClock }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => { if (ref.current) ref.current.rotation.z = gmstRad(clock.ms); });
  return (
    <group>
      <group ref={ref}>
        <mesh>
          <sphereGeometry args={[1, 48, 48]} />
          <meshStandardMaterial color="#06301c" roughness={0.9} />
        </mesh>
        <lineSegments geometry={worldGeometry}>
          <lineBasicMaterial color={GREEN} transparent opacity={0.55} />
        </lineSegments>
      </group>
      <Line points={[new THREE.Vector3(0, 0, -1.5), new THREE.Vector3(0, 0, 1.5)]} color={DIM} lineWidth={1} />
    </group>
  );
}

function SatMarker({ el, clock, color, label }: { el: Elements; clock: SimClock; color: string; label: string }) {
  const ref = useRef<THREE.Group>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    if (!ref.current) return;
    ref.current.position.copy(satPosAt(el, clock.ms, tmp));
  });
  const markerR = Math.max(0.02, el.a * 0.008);
  return (
    <group ref={ref}>
      <mesh>
        <sphereGeometry args={[markerR, 12, 12]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh>
        <sphereGeometry args={[markerR * 2.2, 12, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.25} />
      </mesh>
      <Html center position={[0, markerR * 3.5, 0]}>
        <span style={{ color, fontSize: "7px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap", textShadow: "0 0 5px #000, 0 0 10px #000" }}>{label}</span>
      </Html>
    </group>
  );
}

/** Live separation line + km readout between the two closest participants. */
function SeparationLine({ els, clock }: { els: Elements[]; clock: SimClock }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    return g;
  }, []);
  const line = useMemo(() => new THREE.Line(geom, new THREE.LineBasicMaterial({ color: "#ffb020", transparent: true, opacity: 0.95 })), [geom]);
  useEffect(() => () => { geom.dispose(); (line.material as THREE.Material).dispose(); }, [geom, line]);
  const labelGroupRef = useRef<THREE.Group>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const tmpA = useMemo(() => new THREE.Vector3(), []);
  const tmpB = useMemo(() => new THREE.Vector3(), []);
  const pos = useMemo(() => els.map(() => new THREE.Vector3()), [els]);

  useFrame(() => {
    // Guard: with fewer than 2 propagatable tracks there is no separation to
    // draw — the hook still runs even though the component renders null.
    if (els.length < 2) return;
    for (let i = 0; i < els.length; i++) satPosAt(els[i], clock.ms, pos[i]);
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const d = pos[i].distanceTo(pos[j]);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    tmpA.copy(pos[bi]); tmpB.copy(pos[bj]);
    const attr = geom.getAttribute("position") as THREE.BufferAttribute;
    attr.setXYZ(0, tmpA.x, tmpA.y, tmpA.z);
    attr.setXYZ(1, tmpB.x, tmpB.y, tmpB.z);
    attr.needsUpdate = true;
    if (labelGroupRef.current) {
      labelGroupRef.current.position.set((tmpA.x + tmpB.x) / 2, (tmpA.y + tmpB.y) / 2, (tmpA.z + tmpB.z) / 2);
    }
    if (labelRef.current) {
      const km = bd * EARTH_R_KM;
      labelRef.current.textContent = km >= 1000 ? `${(km / 1000).toFixed(1)} Mm` : km >= 10 ? `${km.toFixed(0)} km` : `${km.toFixed(2)} km`;
    }
  });
  if (els.length < 2) return null;
  return (
    <>
      <primitive object={line} />
      <group ref={labelGroupRef}>
        <Html center>
          <div ref={labelRef} style={{ color: "#ffb020", fontSize: "8px", fontFamily: "monospace", whiteSpace: "nowrap", textShadow: "0 0 6px #000", background: "rgba(0,0,0,0.6)", padding: "1px 4px" }} />
        </Html>
      </group>
    </>
  );
}

function fmtSimTime(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19).replace("T", " ") + "Z" : "---";
}

export default function RpodViewer3D({ sats, tcaMs }: { sats: RpodSat[]; tcaMs: number }) {
  const withEls = useMemo(
    () => sats
      .map((s, i) => ({ sat: s, el: s.tle ? elementsFromTle(s.tle) : null, color: SAT_COLORS[i % SAT_COLORS.length] }))
      .filter((x): x is { sat: RpodSat; el: Elements; color: string } => x.el != null),
    [sats],
  );
  const els = useMemo(() => withEls.map((x) => x.el), [withEls]);
  const curves = useMemo(() => withEls.map((x) => orbitCurve(x.el)), [withEls]);

  const clockRef = useRef<SimClock>({ ms: tcaMs - 15 * 60_000, playing: true, minMs: tcaMs - WINDOW_HALF_MS, maxMs: tcaMs + WINDOW_HALF_MS });
  useEffect(() => {
    const c = clockRef.current;
    c.minMs = tcaMs - WINDOW_HALF_MS;
    c.maxMs = tcaMs + WINDOW_HALF_MS;
    c.ms = tcaMs - 15 * 60_000;
    c.playing = true;
  }, [tcaMs]);

  const [playing, setPlaying] = useState(true);
  const [dispMs, setDispMs] = useState(() => clockRef.current.ms);
  useEffect(() => {
    const id = setInterval(() => {
      setDispMs(clockRef.current.ms);
      setPlaying(clockRef.current.playing);
    }, 200);
    return () => clearInterval(id);
  }, []);

  const togglePlay = useCallback(() => {
    const c = clockRef.current;
    if (!c.playing && c.ms >= c.maxMs) c.ms = c.minMs;
    c.playing = !c.playing;
    setPlaying(c.playing);
  }, []);

  const goToTca = useCallback(() => {
    clockRef.current.ms = tcaMs;
    clockRef.current.playing = false;
    setPlaying(false);
    setDispMs(tcaMs);
  }, [tcaMs]);

  const [webglOk, setWebglOk] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      setWebglOk(!!(c.getContext("webgl2") || c.getContext("webgl")));
    } catch { setWebglOk(false); }
  }, []);

  const apoR = els.reduce((m, el) => Math.max(m, el.a * (1 + el.e)), 1.2);
  const camDist = Math.min(Math.max(3.2, apoR * 2.6), 40);

  if (webglOk === false) {
    return (
      <div className="relative w-full h-full min-h-[300px] bg-black/70 flex flex-col items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-widest p-4 text-center">
        <div className="text-destructive font-bold">Tracking display offline — WebGL unavailable in this terminal</div>
        <div className="text-muted-foreground normal-case space-y-1">
          {withEls.map(({ sat, el, color }) => (
            <div key={sat.norad}>
              <span style={{ color }}>■</span> #{sat.norad} {sat.name ?? ""} · INC {sat.tle!.incDeg.toFixed(2)}° · RAAN {sat.tle!.raanDeg.toFixed(2)}° · T ≈ {Math.round(el.periodMin)} min
            </div>
          ))}
          {withEls.length === 0 && <div>No element sets on file for this event</div>}
        </div>
      </div>
    );
  }
  if (webglOk === null) return <div className="w-full h-full min-h-[300px] bg-black/70" />;

  // Degraded data: not enough element sets on file to replay the approach.
  if (withEls.length < 2) {
    return (
      <div className="relative w-full h-full min-h-[300px] bg-black/70 flex flex-col items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-widest p-4 text-center">
        <div className="text-accent font-bold">Insufficient element sets on file to replay this approach</div>
        <div className="text-muted-foreground normal-case">
          {withEls.length === 1
            ? `Only #${withEls[0].sat.norad} ${withEls[0].sat.name ?? ""} has a usable orbit — the other participants' TLEs are missing from the archive.`
            : "No participant has a usable element set yet. The archive fills continuously; check back after the next sweep."}
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-[300px] bg-black/70 overflow-hidden">
      <Canvas
        camera={{ position: [camDist * 0.55, -camDist * 0.75, camDist * 0.45], up: [0, 0, 1], fov: 45, near: 0.05, far: 500 }}
        gl={{ antialias: true }}
        dpr={[1, 1.75]}
      >
        <SimDriver clock={clockRef.current} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[100, 0, 20]} intensity={1.6} color="#fff4d6" />
        <Earth clock={clockRef.current} />
        {withEls.map(({ sat, el, color }, i) => (
          <group key={sat.norad}>
            <Line points={curves[i]} color={color} lineWidth={1.2} transparent opacity={0.8} />
            <SatMarker el={el} clock={clockRef.current} color={color} label={`#${sat.norad}${sat.name ? " " + sat.name : ""}`} />
          </group>
        ))}
        <SeparationLine els={els} clock={clockRef.current} />
        <OrbitControls enablePan={false} minDistance={1.4} maxDistance={60} zoomSpeed={1.8} />
      </Canvas>

      <div className="pointer-events-none absolute top-2 left-3 font-mono text-[9px] sm:text-[10px] uppercase tracking-widest">
        <div className="text-primary font-bold">ECI FRAME · PROXIMITY OPERATIONS REPLAY</div>
        <div className="text-muted-foreground">TCA {fmtSimTime(tcaMs)}</div>
      </div>
      <div className="pointer-events-none absolute top-2 right-3 text-right font-mono text-[8px] sm:text-[9px] uppercase tracking-widest space-y-0.5">
        {withEls.map(({ sat, color }) => (
          <div key={sat.norad} style={{ color }}>■ #{sat.norad} {sat.name ?? "UNKNOWN"}</div>
        ))}
      </div>

      <div className="absolute bottom-0 inset-x-0 flex items-center gap-1.5 px-2 sm:px-3 py-1.5 bg-black/60 border-t border-border/40 font-mono text-[9px] uppercase tracking-widest">
        <Button
          type="button" variant="outline" size="sm" onClick={togglePlay}
          className="h-6 px-2 rounded-none border-primary/60 text-primary hover:bg-primary hover:text-primary-foreground flex-shrink-0"
          title={playing ? "Freeze simulation time" : "Resume simulation"}
        >
          {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
        </Button>
        <Button
          type="button" variant="outline" size="sm" onClick={goToTca}
          className="h-6 px-2 rounded-none border-primary/40 text-primary/80 hover:bg-primary hover:text-primary-foreground font-mono text-[9px] uppercase tracking-widest flex-shrink-0"
          title="Jump to the predicted time of closest approach"
        >
          TCA
        </Button>
        <input
          type="range"
          min={clockRef.current.minMs}
          max={clockRef.current.maxMs}
          step={1000}
          value={Math.min(clockRef.current.maxMs, Math.max(clockRef.current.minMs, dispMs))}
          onChange={(e) => { clockRef.current.ms = Number(e.target.value); setDispMs(Number(e.target.value)); }}
          className="flex-1 min-w-0 h-1 accent-[#22ff88] cursor-pointer"
          aria-label="Simulation time"
        />
        <span className="text-primary/90 whitespace-nowrap tabular-nums hidden sm:inline">{fmtSimTime(dispMs)}</span>
        <span className="text-primary/90 whitespace-nowrap tabular-nums sm:hidden text-[8px]">{fmtSimTime(dispMs).slice(11, 19)}Z</span>
        <span className="text-muted-foreground/70 whitespace-nowrap flex-shrink-0">{playing ? `${RATE}×` : "❙❙"}</span>
      </div>

      <div className="pointer-events-none absolute inset-0" style={{ background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 3px)" }} />
    </div>
  );
}
