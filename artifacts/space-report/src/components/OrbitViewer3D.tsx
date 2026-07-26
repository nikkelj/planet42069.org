import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Line, Html, Stars } from "@react-three/drei";
import * as THREE from "three";
import { Pause, Play, RadioTower } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import worldOutlines from "./world-outlines.json";

/**
 * True-to-scale Earth-Centered Inertial orbit viewer.
 * Units: Earth radii (1 unit = 6,371 km).
 *
 * Rendered to scale: Earth, the target orbit (from apogee/perigee/inclination),
 * the Moon (size + 60.3 R orbital distance), and the GEO belt.
 * RAAN / argument of perigee are not catalogued, so both are drawn as 0 —
 * the orbit's shape, size and inclination ARE to scale.
 *
 * Everything moves on ONE simulation clock: Earth spin (true GMST, so the
 * ground under the satellite is where it really is), the Moon, and the
 * satellite (mean-anomaly propagation from its element epoch). The clock
 * runs time-accelerated by default so motion is visible, can be frozen,
 * and can be dragged back and forth on a slider. Selecting a pass in the
 * Pass Finder slews the clock to the pass window and paints the observer's
 * visibility cone and the live slant-range vector.
 */

const EARTH_R_KM = 6371;
const MOON_ORBIT_R = 384400 / EARTH_R_KM; // 60.34
const MOON_R = 1737 / EARTH_R_KM; // 0.273
const GEO_R = 42164 / EARTH_R_KM; // 6.62
const AU_R = 149_597_870 / EARTH_R_KM; // 23,481 Earth radii
const SUN_R = 696_000 / EARTH_R_KM; // 109 Earth radii — yes, really
const OBLIQUITY = (23.44 * Math.PI) / 180; // ecliptic tilt vs equator (ECI z = north)
const MOON_INC_ECLIPTIC = (5.14 * Math.PI) / 180;
const SIDEREAL_MONTH_MS = 27.321661 * 86400_000;

const GREEN = "#22ff88";
const CYAN = "#22ddff";
const AMBER = "#ffb020";
const RED = "#ff4455";
const DIM = "#1a5c3a";

/** Default sim speed: 60x — a LEO rev in ~90s, an Earth day in 24 min. */
const DEFAULT_RATE = 60;
/** Sim speed while replaying a pass window (passes last minutes). */
const PASS_RATE = 10;

/** Greenwich Mean Sidereal Time, radians, from a Unix-ms timestamp. */
function gmstRad(ms: number): number {
  const d = (ms - 946_728_000_000) / 86_400_000; // days since J2000.0
  const deg = (280.46061837 + 360.98564736629 * d) % 360;
  return ((deg + 360) % 360) * (Math.PI / 180);
}

/** Geocentric ECI position of a ground observer (lat/lon degrees) at time ms. */
function observerEci(latDeg: number, lonDeg: number, ms: number, out: THREE.Vector3): THREE.Vector3 {
  const lat = latDeg * (Math.PI / 180);
  const lst = lonDeg * (Math.PI / 180) + gmstRad(ms);
  const cl = Math.cos(lat);
  return out.set(cl * Math.cos(lst), cl * Math.sin(lst), Math.sin(lat));
}

interface SimClock {
  ms: number;
  playing: boolean;
  rate: number;
  /** Optional clamp (pass-window replay stops at the window edge). */
  minMs?: number;
  maxMs?: number;
}

interface Elements {
  a: number; // semi-major axis, Earth radii
  e: number;
  incRad: number;
  periodMin: number;
  /** perifocal -> ECI rotation: Rz(RAAN) · Rx(inc) · Rz(argp). Identity-ish when RAAN/argp unknown. */
  rot: THREE.Matrix4;
  /** Real-time propagation info when built from a TLE. */
  tle?: {
    meanAnomalyRad: number; // at epoch
    meanMotionRadPerMs: number;
    epochMs: number;
  };
}

function makeRot(incRad: number, raanRad: number, argpRad: number): THREE.Matrix4 {
  const rz1 = new THREE.Matrix4().makeRotationZ(raanRad);
  const rx = new THREE.Matrix4().makeRotationX(incRad);
  const rz2 = new THREE.Matrix4().makeRotationZ(argpRad);
  return rz1.multiply(rx).multiply(rz2);
}

