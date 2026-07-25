import { useMemo, useRef, useState, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Line, Html, Stars } from "@react-three/drei";
import * as THREE from "three";
import worldOutlines from "./world-outlines.json";

/**
 * True-to-scale Earth-Centered Inertial orbit viewer.
 * Units: Earth radii (1 unit = 6,371 km).
 *
 * Rendered to scale: Earth, the target orbit (from apogee/perigee/inclination),
 * the Moon (size + 60.3 R orbital distance), and the GEO belt.
 * RAAN / argument of perigee are not catalogued, so both are drawn as 0 —
 * the orbit's shape, size and inclination ARE to scale.
 * Earth's heliocentric path is drawn as the locally-straight velocity line
 * through the origin in the ecliptic plane (at 1 AU, curvature is invisible
 * at this zoom — that IS the to-scale rendering).
 */

const EARTH_R_KM = 6371;
const MOON_ORBIT_R = 384400 / EARTH_R_KM; // 60.34
const MOON_R = 1737 / EARTH_R_KM; // 0.273
const GEO_R = 42164 / EARTH_R_KM; // 6.62
const OBLIQUITY = (23.44 * Math.PI) / 180; // ecliptic tilt vs equator (ECI z = north)
const MOON_INC_ECLIPTIC = (5.14 * Math.PI) / 180;

const GREEN = "#22ff88";
const CYAN = "#22ddff";
const AMBER = "#ffb020";
const RED = "#ff4455";
const DIM = "#1a5c3a";

interface Elements {
  a: number; // semi-major axis, Earth radii
  e: number;
  incRad: number;
  periodMin: number;
}

function elementsFrom(apogeeKm: number, perigeeKm: number, incDeg: number): Elements | null {
  // GCAT data is messy: some rows have apogee/perigee swapped, negative
  // perigees (decayed / suborbital fits), or absurd deep-space apogees.
  // Sanitize rather than rendering NaN/hyperbolic garbage.
  if (!Number.isFinite(apogeeKm) || !Number.isFinite(perigeeKm)) return null;
  let apo = Math.max(apogeeKm, perigeeKm);
  let per = Math.min(apogeeKm, perigeeKm);
  // Keep perigee above the surface-ish so the ellipse stays elliptical.
  per = Math.max(per, -EARTH_R_KM * 0.9);
  const rA = (apo + EARTH_R_KM) / EARTH_R_KM;
  const rP = (per + EARTH_R_KM) / EARTH_R_KM;
  if (rA <= 0) return null;
  const a = (rA + rP) / 2;
  const e = Math.min(0.995, Math.max(0, (rA - rP) / (rA + rP)));
  // Kepler's third law with mu in (Earth radii)^3/s^2
  const MU = 398600.4418 / (EARTH_R_KM ** 3); // km^3/s^2 -> R^3/s^2
  const periodMin = (2 * Math.PI * Math.sqrt(a ** 3 / MU)) / 60;
  return { a, e, incRad: (incDeg * Math.PI) / 180, periodMin };
}

/** Position on the orbit at true anomaly nu, inclined about the X axis. */
function orbitPoint(el: Elements, nu: number, out: THREE.Vector3): THREE.Vector3 {
  const r = (el.a * (1 - el.e * el.e)) / (1 + el.e * Math.cos(nu));
  const x = r * Math.cos(nu);
  const y = r * Math.sin(nu);
  return out.set(x, y * Math.cos(el.incRad), y * Math.sin(el.incRad));
}

function orbitCurve(el: Elements, segments = 256): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    pts.push(orbitPoint(el, (i / segments) * 2 * Math.PI, new THREE.Vector3()));
  }
  return pts;
}

function ringPoints(radius: number, tiltX: number, segments = 128): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const cos = Math.cos(tiltX), sin = Math.sin(tiltX);
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * 2 * Math.PI;
    const x = radius * Math.cos(t);
    const y = radius * Math.sin(t);
    pts.push(new THREE.Vector3(x, y * cos, y * sin));
  }
  return pts;
}

/** Solve Kepler's equation M -> nu (few Newton steps is plenty). */
function trueAnomaly(M: number, e: number): number {
  let E = M;
  for (let i = 0; i < 5; i++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  return 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2),
  );
}

function Satellite({ el }: { el: Elements }) {
  const ref = useRef<THREE.Group>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  // One revolution every ~14 wall-clock seconds regardless of real period,
  // swept at physically correct (Keplerian) angular rate.
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const M = ((clock.elapsedTime % 14) / 14) * 2 * Math.PI;
    const nu = trueAnomaly(M, el.e);
    ref.current.position.copy(orbitPoint(el, nu, tmp));
  });
  const markerR = Math.max(0.035, el.a * 0.012);
  return (
    <group ref={ref}>
      <mesh>
        <sphereGeometry args={[markerR, 12, 12]} />
        <meshBasicMaterial color={RED} />
      </mesh>
      <mesh>
        <sphereGeometry args={[markerR * 2.2, 12, 12]} />
        <meshBasicMaterial color={RED} transparent opacity={0.25} />
      </mesh>
    </group>
  );
}

