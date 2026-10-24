import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import worldOutlines from "./world-outlines.json";
import { Badge } from "@/components/ui/badge";
import {
  TRACK_COLORS,
  groundTrackBox,
  loadTrajectoryCsv,
  maxAltitude,
  maxElapsed,
  sampleAt,
  splitAtDateline,
  type TrackId,
  type TrajectorySample,
} from "@/lib/trajectory";

const LaunchGlobe = lazy(() => import("@/components/LaunchGlobe"));

const TRACK_LABEL: Record<TrackId, string> = {
  surrogate: "Surrogate",
  sim: "3DOF sim",
};

interface TrackState {
  id: TrackId;
  samples: TrajectorySample[] | null;
  failed: boolean;
}

function formatElapsed(seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return m > 0 ? `T+ ${m}m ${String(s).padStart(2, "0")}s` : `T+ ${s}s`;
}

function GroundTrack({
  tracks,
  elapsedS,
}: {
  tracks: { id: TrackId; color: string; samples: TrajectorySample[] }[];
  elapsedS: number;
}) {
  const samples = tracks.flatMap((track) => track.samples);
  const box = useMemo(() => groundTrackBox(samples), [samples]);
  const width = Math.max(1, box.maxLon - box.minLon);
  const height = Math.max(1, box.maxLat - box.minLat);
  const outlines = useMemo(
    () =>
      (worldOutlines as [number, number][][]).map((ring) =>
        ring.map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${lon},${-lat}`).join(" "),
      ),
    [],
  );
  const step = width > 80 ? 30 : width > 30 ? 10 : 5;

  return (
    <svg
      data-testid="ground-track"
      viewBox={`${box.minLon} ${-box.maxLat} ${width} ${height}`}
      className="h-auto w-full bg-[#02060a]"
      role="img"
      aria-label="Ground track of the ascent on an equirectangular world map"
    >
      {outlines.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="#1f8f6a" strokeOpacity={0.55} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
      ))}
      {Array.from({ length: Math.floor((box.maxLat - box.minLat) / step) + 2 }, (_, i) => {
        const lat = Math.ceil(box.minLat / step) * step + i * step;
        if (lat < box.minLat || lat > box.maxLat) return null;
        return (
          <line key={`lat${lat}`} x1={box.minLon} x2={box.maxLon} y1={-lat} y2={-lat} stroke="#1a4a44" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        );
      })}
      {tracks.map((track) =>
        splitAtDateline(track.samples).map((segment, i) => {
          if (segment.length < 2) return null;
          const d = segment.map((s, n) => `${n === 0 ? "M" : "L"}${s.lonDeg},${-s.latDeg}`).join(" ");
          return (
            <path
              key={`${track.id}-${i}`}
              data-testid={`ground-track-${track.id}`}
              d={d}
              fill="none"
              stroke={track.color}
              strokeWidth={2.25}
              vectorEffect="non-scaling-stroke"
            />
          );
        }),
      )}
      {tracks.map((track) => {
        const at = sampleAt(track.samples, elapsedS);
        if (!at) return null;
        const r = Math.min(width, height) * 0.018;
        return <circle key={`${track.id}-now`} cx={at.lonDeg} cy={-at.latDeg} r={r} fill={track.color} stroke="#02060a" strokeWidth={r * 0.25} />;
      })}
    </svg>
  );
}

function AltitudePlot({
  tracks,
  elapsedS,
}: {
  tracks: { id: TrackId; color: string; samples: TrajectorySample[] }[];
  elapsedS: number;
}) {
  const samples = tracks.map((track) => track.samples);
  const tMax = Math.max(1, maxElapsed(samples));
  const aMax = maxAltitude(samples);
  const W = 100;
  const H = 36;
  const xOf = (t: number) => (t / tMax) * W;
  const yOf = (alt: number) => H - (alt / aMax) * (H - 2) - 1;

  return (
    <div className="flex h-full flex-col justify-between gap-1">
      <svg
        data-testid="altitude-plot"
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full bg-[#02060a]"
        role="img"
        aria-label="Altitude versus time"
      >
        <line x1={0} x2={W} y1={H - 0.4} y2={H - 0.4} stroke="#1a4a44" strokeWidth={0.3} />
        {tracks.map((track) => {
          const points = track.samples
            .map((s) => `${xOf(s.elapsedS).toFixed(2)},${yOf(s.altitudeKm).toFixed(2)}`)
            .join(" ");
          return (
            <polyline
              key={track.id}
              data-testid={`altitude-${track.id}`}
              points={points}
              fill="none"
              stroke={track.color}
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        <line
          data-testid="altitude-scrubber"
          x1={xOf(elapsedS)}
          x2={xOf(elapsedS)}
          y1={0}
          y2={H}
          stroke="#d7fff4"
          strokeOpacity={0.7}
          strokeWidth={0.35}
        />
      </svg>
      <div className="flex justify-between font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
        <span>0 km</span>
        <span>{aMax.toFixed(0)} km</span>
        <span>{formatElapsed(tMax)}</span>
      </div>
    </div>
  );
}

export function TrajectoryViews({
  name,
  illustrative,
  surrogate,
  sim,
  surrogateFailed,
  simFailed,
}: {
  name: string;
  illustrative: boolean;
  surrogate: TrajectorySample[] | null;
  sim: TrajectorySample[] | null;
  surrogateFailed?: boolean;
  simFailed?: boolean;
}) {
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [shown, setShown] = useState<Record<TrackId, boolean>>({ surrogate: true, sim: true });
  const available: { id: TrackId; samples: TrajectorySample[] }[] = [];
  if (surrogate) available.push({ id: "surrogate", samples: surrogate });
  if (sim) available.push({ id: "sim", samples: sim });
  const visible = available.filter((track) => shown[track.id]);
  const colored = visible.map((track) => ({ ...track, color: TRACK_COLORS[track.id] }));
  const tMax = Math.max(0, maxElapsed(visible.map((track) => track.samples)));
  const [elapsed, setElapsed] = useState(0);
  const elapsedS = Math.min(elapsed, tMax);

  const readout = colored.map((track) => {
    const at = sampleAt(track.samples, elapsedS);
    if (!at) return null;
    return `${TRACK_LABEL[track.id]} ${at.altitudeKm.toFixed(1)} km`;
  }).filter(Boolean).join(" · ");

  return (
    <div data-testid="trajectory-viewer" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[11px] uppercase tracking-widest text-primary">{name}</div>
        <div className="flex gap-1" role="group" aria-label="Trajectory view">
          {(["2d", "3d"] as const).map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`view-${id}`}
              aria-pressed={mode === id}
              onClick={() => setMode(id)}
              className={`border px-3 py-1 font-mono text-[10px] uppercase tracking-widest ${
                mode === id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:border-primary hover:text-primary"
              }`}
            >
              {id === "2d" ? "2D" : "3D"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["surrogate", "sim"] as const).map((id) => {
          const present = id === "surrogate" ? surrogate : sim;
          const failed = id === "surrogate" ? surrogateFailed : simFailed;
          if (!present && !failed) return null;
          return (
            <button
              key={id}
              type="button"
              data-testid={`toggle-${id}`}
              aria-pressed={Boolean(present) && shown[id]}
              disabled={!present}
              onClick={() => setShown((prev) => ({ ...prev, [id]: !prev[id] }))}
              className={`inline-flex items-center gap-2 border px-2 py-1 font-mono text-[10px] uppercase tracking-widest ${
                present && shown[id] ? "border-border text-foreground" : "border-border/40 text-muted-foreground"
              }`}
            >
              <span className="inline-block h-2 w-4" style={{ background: TRACK_COLORS[id] }} />
              {TRACK_LABEL[id]}
              {failed && !present ? " unavailable" : ""}
            </button>
          );
        })}
      </div>

      <div className="relative border border-border bg-black/60">
        {illustrative && (
          <div className="pointer-events-none absolute left-2 top-2 z-10">
            <Badge
              data-testid="viz-illustrative"
              variant="outline"
              className="rounded-none border-2 border-secondary bg-secondary text-secondary-foreground font-mono text-[10px] font-bold tracking-widest"
            >
              ILLUSTRATIVE
            </Badge>
          </div>
        )}
        {colored.length === 0 ? (
          <p className="p-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {available.length === 0 ? "Trajectory files could not be read." : "Select a trajectory to draw."}
          </p>
        ) : mode === "2d" ? (
          <div className="grid gap-3 p-3 pt-10 lg:grid-cols-2">
            <GroundTrack tracks={colored} elapsedS={elapsedS} />
            <AltitudePlot tracks={colored} elapsedS={elapsedS} />
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-[420px] items-center justify-center gap-2 font-mono text-xs uppercase tracking-widest text-primary">
                <Loader2 className="h-4 w-4 animate-spin" />
                Raising the globe…
              </div>
            }
          >
            <LaunchGlobe tracks={colored} elapsedS={elapsedS} />
          </Suspense>
        )}
      </div>

      <div className="space-y-1">
        <label className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground" htmlFor={`scrub-${name}`}>
          <span>Time</span>
          <span data-testid="scrub-readout" className="text-foreground">
            {formatElapsed(elapsedS)}{readout ? ` · ${readout}` : ""}
          </span>
        </label>
        <input
          id={`scrub-${name}`}
          data-testid="trajectory-scrubber"
          type="range"
          min={0}
          max={tMax}
          step={1}
          value={elapsedS}
          aria-label="Trajectory time"
          disabled={tMax <= 0}
          onChange={(event) => setElapsed(Number(event.target.value))}
          className="w-full accent-primary"
        />
      </div>
    </div>
  );
}

export default function LaunchTrackPanel({
  name,
  illustrative,
  surrogateUrl,
  simUrl,
}: {
  name: string;
  illustrative: boolean;
  surrogateUrl: string | null;
  simUrl: string | null;
}) {
  const [surrogate, setSurrogate] = useState<TrajectorySample[] | null>(null);
  const [sim, setSim] = useState<TrajectorySample[] | null>(null);
  const [surrogateFailed, setSurrogateFailed] = useState(false);
  const [simFailed, setSimFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    setLoading(true);
    const load = async (url: string | null) => {
      if (!url) return null;
      return loadTrajectoryCsv(url, fetch, ac.signal);
    };
    Promise.all([load(surrogateUrl), load(simUrl)]).then(([surrogateTrack, simTrack]) => {
      if (cancelled) return;
      setSurrogate(surrogateTrack);
      setSim(simTrack);
      setSurrogateFailed(Boolean(surrogateUrl) && !surrogateTrack);
      setSimFailed(Boolean(simUrl) && !simTrack);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [surrogateUrl, simUrl]);

  if (loading) {
    return (
      <div data-testid="trajectory-viewer-loading" className="flex items-center justify-center gap-2 p-8 font-mono text-xs uppercase tracking-widest text-primary">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading trajectory files…
      </div>
    );
  }

  return (
    <TrajectoryViews
      name={name}
      illustrative={illustrative}
      surrogate={surrogate}
      sim={sim}
      surrogateFailed={surrogateFailed}
      simFailed={simFailed}
    />
  );
}