export interface TleInfo {
  incDeg: number;
  raanDeg: number;
  argPerigeeDeg: number;
  meanAnomalyDeg: number;
  eccentricity: number;
  meanMotionRevPerDay: number;
  epoch: string;
}

export interface PassWindow {
  startMs: number;
  endMs: number;
}

const D2R_ = Math.PI / 180;

/** Build full oriented elements from a space-track GP element set. */
function elementsFromTle(t: TleInfo): Elements | null {
  if (!Number.isFinite(t.meanMotionRevPerDay) || t.meanMotionRevPerDay <= 0) return null;
  const periodMin = 1440 / t.meanMotionRevPerDay;
  const MU = 398600.4418 / (EARTH_R_KM ** 3); // R^3/s^2
  const a = Math.cbrt(MU * ((periodMin * 60) / (2 * Math.PI)) ** 2);
  const e = Math.min(0.995, Math.max(0, t.eccentricity));
  const epochMs = Date.parse(t.epoch);
  if (!Number.isFinite(epochMs)) return null;
  return {
    a,
    e,
    incRad: t.incDeg * D2R_,
    periodMin,
    rot: makeRot(t.incDeg * D2R_, t.raanDeg * D2R_, t.argPerigeeDeg * D2R_),
    tle: {
      meanAnomalyRad: t.meanAnomalyDeg * D2R_,
      meanMotionRadPerMs: (t.meanMotionRevPerDay * 2 * Math.PI) / 86400000,
      epochMs,
    },
  };
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
  const incRad = (incDeg * Math.PI) / 180;
  return { a, e, incRad, periodMin, rot: makeRot(incRad, 0, 0) };
}

/** Position on the orbit at true anomaly nu, rotated perifocal -> ECI. */
function orbitPoint(el: Elements, nu: number, out: THREE.Vector3): THREE.Vector3 {
  const r = (el.a * (1 - el.e * el.e)) / (1 + el.e * Math.cos(nu));
  return out.set(r * Math.cos(nu), r * Math.sin(nu), 0).applyMatrix4(el.rot);
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

/** Satellite ECI position (Earth radii) at sim time ms. */
function satPosAt(el: Elements, ms: number, out: THREE.Vector3): THREE.Vector3 {
  const M = el.tle
    ? el.tle.meanAnomalyRad + (ms - el.tle.epochMs) * el.tle.meanMotionRadPerMs
    : (ms / (el.periodMin * 60_000)) * 2 * Math.PI;
  const nu = trueAnomaly(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), el.e);
  return orbitPoint(el, nu, out);
}

/** Advances the shared sim clock once per rendered frame. */
function SimDriver({ clock }: { clock: SimClock }) {
  useFrame((_, dt) => {
    if (!clock.playing) return;
    clock.ms += dt * 1000 * clock.rate;
    if (clock.maxMs != null && clock.ms >= clock.maxMs) {
      clock.ms = clock.maxMs;
      clock.playing = false;
    }
    if (clock.minMs != null && clock.ms < clock.minMs) clock.ms = clock.minMs;
  });
  return null;
}