/**
 * Lunar orbit plane, composed properly: start in the equatorial XY plane,
 * tilt by the obliquity about X to reach the ecliptic, then tilt by the
 * Moon's 5.14° ecliptic inclination about a node line within the ecliptic.
 * The ascending node itself precesses over an 18.6-year cycle and is not
 * catalogued here, so the node longitude is representative (drawn at 0°).
 */
const MOON_PLANE_Q = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), OBLIQUITY) // equator -> ecliptic
  .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), MOON_INC_ECLIPTIC)); // ecliptic -> lunar plane about node (node at +X)

function moonPos(angle: number, out: THREE.Vector3): THREE.Vector3 {
  return out
    .set(MOON_ORBIT_R * Math.cos(angle), MOON_ORBIT_R * Math.sin(angle), 0)
    .applyQuaternion(MOON_PLANE_Q);
}

function Moon() {
  const ref = useRef<THREE.Group>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const ringPts = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) pts.push(moonPos((i / 128) * 2 * Math.PI, new THREE.Vector3()));
    return pts;
  }, []);
  // Sidereal month ~27.3 d; sweep slowly so it visibly creeps.
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.position.copy(moonPos((clock.elapsedTime / 240) * 2 * Math.PI, tmp));
  });
  return (
    <>
      <Line points={ringPts} color={CYAN} transparent opacity={0.35} dashed dashSize={1.6} gapSize={1.0} lineWidth={1} />
      <group ref={ref}>
        <mesh>
          <sphereGeometry args={[MOON_R, 24, 24]} />
          <meshStandardMaterial color="#9aa4ad" roughness={1} />
        </mesh>
        <Html distanceFactor={70} position={[0, MOON_R * 3, 0]}>
          <span className="text-[9px] font-mono uppercase tracking-widest whitespace-nowrap" style={{ color: CYAN }}>Moon · 384,400 km</span>
        </Html>
      </group>
    </>
  );
}

/** Coastlines + political boundaries, one merged line-segment geometry. */
const worldGeometry = (() => {
  const verts: number[] = [];
  const R = 1.004;
  const D2R = Math.PI / 180;
  for (const ring of worldOutlines as [number, number][][]) {
    let prev: [number, number, number] | null = null;
    for (const [lon, lat] of ring) {
      const cl = Math.cos(lat * D2R);
      // Scene is z-up ECI: z = north.
      const p: [number, number, number] = [
        R * cl * Math.cos(lon * D2R),
        R * cl * Math.sin(lon * D2R),
        R * Math.sin(lat * D2R),
      ];
      if (prev) verts.push(...prev, ...p);
      prev = p;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  return geo;
})();

function Earth() {
  const ref = useRef<THREE.Group>(null);
  // Spin about the z axis — that's the spin axis in this z-up ECI scene.
  useFrame((_, dt) => { if (ref.current) ref.current.rotation.z += dt * 0.05; });
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
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <sphereGeometry args={[1.002, 36, 24]} />
        <meshBasicMaterial color={GREEN} wireframe transparent opacity={0.1} />
      </mesh>
      {/* equator */}
      <Line points={ringPoints(1.005, 0)} color={GREEN} transparent opacity={0.5} lineWidth={1} />
      {/* spin axis */}
      <Line points={[new THREE.Vector3(0, 0, -1.5), new THREE.Vector3(0, 0, 1.5)]} color={DIM} lineWidth={1} />
    </group>
  );
}

function HeliocentricPath({ extent }: { extent: number }) {
  // Sun direction: +X in the ecliptic plane. Earth's velocity (its heliocentric
  // path, locally straight at this scale) is perpendicular: ecliptic +Y.
  const dir = new THREE.Vector3(0, Math.cos(OBLIQUITY), Math.sin(OBLIQUITY));
  const sunDir = new THREE.Vector3(1, 0, 0);
  return (
    <>
      <Line
        points={[dir.clone().multiplyScalar(-extent), dir.clone().multiplyScalar(extent)]}
        color={AMBER} transparent opacity={0.4} dashed dashSize={2.2} gapSize={1.4} lineWidth={1}
      />
      <Html distanceFactor={140} position={dir.clone().multiplyScalar(extent * 0.75).toArray()}>
        <span className="text-[9px] font-mono uppercase tracking-widest whitespace-nowrap" style={{ color: AMBER, opacity: 0.9 }}>Heliocentric path</span>
      </Html>
      {/* Direction-only ray: the Sun sits at 1 AU = 23,455 Earth radii,
          ~390× beyond the Moon — far off any usable chart. No marker sphere,
          so nothing implies the Sun's actual position is in frame. */}
      <Line
        points={[sunDir.clone().multiplyScalar(1.6), sunDir.clone().multiplyScalar(extent)]}
        color={AMBER} transparent opacity={0.25} lineWidth={1}
      />
      <Html distanceFactor={140} position={sunDir.clone().multiplyScalar(extent * 0.9).add(new THREE.Vector3(0, extent * 0.03, 0)).toArray()}>
        <span className="text-[9px] font-mono uppercase tracking-widest whitespace-nowrap" style={{ color: AMBER }}>→ Sol · 1 AU · 390× Moon dist · off chart</span>
      </Html>
    </>
  );
}

function Scene({ el }: { el: Elements | null }) {
  const orbitPts = useMemo(() => (el ? orbitCurve(el) : null), [el]);
  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[100, 0, 20]} intensity={1.6} color="#fff4d6" />
      <Stars radius={300} depth={60} count={2500} factor={3} saturation={0} fade speed={0.4} />
      <Earth />
      {/* GEO belt reference */}
      <Line points={ringPoints(GEO_R, 0)} color={DIM} transparent opacity={0.6} dashed dashSize={0.5} gapSize={0.5} lineWidth={1} />
      {orbitPts && el && (
        <>
          <Line points={orbitPts} color={GREEN} lineWidth={1.5} />
          <Satellite el={el} />
        </>
      )}
      <Moon />
      <HeliocentricPath extent={MOON_ORBIT_R * 1.35} />
    </>
  );
}

