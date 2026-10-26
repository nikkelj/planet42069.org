import { useEffect, useMemo, useRef, useState } from "react";
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, CanvasTexture, Color, Mesh, MeshBasicMaterial,
  PerspectiveCamera, Points, PointsMaterial, Scene, ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial,
  GreaterDepth, SRGBColorSpace, Texture, TextureLoader, Vector2, Vector3, WebGLRenderer, Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/* ------------------------------------------------------------------ data */
type Pt = [number, number, number, number]; // t_s, lat, lon, alt_km
interface LaunchEntry {
  slug: string; name: string; vehicle: string; t0_utc: string; status: string;
  phase: "recent" | "upcoming" | string;
  files: Record<string, string>;
}
interface Track { surrogate?: Pt[]; sim?: Pt[] }
interface Loaded extends LaunchEntry { track: Track; color: string }
type Method = "surrogate" | "sim" | "both";

const COLORS = ["#ff4455", "#22ddff", "#ffb020", "#c77dff", "#7dffb2", "#ff7de2", "#a4ff4f", "#4f9dff"];
const D2R = Math.PI / 180;
const RE = 6371;
const TEX = "/launches/globe/";

/** Matches three's SphereGeometry equirectangular UVs (u=0 at lon -180). */
function llr(lat: number, lon: number, r: number, out = new Vector3()) {
  const phi = (90 - lat) * D2R, th = (lon + 180) * D2R;
  return out.set(-Math.sin(phi) * Math.cos(th) * r, Math.cos(phi) * r, Math.sin(phi) * Math.sin(th) * r);
}

/** Low-precision sun direction (subsolar point), good to ~1°. */
function sunDir(d: Date) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const doy = (d.getTime() - start) / 86400000;
  const g = (2 * Math.PI / 365) * (doy - 1);
  const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (doy + 10));
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const lon = -(utcMin + eot - 720) / 4;
  return llr(decl, lon, 1).normalize();
}

const fmtT0 = (s: string) =>
  new Date(s).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