function Satellite({ el, clock, satPosRef }: { el: Elements; clock: SimClock; satPosRef: React.MutableRefObject<THREE.Vector3> }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    satPosAt(el, clock.ms, satPosRef.current);
    ref.current.position.copy(satPosRef.current);
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

function Moon({ clock }: { clock: SimClock }) {
  const ref = useRef<THREE.Group>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const ringPts = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) pts.push(moonPos((i / 128) * 2 * Math.PI, new THREE.Vector3()));
    return pts;
  }, []);
  // Phase from the same sim clock (sidereal month), so freezing time freezes the Moon.
  useFrame(() => {
    if (!ref.current) return;
    ref.current.position.copy(moonPos((clock.ms / SIDEREAL_MONTH_MS) * 2 * Math.PI, tmp));
  });
  return (
    <>
      <Line points={ringPts} color={CYAN} transparent opacity={0.35} dashed dashSize={1.6} gapSize={1.0} lineWidth={1} />
      <group ref={ref}>
        <mesh>
          <sphereGeometry args={[MOON_R, 24, 24]} />
          <meshStandardMaterial color="#9aa4ad" roughness={1} />
        </mesh>
        <Html distanceFactor={110} position={[0, MOON_R * 2.5, 0]} occlude>
          <span style={{ color: CYAN, fontSize: "7px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap", textShadow: "0 0 4px #000" }}>Moon · 384,400 km</span>
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

function Earth({ clock }: { clock: SimClock }) {
  const ref = useRef<THREE.Group>(null);
  // Spin about the z axis (the spin axis in this z-up ECI scene), phased by
  // TRUE sidereal time — the meridian under the satellite is the real one.
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

export interface Telemetry {
  valid: boolean;
  azDeg: number;
  elDeg: number;
  rangeKm: number;
}

/**
 * Ground observer: station marker, visibility cone (zenith-aligned, 10°
 * elevation mask), and the live slant-range vector to the satellite. All of
 * it tracks the sim clock — drag time and the vector sweeps with it.
 * Az/el/range are written into telemetryRef for the HUD (throttled outside).
 */
function ObserverRig({ observer, clock, el, satPosRef, telemetryRef }: {
  observer: { lat: number; lon: number };
  clock: SimClock;
  el: Elements;
  satPosRef: React.MutableRefObject<THREE.Vector3>;
  telemetryRef: React.MutableRefObject<Telemetry>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const slantMidGroupRef = useRef<THREE.Group>(null);
  const slantLabelRef = useRef<HTMLDivElement>(null);
  const obs = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const d = useMemo(() => new THREE.Vector3(), []);

  // Cone: apex at the observer, opening along local zenith, half-angle 80°
  // (i.e. everything above the 10° elevation mask). Height scaled to the
  // orbit so it visibly reaches toward the pass altitude.
  const coneH = Math.min(Math.max(0.35, (el.a * (1 - el.e) - 1) * 1.2), 3.5);
  const coneGeom = useMemo(() => {
    const g = new THREE.ConeGeometry(coneH * Math.tan(80 * D2R_), coneH, 48, 1, true);
    g.rotateX(Math.PI);           // apex down (to local origin)
    g.translate(0, coneH / 2, 0); // apex at origin, opening toward +Y
    return g;
  }, [coneH]);
  // Imperative geometry: R3F only auto-disposes JSX-declared objects, so
  // release GPU buffers ourselves when the cone is rebuilt or unmounts.
  useEffect(() => () => coneGeom.dispose(), [coneGeom]);

  const slantGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    return g;
  }, []);
  const slantLine = useMemo(
    () => new THREE.Line(slantGeom, new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.95 })),
    [slantGeom],
  );
  // Dispose the slant line's geometry + material on rebuild/unmount —
  // <primitive> objects are never auto-disposed by R3F.
  useEffect(() => () => {
    slantGeom.dispose();
    (slantLine.material as THREE.Material).dispose();
  }, [slantGeom, slantLine]);

  useFrame(() => {
    if (!groupRef.current) return;
    observerEci(observer.lat, observer.lon, clock.ms, obs);
    groupRef.current.position.copy(obs);
    q.setFromUnitVectors(up, d.copy(obs).normalize());
    groupRef.current.quaternion.copy(q);

    // Slant vector observer -> satellite
    const sat = satPosRef.current;
    const pos = slantGeom.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, obs.x, obs.y, obs.z);
    pos.setXYZ(1, sat.x, sat.y, sat.z);
    pos.needsUpdate = true;

    // Topocentric az/el/range (ENU)
    d.copy(sat).sub(obs);
    const rangeKm = d.length() * EARTH_R_KM;
    const lat = observer.lat * D2R_;
    const lst = observer.lon * D2R_ + gmstRad(clock.ms);
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const sinLst = Math.sin(lst), cosLst = Math.cos(lst);
    const east = -sinLst * d.x + cosLst * d.y;
    const north = -sinLat * cosLst * d.x - sinLat * sinLst * d.y + cosLat * d.z;
    const zen = cosLat * cosLst * d.x + cosLat * sinLst * d.y + sinLat * d.z;
    const azDeg = ((Math.atan2(east, north) / D2R_) + 360) % 360;
    const elDeg = Math.asin(zen / Math.max(1e-9, d.length())) / D2R_;
    telemetryRef.current = { valid: true, azDeg, elDeg, rangeKm };

    // Position the slant-line midpoint label and update its text imperatively
    // (avoids a React re-render every frame).
    if (slantMidGroupRef.current) {
      slantMidGroupRef.current.position.set(
        (obs.x + sat.x) / 2,
        (obs.y + sat.y) / 2,
        (obs.z + sat.z) / 2,
      );
    }
    if (slantLabelRef.current) {
      const rStr = rangeKm >= 10_000
        ? `${(rangeKm / 1000).toFixed(1)} Mm`
        : `${rangeKm.toFixed(0)} km`;
      slantLabelRef.current.textContent = `AZ ${azDeg.toFixed(1)}° · EL ${elDeg.toFixed(1)}° · ${rStr}`;
    }
  });

  return (
    <>
      <group ref={groupRef}>
        <mesh>
          <sphereGeometry args={[0.02, 12, 12]} />
          <meshBasicMaterial color={AMBER} />
        </mesh>
        <mesh geometry={coneGeom}>
          <meshBasicMaterial color={AMBER} transparent opacity={0.08} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
        <Html distanceFactor={30} position={[0, 0.08, 0]} occlude>
          <span style={{ color: AMBER, fontSize: "7px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap", textShadow: "0 0 4px #000" }}>Obs</span>
        </Html>
      </group>
      <primitive object={slantLine} />
      {/* Slant-range annotation: midpoint label updated imperatively each frame */}
      <group ref={slantMidGroupRef}>
        <Html center distanceFactor={9} occlude>
          <div
            ref={slantLabelRef}
            style={{
              color: AMBER,
              fontSize: "8px",
              fontFamily: "monospace",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              whiteSpace: "nowrap",
              textShadow: "0 0 6px #000, 0 0 12px #000",
              background: "rgba(0,0,0,0.55)",
              padding: "1px 4px",
            }}
          />
        </Html>
      </group>
    </>
  );
}