export default function OrbitViewer3D({ apogeeKm, perigeeKm, incDeg, name }: {
  apogeeKm?: number | null;
  perigeeKm?: number | null;
  incDeg?: number | null;
  name?: string;
}) {
  const el = useMemo(
    () =>
      apogeeKm != null && perigeeKm != null
        ? elementsFrom(apogeeKm, perigeeKm, incDeg ?? 0)
        : null,
    [apogeeKm, perigeeKm, incDeg],
  );

  // Frame the target orbit; if none, frame the Earth-Moon system.
  // Deep-space objects can have apogees in the millions of km — cap the
  // initial framing so Earth stays visible, and scale the camera limits to
  // the orbit instead of leaving the camera outside its own clamps.
  const apoR = el ? el.a * (1 + el.e) : 0;
  const camDist = el
    ? Math.min(Math.max(3.2, apoR * 2.6), MOON_ORBIT_R * 20)
    : MOON_ORBIT_R * 1.6;
  const maxZoomOut = Math.max(MOON_ORBIT_R * 4, camDist * 1.5);
  const farPlane = Math.max(4000, apoR * 6, maxZoomOut * 4);

  const [webglOk, setWebglOk] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      setWebglOk(!!gl);
    } catch {
      setWebglOk(false);
    }
  }, []);

  if (webglOk === false) {
    return (
      <div className="relative w-full h-full min-h-[340px] bg-black/70 flex flex-col items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-widest">
        <div className="text-destructive font-bold">Tracking display offline — WebGL unavailable in this terminal</div>
        {el ? (
          <div className="text-muted-foreground">
            APO {apogeeKm!.toLocaleString()} km · PER {perigeeKm!.toLocaleString()} km · INC {incDeg ?? 0}° · T ≈ {Math.round(el.periodMin).toLocaleString()} min
          </div>
        ) : (
          <div className="text-muted-foreground">No orbital elements on file</div>
        )}
      </div>
    );
  }
  if (webglOk === null) {
    return <div className="w-full h-full min-h-[340px] bg-black/70" />;
  }

  return (
    <div className="relative w-full h-full min-h-[340px] bg-black/70 overflow-hidden">
      <Canvas
        camera={{ position: [camDist * 0.55, -camDist * 0.75, camDist * 0.45], up: [0, 0, 1], fov: 45, near: 0.05, far: farPlane }}
        gl={{ antialias: true }}
        dpr={[1, 1.75]}
      >
        <Scene el={el} />
        <OrbitControls enablePan={false} minDistance={1.4} maxDistance={maxZoomOut} zoomSpeed={0.8} />
      </Canvas>

      {/* HUD */}
      <div className="pointer-events-none absolute top-2 left-3 font-mono text-[10px] uppercase tracking-widest text-primary/90">
        <div className="text-primary font-bold">ECI FRAME · EARTH-ORBIT GEOMETRY TO SCALE</div>
        {name && <div className="text-muted-foreground normal-case">{name}</div>}
      </div>
      <div className="pointer-events-none absolute top-2 right-3 text-right font-mono text-[10px] uppercase tracking-widest">
        {el ? (
          <>
            <div className="text-accent">APO {apogeeKm!.toLocaleString()} km</div>
            <div className="text-secondary">PER {perigeeKm!.toLocaleString()} km</div>
            <div className="text-chart-4">INC {(incDeg ?? 0)}°</div>
            <div className="text-muted-foreground">T ≈ {Math.round(el.periodMin).toLocaleString()} min</div>
          </>
        ) : (
          <div className="text-destructive">NO ORBITAL ELEMENTS ON FILE</div>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-2 left-3 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/80">
        Drag to rotate · Scroll to zoom out to the Moon · 1 unit = 1 Earth radius
      </div>
      <div className="pointer-events-none absolute bottom-2 right-3 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60">
        RAAN / ARG-PE / lunar node not catalogued — drawn at 0°
      </div>
      {/* scanline wash to stay in theme */}
      <div className="pointer-events-none absolute inset-0" style={{ background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 3px)" }} />
    </div>
  );
}