/* --------------------------------------------------------------- shaders */
const earthVS = `
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){ vUv=uv; vN=normalize(mat3(modelMatrix)*normal); vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz;
gl_Position=projectionMatrix*viewMatrix*w; }`;
const earthFS = `
uniform sampler2D dayMap; uniform sampler2D nightMap; uniform vec3 sunDir; uniform vec3 camPos;
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){
  vec3 N=normalize(vN); vec3 V=normalize(camPos-vW); vec3 L=normalize(sunDir);
  vec3 day=texture2D(dayMap,vUv).rgb; vec3 night=texture2D(nightMap,vUv).rgb;
  float d=dot(N,L); float k=smoothstep(-0.12,0.18,d);
  vec3 lit=day*(0.06+1.15*max(d,0.0));
  vec3 lights=night*vec3(1.6,1.25,0.85)*(1.0-k);
  float ocean=smoothstep(0.0,0.06,day.b-max(day.r,day.g)*0.85);
  float spec=pow(max(dot(reflect(-L,N),V),0.0),48.0)*ocean*0.55*k;
  float fres=pow(1.0-max(dot(N,V),0.0),3.0);
  vec3 col=lit+lights+vec3(spec)*vec3(1.0,0.95,0.85)+fres*vec3(0.25,0.55,1.0)*(0.15+0.85*k);
  gl_FragColor=vec4(col,1.0);
  #include <colorspace_fragment>
}`;
const atmoVS = `
varying vec3 vN; varying vec3 vW;
void main(){ vN=normalize(mat3(modelMatrix)*normal); vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const atmoFS = `
uniform vec3 sunDir; uniform vec3 camPos; varying vec3 vN; varying vec3 vW;
void main(){ vec3 N=normalize(vN); vec3 V=normalize(camPos-vW);
  float i=pow(max(0.0,0.62+dot(N,V)),3.0)*2.2;
  float lit=0.25+0.75*smoothstep(-0.3,0.4,dot(N,normalize(sunDir)));
  gl_FragColor=vec4(vec3(0.3,0.6,1.0)*i*lit*1.4,1.0); }`;

function glowSprite(color: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.2, color);
  gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------- component */
export default function LaunchGlobeCanvas({ indexUrl }: { indexUrl: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [launches, setLaunches] = useState<Loaded[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState<Method>("sim");
  const [exag, setExag] = useState(false);
  const reduced = useMemo(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [comet, setComet] = useState(!reduced);
  const [tip, setTip] = useState<{ x: number; y: number; html: string[] } | null>(null);
  const api = useRef<{ rebuild: () => void } | null>(null);
  const opts = useRef({ hidden, method, exag, comet });
  opts.current = { hidden, method, exag, comet };

  // fetch manifest + decimated tracks (~8 KB each); never the full CSVs
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const idx = await (await fetch(indexUrl)).json();
        const ls: LaunchEntry[] = (idx.launches || []).filter((l: LaunchEntry) => l.files?.track_lite);
        const out = await Promise.all(ls.map(async (l, i) => ({
          ...l, color: COLORS[i % COLORS.length], track: (await (await fetch(l.files.track_lite)).json()) as Track,
        })));
        out.sort((a, b) => a.t0_utc.localeCompare(b.t0_utc));
        if (!dead) setLaunches(out);
      } catch (e) {
        if (!dead) setErr(String(e));
      }
    })();
    return () => { dead = true; };
  }, [indexUrl]);

  // three.js scene, built once per data load
  useEffect(() => {
    const el = host.current;
    if (!el || !launches) return;
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.domElement.style.display = "block";
    el.appendChild(renderer.domElement);
    const scene = new Scene();
    const camera = new PerspectiveCamera(38, el.clientWidth / el.clientHeight, 0.01, 200);
    const sun = sunDir(new Date());

    // stars
    const N = 2600, sp = new Float32Array(N * 3), sc = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const v = new Vector3().randomDirection().multiplyScalar(60);
      sp.set([v.x, v.y, v.z], i * 3);
      const b = 0.35 + Math.random() ** 3 * 0.65, w = Math.random();
      sc.set([b * (0.85 + 0.15 * w), b * 0.92, b * (1.05 - 0.15 * w)], i * 3);
    }
    const sg = new BufferGeometry();
    sg.setAttribute("position", new BufferAttribute(sp, 3));
    sg.setAttribute("color", new BufferAttribute(sc, 3));
    scene.add(new Points(sg, new PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9 })));

    // earth (progressive textures: 512px placeholder -> 4K WebP)
    const loader = new TextureLoader();
    const prep = (t: Texture) => { t.colorSpace = SRGBColorSpace; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); return t; };
    const uni = {
      dayMap: { value: prep(loader.load(TEX + "earth_day_512.webp", () => req())) as Texture },
      nightMap: { value: prep(loader.load(TEX + "earth_night_512.webp", () => req())) as Texture },
      sunDir: { value: sun }, camPos: { value: new Vector3() },
    };
    const swapIn = (key: "dayMap" | "nightMap", file: string) =>
      loader.load(TEX + file, (t) => { const old = uni[key].value; uni[key].value = prep(t); old.dispose(); req(); });
    swapIn("dayMap", "earth_day_4k.webp");
    swapIn("nightMap", "earth_night_4k.webp");
    const earth = new Mesh(new SphereGeometry(1, 160, 96), new ShaderMaterial({ uniforms: uni, vertexShader: earthVS, fragmentShader: earthFS }));
    scene.add(earth);
    const atmo = new Mesh(new SphereGeometry(1.025, 96, 64), new ShaderMaterial({
      uniforms: { sunDir: uni.sunDir, camPos: uni.camPos }, vertexShader: atmoVS, fragmentShader: atmoFS,
      side: BackSide, blending: AdditiveBlending, transparent: true, depthWrite: false,
    }));
    scene.add(atmo);

    // initial view: centroid of pads
    const c = new Vector3();
    launches.forEach((l) => { const p = (l.track.sim || l.track.surrogate)![0]; c.add(llr(p[1], p[2], 1)); });
    camera.position.copy(c.normalize().multiplyScalar(3.4)).add(new Vector3(0, 0.6, 0));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false;
    controls.minDistance = 1.25; controls.maxDistance = 8; controls.rotateSpeed = 0.5; controls.zoomSpeed = 0.7;

    // tracks
    const group = new Object3D();
    scene.add(group);
    const res = new Vector2(el.clientWidth, el.clientHeight);
    const mats: LineMaterial[] = [];
    let comets: { s: Sprite; pts: Vector3[] }[] = [];
    let pick: { p: Vector3; l: Loaded; m: string; pt: Pt }[] = [];
    const sprites = new Map<string, Texture>();
    const disposeGroup = () => {
      group.traverse((o) => {
        const any = o as unknown as { geometry?: BufferGeometry; material?: { dispose(): void } };
        any.geometry?.dispose(); if (!(o instanceof Sprite)) any.material?.dispose();
        if (o instanceof Sprite) o.material.dispose();
      });
      group.clear(); mats.length = 0;
    };
    const rebuild = () => {
      disposeGroup(); comets = []; pick = [];
      const { hidden, method, exag } = opts.current;
      const k = exag ? 8 : 1;
      for (const l of launches) {
        if (hidden[l.slug]) continue;
        const sets: [string, Pt[] | undefined][] =
          method === "both" ? [["sim", l.track.sim], ["surrogate", l.track.surrogate]] : [[method, l.track[method]]];
        const upcoming = l.phase === "upcoming";
        sets.forEach(([m, pts], si) => {
          if (!pts?.length) return;
          const positions = new Float32Array(pts.length * 3);
          const v: Vector3[] = new Array(pts.length);
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const at = llr(p[1], p[2], 1 + (p[3] / RE) * k + 0.0015);
            positions[i * 3] = at.x; positions[i * 3 + 1] = at.y; positions[i * 3 + 2] = at.z;
            v[i] = at;
          }
          const col = new Color(l.color);
          if (si === 1) col.lerp(new Color("#ffffff"), 0.45);
          // The post-insertion coast is often behind the earth from the default
          // camera (Starlink 15-16 leaves the limb at SECO-1). A GreaterDepth
          // pass draws that occluded arc over the disk; the near pass stays in front.
          for (const far of [true, false]) {
            for (const [w, op, glow] of [[7, 0.2, true], [2.2, 1, false]] as const) {
              const g = new LineGeometry(); g.setPositions(positions);
              const mat = new LineMaterial({
                color: col.getHex(), linewidth: si === 1 ? w * 0.6 : w, transparent: true,
                opacity: (si === 1 ? op * 0.8 : op) * (far ? 0.72 : 1),
                ...(glow ? { blending: AdditiveBlending } : {}),
                depthWrite: far ? false : !glow,
                depthTest: true,
                ...(far ? { depthFunc: GreaterDepth } : {}),
                dashed: upcoming && !glow, dashSize: 0.018, gapSize: 0.012, worldUnits: false,
              });
              mat.resolution.copy(res); mats.push(mat);
              const line = new Line2(g, mat);
              line.frustumCulled = false;
              line.renderOrder = far ? 1 : 2;
              if (upcoming && !glow) line.computeLineDistances();
              group.add(line);
            }
          }
          v.forEach((p, i) => pick.push({ p, l, m, pt: pts[i] }));
          if (si === 0) {
            if (!sprites.has(l.color)) sprites.set(l.color, glowSprite(l.color));
            const s = new Sprite(new SpriteMaterial({ map: sprites.get(l.color)!, blending: AdditiveBlending, depthWrite: false, transparent: true }));
            s.scale.setScalar(0.06); s.visible = opts.current.comet; s.position.copy(v[v.length - 1]); s.renderOrder = 4;
            group.add(s); comets.push({ s, pts: v });
            const pad = new Mesh(new SphereGeometry(0.009, 16, 12), new MeshBasicMaterial({ color: l.color }));
            pad.position.copy(llr(pts[0][1], pts[0][2], 1.002)); pad.renderOrder = 4; group.add(pad);
            const halo = new Sprite(new SpriteMaterial({ map: sprites.get(l.color)!, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7 }));
            halo.scale.setScalar(0.045); halo.position.copy(pad.position); halo.renderOrder = 4; group.add(halo);
          }
        });
      }
      req();
    };

    // render on demand
    let raf = 0, visible = true, onScreen = true;
    const t0 = performance.now();
    const frame = () => {
      raf = 0;
      if (!visible || !onScreen) return;
      const moving = controls.update();
      const animating = opts.current.comet && comets.length > 0;
      if (animating) {
        const f = ((performance.now() - t0) / 9000) % 1;
        for (const { s, pts } of comets) {
          const x = f * (pts.length - 1), i = Math.floor(x);
          s.position.copy(pts[i]).lerp(pts[Math.min(i + 1, pts.length - 1)], x - i);
        }
      }
      uni.camPos.value.copy(camera.position);
      renderer.render(scene, camera);
      if (moving || animating) req();
    };
    function req() { if (!raf) raf = requestAnimationFrame(frame); }
    controls.addEventListener("change", req);
    controls.addEventListener("start", req);

    const onVis = () => { visible = document.visibilityState === "visible"; if (visible) req(); };
    document.addEventListener("visibilitychange", onVis);
    const io = new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; if (onScreen) req(); });
    io.observe(el);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
      res.set(w, h); mats.forEach((m) => m.resolution.copy(res)); req();
    });
    ro.observe(el);

    // hover / tap tooltip: nearest visible track point in screen space
    const tmp = new Vector3();
    const onMove = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let best: (typeof pick)[number] | null = null, bd = 14 * 14;
      for (const it of pick) {
        if (it.p.dot(camera.position) < 1.0) continue; // behind the limb
        tmp.copy(it.p).project(camera);
        const sx = (tmp.x + 1) / 2 * r.width, sy = (1 - tmp.y) / 2 * r.height;
        const d = (sx - mx) ** 2 + (sy - my) ** 2;
        if (d < bd) { bd = d; best = it; }
      }
      setTip(best ? { x: mx, y: my, html: [
        best.l.name, `${best.l.vehicle} · ${best.l.phase === "upcoming" ? "NET" : "T0"} ${fmtT0(best.l.t0_utc)}`,
        `T+${best.pt[0].toFixed(0)} s · ${best.pt[3].toFixed(1)} km · ${best.m === "sim" ? "3DOF sim" : "surrogate"}`,
      ] } : null);
    };
    const onLeave = () => setTip(null);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onMove);
    renderer.domElement.addEventListener("pointerleave", onLeave);

    api.current = { rebuild };
    rebuild();

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect(); ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onMove);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      controls.dispose(); disposeGroup();
      sprites.forEach((t) => t.dispose());
      scene.traverse((o) => {
        const any = o as unknown as { geometry?: BufferGeometry; material?: { dispose(): void } };
        any.geometry?.dispose(); any.material?.dispose();
      });
      uni.dayMap.value.dispose(); uni.nightMap.value.dispose();
      renderer.dispose(); renderer.forceContextLoss();
      renderer.domElement.remove();
      api.current = null;
    };
  }, [launches]);

  useEffect(() => { api.current?.rebuild(); }, [hidden, method, exag, comet]);

  if (err) return <div className="p-6 font-mono text-xs uppercase tracking-widest text-destructive">Globe offline: {err}</div>;

  const btn = (on: boolean) =>
    `px-2 py-0.5 border ${on ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="absolute inset-0">
      <div ref={host} className="absolute inset-0 cursor-grab active:cursor-grabbing" />
      {launches && (
        <div className="absolute top-2 left-2 max-w-[min(340px,70%)] bg-black/65 backdrop-blur-sm border border-border p-2 font-mono text-[10px] uppercase tracking-wider space-y-1.5 select-none">
          {launches.map((l) => (
            <label key={l.slug} className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-0.5 accent-current" style={{ color: l.color }} checked={!hidden[l.slug]}
                onChange={() => setHidden((h) => ({ ...h, [l.slug]: !h[l.slug] }))} />
              <svg width="22" height="8" className="mt-1 shrink-0"><line x1="0" y1="4" x2="22" y2="4" stroke={l.color} strokeWidth="2.5" strokeDasharray={l.phase === "upcoming" ? "4 3" : undefined} /></svg>
              <span className={hidden[l.slug] ? "opacity-40" : ""}>
                <span className="text-foreground normal-case">{l.vehicle}</span>{" "}
                <span className={l.phase === "upcoming" ? "text-accent" : "text-muted-foreground"}>· {l.phase}</span>
                <br /><span className="text-muted-foreground normal-case">{fmtT0(l.t0_utc)}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="absolute top-2 right-2 flex flex-col items-end gap-1 font-mono text-[10px] uppercase tracking-wider">
        <div className="flex gap-1 bg-black/60 p-1 border border-border">
          {(["surrogate", "sim", "both"] as Method[]).map((m) => (
            <button key={m} type="button" className={btn(method === m)} onClick={() => setMethod(m)}>{m === "sim" ? "3DOF sim" : m}</button>
          ))}
        </div>
        <div className="flex gap-1 bg-black/60 p-1 border border-border">
          <button type="button" className={btn(exag)} onClick={() => setExag(true)}>alt ×8</button>
          <button type="button" className={btn(!exag)} onClick={() => setExag(false)}>true alt</button>
          <button type="button" className={btn(comet)} onClick={() => setComet((c) => !c)}>{comet ? "❚❚ trace" : "▶ trace"}</button>
        </div>
      </div>
      <div className="absolute bottom-2 left-2 right-2 flex flex-wrap justify-between gap-2 font-mono text-[9px] uppercase tracking-widest text-muted-foreground pointer-events-none">
        <span className="text-accent">ILLUSTRATIVE trajectories — not telemetry · full arc through deploy or +2 revs · dim = far side · solid = flown · dashed = upcoming</span>
        <span>Day/night for now · Earth: NASA Blue Marble NG / Black Marble 2016</span>
      </div>
      {tip && (
        <div className="absolute pointer-events-none bg-black/85 border border-primary px-2 py-1 font-mono text-[10px] leading-snug"
          style={{ left: tip.x + 14, top: tip.y + 10 }}>
          <div className="text-primary">{tip.html[0]}</div>
          <div className="text-foreground">{tip.html[1]}</div>
          <div className="text-muted-foreground">{tip.html[2]}</div>
        </div>
      )}
    </div>
  );
}