/**
 * The Sun at its true position (1 AU = 23,481 Earth radii along ecliptic +X)
 * and true size (109 Earth radii), plus Earth's full heliocentric orbit — a
 * 1 AU circle around the Sun in the ecliptic plane, passing through the
 * origin. Zoom all the way out and it's all genuinely to scale.
 */
function SolAndHeliocentricOrbit() {
  // Ecliptic basis vectors in this z-up equatorial frame.
  const eclX = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  const eclY = useMemo(() => new THREE.Vector3(0, Math.cos(OBLIQUITY), Math.sin(OBLIQUITY)), []);
  const sunPos = useMemo(() => eclX.clone().multiplyScalar(AU_R), [eclX]);
  const orbitPts = useMemo(() => {
    // Circle of radius 1 AU centered on the Sun, through Earth (the origin).
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 360; i++) {
      const t = (i / 360) * 2 * Math.PI;
      pts.push(
        sunPos.clone()
          .addScaledVector(eclX, -AU_R * Math.cos(t))
          .addScaledVector(eclY, AU_R * Math.sin(t)),
      );
    }
    return pts;
  }, [sunPos, eclX, eclY]);
  return (
    <>
      {/* Earth's heliocentric orbit — looks locally straight near Earth, as it should */}
      <Line points={orbitPts} color={AMBER} transparent opacity={0.4} dashed dashSize={AU_R * 0.004} gapSize={AU_R * 0.0025} lineWidth={1} />
      <Html distanceFactor={210} position={eclY.clone().multiplyScalar(MOON_ORBIT_R).toArray()}>
        <span style={{ color: AMBER, fontSize: "7px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap", opacity: 0.9, textShadow: "0 0 4px #000" }}>Heliocentric path</span>
      </Html>
      {/* guide ray toward the Sun for close-in zoom levels */}
      <Line points={[eclX.clone().multiplyScalar(1.6), sunPos]} color={AMBER} transparent opacity={0.2} lineWidth={1} />
      <group position={sunPos.toArray()}>
        <mesh>
          <sphereGeometry args={[SUN_R, 32, 32]} />
          <meshBasicMaterial color="#ffd257" />
        </mesh>
        <mesh>
          <sphereGeometry args={[SUN_R * 3, 24, 24]} />
          <meshBasicMaterial color={AMBER} transparent opacity={0.18} depthWrite={false} />
        </mesh>
        <Html distanceFactor={210} position={[0, 0, SUN_R * 4]} occlude>
          <span style={{ color: AMBER, fontSize: "7px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap", textShadow: "0 0 4px #000" }}>Sol · 1 AU · to scale</span>
        </Html>
      </group>
      <Html distanceFactor={210} position={eclX.clone().multiplyScalar(MOON_ORBIT_R * 1.2).add(new THREE.Vector3(0, MOON_ORBIT_R * 0.05, 0)).toArray()}>
        <span style={{ color: AMBER, fontSize: "7px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap", opacity: 0.8, textShadow: "0 0 4px #000" }}>→ Sol · zoom out 390× past the Moon</span>
      </Html>
    </>
  );
}

