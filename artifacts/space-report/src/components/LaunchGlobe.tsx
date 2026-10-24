import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import worldOutlines from "./world-outlines.json";
import {
  EARTH_RADIUS_KM,
  sampleAt,
  type TrajectorySample,
  type TrackId,
} from "@/lib/trajectory";

/**
 * Ascent on a z-up globe. ECEF kilometres map straight into the scene
 * (x, y, z), scaled by the WGS-84 equatorial radius, so the path sits at
 * true geocentric altitude. Same frame as the orbit viewer.
 */

const coasts = (() => {
  const verts: number[] = [];
  const R = 1.002;
  const D2R = Math.PI / 180;
  for (const ring of worldOutlines as [number, number][][]) {
    let prev: [number, number, number] | null = null;
    for (const [lon, lat] of ring) {
      const cl = Math.cos(lat * D2R);
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

function scenePoint(sample: TrajectorySample, surface: boolean): [number, number, number] {
  const x = sample.xEcefKm / EARTH_RADIUS_KM;
  const y = sample.yEcefKm / EARTH_RADIUS_KM;
  const z = sample.zEcefKm / EARTH_RADIUS_KM;
  if (!surface) return [x, y, z];
  const len = Math.hypot(x, y, z) || 1;
  const k = 1.002 / len;
  return [x * k, y * k, z * k];
}

function vlen(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function vnorm(v: [number, number, number]): [number, number, number] {
  const len = vlen(v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function vadd(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vmul(v: [number, number, number], k: number): [number, number, number] {
  return [v[0] * k, v[1] * k, v[2] * k];
}

function vdot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vcross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Look across the ascent, not down the local vertical. From overhead, a few
 * hundred kilometres of true altitude is only a depth offset; from the side
 * it is the gap between the surface trace and the path.
 */
function frameCamera(tracks: TrajectorySample[][]): {
  position: [number, number, number];
  target: [number, number, number];
} {
  const runs = tracks.filter((samples) => samples.length >= 2);
  const primary = runs[0];
  if (!primary) return { position: [1.2, -1.6, 0.9], target: [0, 0, 0] };
  const start = scenePoint(primary[0]!, false);
  const mid = scenePoint(primary[Math.floor(primary.length / 2)]!, false);
  const end = scenePoint(primary[primary.length - 1]!, false);
  const out = vnorm(mid);
  let along = vadd(end, vmul(start, -1));
  along = vadd(along, vmul(out, -vdot(along, out)));
  if (vlen(along) < 1e-4) along = [0, 1, 0];
  along = vnorm(along);
  const side = vnorm(vcross(out, along));
  const target = vmul(out, 1.02);
  const position = vadd(vadd(vmul(out, 1.4), vmul(side, 0.9)), vmul(along, -0.15));
  return { position, target };
}

function TrackLines({ samples, color }: { samples: TrajectorySample[]; color: string }) {
  const aloft = useMemo(() => samples.map((s) => scenePoint(s, false)), [samples]);
  const surface = useMemo(() => samples.map((s) => scenePoint(s, true)), [samples]);
  const spokes = useMemo(() => {
    const step = Math.max(1, Math.floor(samples.length / 8));
    const picked: [number, number, number][][] = [];
    for (let i = 0; i < samples.length; i += step) {
      const sample = samples[i]!;
      picked.push([scenePoint(sample, true), scenePoint(sample, false)]);
    }
    const last = samples[samples.length - 1];
    if (last) picked.push([scenePoint(last, true), scenePoint(last, false)]);
    return picked;
  }, [samples]);
  if (samples.length < 2) return null;
  return (
    <group>
      <Line points={surface} color={color} lineWidth={1} transparent opacity={0.45} />
      <Line points={aloft} color={color} lineWidth={2.5} />
      {spokes.map((points, i) => (
        <Line key={i} points={points} color={color} lineWidth={1} transparent opacity={0.55} />
      ))}
    </group>
  );
}

function ScrubMarker({ sample, color }: { sample: TrajectorySample; color: string }) {
  const aloft = scenePoint(sample, false);
  const surface = scenePoint(sample, true);
  return (
    <group>
      <Line points={[surface, aloft]} color={color} lineWidth={1.25} transparent opacity={0.9} />
      <mesh position={aloft}>
        <sphereGeometry args={[0.011, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

export default function LaunchGlobe({
  tracks,
  elapsedS,
}: {
  tracks: { id: TrackId; color: string; samples: TrajectorySample[] }[];
  elapsedS: number;
}) {
  // Re-frame only when the set of tracks changes, not on every scrub tick.
  const frameKey = tracks.map((track) => `${track.id}:${track.samples.length}`).join("|");
  const frame = useMemo(
    () => frameCamera(tracks.map((track) => track.samples)),
    // frameKey captures the track set; samples are read from the render that changed it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frameKey],
  );

  return (
    <div data-testid="launch-globe" className="relative h-[420px] w-full bg-black">
      <Canvas
        camera={{ position: frame.position, up: [0, 0, 1], fov: 36, near: 0.01, far: 50 }}
        gl={{ antialias: true }}
        dpr={[1, 1.75]}
      >
        <color attach="background" args={["#02060a"]} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[5, -2, 4]} intensity={1.15} />
        <mesh>
          <sphereGeometry args={[1, 64, 64]} />
          <meshStandardMaterial color="#07140f" roughness={1} metalness={0} />
        </mesh>
        <lineSegments geometry={coasts}>
          <lineBasicMaterial color="#1f8f6a" transparent opacity={0.75} />
        </lineSegments>
        {tracks.map((track) => (
          <TrackLines key={track.id} samples={track.samples} color={track.color} />
        ))}
        {tracks.map((track) => {
          const at = sampleAt(track.samples, elapsedS);
          return at ? <ScrubMarker key={`${track.id}-mark`} sample={at} color={track.color} /> : null;
        })}
        <OrbitControls enablePan={false} minDistance={0.15} maxDistance={8} target={frame.target} />
      </Canvas>
      <p className="pointer-events-none absolute bottom-2 left-2 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
        Drag to rotate · scroll to zoom · altitude to scale
      </p>
    </div>
  );
}