function Scene({ el, clock, observer, satPosRef, telemetryRef }: {
  el: Elements | null;
  clock: SimClock;
  observer: { lat: number; lon: number } | null;
  satPosRef: React.MutableRefObject<THREE.Vector3>;
  telemetryRef: React.MutableRefObject<Telemetry>;
}) {
  const orbitPts = useMemo(() => (el ? orbitCurve(el) : null), [el]);
  return (
    <>
      <SimDriver clock={clock} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[100, 0, 20]} intensity={1.6} color="#fff4d6" />
      <Stars radius={AU_R * 3.2} depth={AU_R * 0.5} count={2500} factor={AU_R * 0.012} saturation={0} fade speed={0.4} />
      <Earth clock={clock} />
      {/* GEO belt reference */}
      <Line points={ringPoints(GEO_R, 0)} color={DIM} transparent opacity={0.6} dashed dashSize={0.5} gapSize={0.5} lineWidth={1} />
      {orbitPts && el && (
        <>
          <Line points={orbitPts} color={GREEN} lineWidth={1.5} />
          <Satellite el={el} clock={clock} satPosRef={satPosRef} />
          {observer && (
            <ObserverRig observer={observer} clock={clock} el={el} satPosRef={satPosRef} telemetryRef={telemetryRef} />
          )}
        </>
      )}
      <Moon clock={clock} />
      <SolAndHeliocentricOrbit />
    </>
  );
}

const RANGE_OPTIONS = [
  { value: String(30 * 60_000), label: "± 30 min" },
  { value: String(2 * 3600_000), label: "± 2 h" },
  { value: String(12 * 3600_000), label: "± 12 h" },
  { value: String(24 * 3600_000), label: "± 24 h" },
  { value: String(7 * 86400_000), label: "± 7 d" },
] as const;

function fmtSimTime(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19).replace("T", " ") + "Z" : "---";
}

export default function OrbitViewer3D({ apogeeKm, perigeeKm, incDeg, name, tle, observer, passWindow, onExitPassMode }: {
  apogeeKm?: number | null;
  perigeeKm?: number | null;
  incDeg?: number | null;
  name?: string;
  tle?: TleInfo | null;
  /** Ground station for the visibility cone + slant vector (lat/lon deg). */
  observer?: { lat: number; lon: number } | null;
  /** When set (a pass row was clicked), slew+freeze time and clamp the slider to the window. */
  passWindow?: PassWindow | null;
  onExitPassMode?: () => void;
}) {
  const el = useMemo(() => {
    if (tle) {
      const fromTle = elementsFromTle(tle);
      if (fromTle) return fromTle;
    }
    return apogeeKm != null && perigeeKm != null
      ? elementsFrom(apogeeKm, perigeeKm, incDeg ?? 0)
      : null;
  }, [apogeeKm, perigeeKm, incDeg, tle]);
  const hasTle = !!el?.tle;

  // ── shared sim clock ──────────────────────────────────────────────────
  const clockRef = useRef<SimClock>({ ms: Date.now(), playing: true, rate: DEFAULT_RATE });
  const anchorRef = useRef(Date.now()); // slider center in free-run mode
  const satPosRef = useRef(new THREE.Vector3());
  const telemetryRef = useRef<Telemetry>({ valid: false, azDeg: 0, elDeg: 0, rangeKm: 0 });

  const [playing, setPlaying] = useState(true);
  const [rangeMs, setRangeMs] = useState(String(2 * 3600_000));
  // Mirror for the interval-based re-center check (avoids re-subscribing the interval).
  const rangeMsRef = useRef(rangeMs);
  useEffect(() => { rangeMsRef.current = rangeMs; }, [rangeMs]);
  const [dispMs, setDispMs] = useState(() => clockRef.current.ms);
  const [telemetry, setTelemetry] = useState<Telemetry>(telemetryRef.current);

  const inPassMode = !!passWindow;

  // Slew + freeze when a pass is selected; return to live free-run when cleared.
  useEffect(() => {
    const c = clockRef.current;
    if (passWindow) {
      c.ms = passWindow.startMs;
      c.minMs = passWindow.startMs;
      c.maxMs = passWindow.endMs;
      c.rate = PASS_RATE;
      c.playing = false;
      setPlaying(false);
    } else {
      c.minMs = undefined;
      c.maxMs = undefined;
      c.rate = DEFAULT_RATE;
      c.ms = Date.now();
      anchorRef.current = Date.now();
      c.playing = true;
      setPlaying(true);
    }
    setDispMs(c.ms);
  }, [passWindow?.startMs, passWindow?.endMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Low-frequency UI sync from the render-loop clock/telemetry refs.
  useEffect(() => {
    const id = setInterval(() => {
      // Free-run mode: as sim time approaches the edge of the slider window,
      // re-center the window on the current sim time so the thumb never
      // stays pinned at an edge during long accelerated sessions. (Pass mode
      // keeps its clamped window and is skipped here.)
      const c = clockRef.current;
      if (c.minMs == null && c.maxMs == null) {
        const half = Number(rangeMsRef.current);
        if (Number.isFinite(half) && half > 0) {
          const edge = half * 0.05; // within 5% of the window edge
          if (Math.abs(c.ms - anchorRef.current) >= half - edge) {
            anchorRef.current = c.ms;
          }
        }
      }
      setDispMs(clockRef.current.ms);
      if (clockRef.current.playing !== undefined) setPlaying(clockRef.current.playing);
      const t = telemetryRef.current;
      setTelemetry((prev) =>
        prev.valid !== t.valid || Math.abs(prev.rangeKm - t.rangeKm) > 0.5 ||
        Math.abs(prev.azDeg - t.azDeg) > 0.05 || Math.abs(prev.elDeg - t.elDeg) > 0.05
          ? { ...t } : prev);
    }, 200);
    return () => clearInterval(id);
  }, []);

  const togglePlay = useCallback(() => {
    const c = clockRef.current;
    // Un-pausing at the end of a pass window replays from the start.
    if (!c.playing && c.maxMs != null && c.ms >= c.maxMs) c.ms = c.minMs ?? c.ms;
    c.playing = !c.playing;
    setPlaying(c.playing);
  }, []);

  /** Snap the sim clock back to the current real time and resume playback. */
  const goToNow = useCallback(() => {
    const now = Date.now();
    const c = clockRef.current;
    c.ms = now;
    anchorRef.current = now;
    c.playing = true;
    setPlaying(true);
    setDispMs(now);
  }, []);

  const onSlider = useCallback((v: number) => {
    clockRef.current.ms = v;
    setDispMs(v);
  }, []);

  const sliderMin = inPassMode ? passWindow!.startMs : anchorRef.current - Number(rangeMs);
  const sliderMax = inPassMode ? passWindow!.endMs : anchorRef.current + Number(rangeMs);
  const sliderVal = Math.min(sliderMax, Math.max(sliderMin, dispMs));

  // Frame the target orbit; if none, frame the Earth-Moon system.
  // Deep-space objects can have apogees in the millions of km — cap the
  // initial framing so Earth stays visible, and scale the camera limits to
  // the orbit instead of leaving the camera outside its own clamps.
  const apoR = el ? el.a * (1 + el.e) : 0;
  const camDist = el
    ? Math.min(Math.max(3.2, apoR * 2.6), MOON_ORBIT_R * 20)
    : MOON_ORBIT_R * 1.6;
  // Allow zooming out far enough to see the Sun and Earth's full 1 AU orbit.
  const maxZoomOut = Math.max(AU_R * 2.6, camDist * 1.5);
  const farPlane = maxZoomOut * 4;

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
    <div className="relative w-full h-full min-h-[260px] sm:min-h-[340px] bg-black/70 overflow-hidden">
      <Canvas
        camera={{ position: [camDist * 0.55, -camDist * 0.75, camDist * 0.45], up: [0, 0, 1], fov: 45, near: 0.05, far: farPlane }}
        gl={{ antialias: true, logarithmicDepthBuffer: true }}
        dpr={[1, 1.75]}
      >
        <Scene el={el} clock={clockRef.current} observer={observer ?? null} satPosRef={satPosRef} telemetryRef={telemetryRef} />
        {/* zoomSpeed cranked up: the trip from LEO to 1 AU spans 4+ orders of magnitude */}
        <OrbitControls enablePan={false} minDistance={1.4} maxDistance={maxZoomOut} zoomSpeed={2.4} />
      </Canvas>

      {/* HUD */}
      <div className="pointer-events-none absolute top-2 left-3 font-mono text-[9px] sm:text-[10px] uppercase tracking-widest text-primary/90">
        <div className="text-primary font-bold">ECI FRAME · EARTH-ORBIT GEOMETRY TO SCALE</div>
        {name && <div className="text-muted-foreground normal-case">{name}</div>}
      </div>
      <div className="pointer-events-none absolute top-2 right-3 text-right font-mono text-[9px] sm:text-[10px] uppercase tracking-widest">
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
      <div className={`pointer-events-none absolute bottom-12 right-3 font-mono text-[8px] sm:text-[9px] uppercase tracking-widest ${hasTle ? "text-primary/80" : "text-muted-foreground/60"} max-w-[55vw] sm:max-w-none truncate sm:truncate-none text-right`}>
        {hasTle
          ? `LIVE TLE · RAAN ${tle!.raanDeg.toFixed(1)}° · ARG-PE ${tle!.argPerigeeDeg.toFixed(1)}° · EPOCH ${tle!.epoch.replace("T", " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "")}Z`
          : "RAAN / ARG-PE not catalogued — drawn at 0°"}
      </div>
      <div className="pointer-events-none absolute bottom-12 left-3 font-mono text-[8px] sm:text-[9px] uppercase tracking-widest text-muted-foreground/80 hidden sm:block">
        Drag to rotate · Zoom out past the Moon to the Sun at 1 AU · all to scale
      </div>

      {/* Time controls */}
      <div className="absolute bottom-0 inset-x-0 flex items-center gap-1.5 px-2 sm:px-3 py-1.5 bg-black/60 border-t border-border/40 font-mono text-[9px] uppercase tracking-widest">
        <Button
          type="button" variant="outline" size="sm" onClick={togglePlay}
          className="h-6 px-2 rounded-none border-primary/60 text-primary hover:bg-primary hover:text-primary-foreground flex-shrink-0"
          title={playing ? "Freeze simulation time" : "Resume simulation"}
        >
          {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
        </Button>
        {!inPassMode && (
          <Button
            type="button" variant="outline" size="sm" onClick={goToNow}
            className="h-6 px-2 rounded-none border-primary/40 text-primary/80 hover:bg-primary hover:text-primary-foreground font-mono text-[9px] uppercase tracking-widest"
            title="Snap simulation clock back to real time now"
          >
            Now
          </Button>
        )}
        <input
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={1000}
          value={sliderVal}
          onChange={(e) => onSlider(Number(e.target.value))}
          className="flex-1 min-w-0 h-1 accent-[#22ff88] cursor-pointer"
          aria-label="Simulation time"
        />
        {inPassMode ? (
          <>
            <span className="text-chart-4 whitespace-nowrap hidden sm:inline">Pass window</span>
            <Button
              type="button" variant="outline" size="sm"
              onClick={() => onExitPassMode?.()}
              className="h-6 px-2 rounded-none border-border text-muted-foreground hover:text-primary flex-shrink-0"
              title="Leave pass replay and return to live time"
            >
              <RadioTower className="w-3 h-3 sm:mr-1" /><span className="hidden sm:inline">Live</span>
            </Button>
          </>
        ) : (
          <Select value={rangeMs} onValueChange={(v) => { setRangeMs(v); anchorRef.current = Date.now(); }}>
            <SelectTrigger className="h-6 w-[72px] sm:w-[96px] rounded-none border-border bg-background/80 uppercase text-[9px] font-mono flex-shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-none">
              {RANGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs font-mono uppercase">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-primary/90 whitespace-nowrap tabular-nums hidden sm:inline">{fmtSimTime(dispMs)}</span>
        <span className="text-primary/90 whitespace-nowrap tabular-nums sm:hidden text-[8px]">{fmtSimTime(dispMs).slice(11, 19)}Z</span>
        <span className="text-muted-foreground/70 whitespace-nowrap flex-shrink-0">{playing ? `${clockRef.current.rate}×` : "❙❙"}</span>
      </div>

      {/* scanline wash to stay in theme */}
      <div className="pointer-events-none absolute inset-0" style={{ background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 3px)" }} />
    </div>
  );
}
