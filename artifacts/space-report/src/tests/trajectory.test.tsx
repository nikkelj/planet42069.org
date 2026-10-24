/**
 * Ascent trajectory viewer — CSV parse, ground track, altitude plot.
 * The 3D globe is a separate lazy chunk and is not mounted here.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import Launches, { LaunchesBoard } from "@/pages/launches";
import { TrajectoryViews } from "@/components/LaunchTrackPanel";
import {
  TRACK_COLORS,
  groundTrackBox,
  maxElapsed,
  parseTrajectoryCsv,
  sampleAt,
  splitAtDateline,
} from "@/lib/trajectory";
import { emptyManifest, parseLaunchIndex, type LaunchManifest } from "@/lib/launches";

const CSV = `# ILLUSTRATIVE — not telemetry
elapsed_s,utc_iso,lat_deg,lon_deg,altitude_km,range_along_track_km,x_ecef_km,y_ecef_km,z_ecef_km,vx_ecef_km_s,vy_ecef_km_s,vz_ecef_km_s,rel_vel_km_s,source
0,2026-10-25T01:50:00Z,19.60,110.90,0,0,-2147.3,5614.3,2125.7,0,0,0,0,surrogate
10,2026-10-25T01:50:10Z,19.20,111.40,12,40,-2160,5625,2110,0,0,0,0,surrogate
20,2026-10-25T01:50:20Z,18.40,112.20,40,120,-2180,5640,2080,0,0,0,0,surrogate
`;

const SIM = CSV.replaceAll("surrogate", "sim").replace("40,120", "28,90");

const WRAP = `elapsed_s,lat_deg,lon_deg,altitude_km
0,10,179,0
5,10,-179,1
`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("trajectory csv", () => {
  it("skips comments and keeps lat, lon, altitude, and ECEF", () => {
    const samples = parseTrajectoryCsv(CSV);
    expect(samples).not.toBeNull();
    expect(samples).toHaveLength(3);
    expect(samples![0]).toMatchObject({
      elapsedS: 0,
      latDeg: 19.6,
      lonDeg: 110.9,
      altitudeKm: 0,
      xEcefKm: -2147.3,
    });
    expect(samples![2]!.altitudeKm).toBe(40);
  });

  it("rejects html, a headerless file, and a single point", () => {
    expect(parseTrajectoryCsv("<!DOCTYPE html><html></html>")).toBeNull();
    expect(parseTrajectoryCsv("not,a,trajectory\n1,2,3")).toBeNull();
    expect(parseTrajectoryCsv("lat_deg,lon_deg,altitude_km\n1,2,3")).toBeNull();
  });

  it("splits a dateline crossing and keeps a regional map otherwise", () => {
    const wrapped = parseTrajectoryCsv(WRAP);
    expect(wrapped).not.toBeNull();
    expect(splitAtDateline(wrapped!)).toHaveLength(2);
    expect(groundTrackBox(wrapped!)).toEqual({ minLon: -180, maxLon: 180, minLat: -90, maxLat: 90 });

    const local = parseTrajectoryCsv(CSV)!;
    const box = groundTrackBox(local);
    expect(box.minLon).toBeGreaterThan(90);
    expect(box.maxLon).toBeLessThan(140);
    expect(box.maxLat).toBeLessThan(40);
  });

  it("interpolates elapsed time and clamps past the end", () => {
    const samples = parseTrajectoryCsv(CSV)!;
    expect(sampleAt(samples, 10)?.altitudeKm).toBe(12);
    expect(sampleAt(samples, 5)?.altitudeKm).toBeCloseTo(6);
    expect(sampleAt(samples, 999)?.elapsedS).toBe(20);
    expect(maxElapsed([samples])).toBe(20);
  });
});

describe("trajectory viewer", () => {
  const samples = parseTrajectoryCsv(CSV)!;
  const sim = parseTrajectoryCsv(SIM)!;

  it("draws both tracks in distinct colors with the illustrative mark and a scrubber", () => {
    render(
      <TrajectoryViews
        name="Unknown payload"
        illustrative
        surrogate={samples}
        sim={sim}
      />,
    );

    expect(screen.getByTestId("viz-illustrative")).toHaveTextContent("ILLUSTRATIVE");
    expect(screen.getByTestId("ground-track-surrogate")).toHaveAttribute("stroke", TRACK_COLORS.surrogate);
    expect(screen.getByTestId("ground-track-sim")).toHaveAttribute("stroke", TRACK_COLORS.sim);
    expect(screen.getByTestId("altitude-surrogate")).toHaveAttribute("stroke", TRACK_COLORS.surrogate);
    expect(screen.getByTestId("altitude-sim")).toHaveAttribute("stroke", TRACK_COLORS.sim);
    expect(screen.getByRole("img", { name: /ground track/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /altitude versus time/i })).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("trajectory-scrubber"), { target: { value: "10" } });
    expect(screen.getByTestId("scrub-readout")).toHaveTextContent(/T\+ 10s/);
    expect(screen.getByTestId("scrub-readout")).toHaveTextContent(/12\.0 km/);

    fireEvent.click(screen.getByTestId("toggle-sim"));
    expect(screen.queryByTestId("ground-track-sim")).not.toBeInTheDocument();
    expect(screen.getByTestId("ground-track-surrogate")).toBeInTheDocument();
    expect(screen.getByTestId("view-3d")).toHaveAttribute("aria-pressed", "false");
  });

  it("opens from a launch row and reads both csvs without leaving the board", async () => {
    const parsed = parseLaunchIndex([
      {
        slug: "lm8a-wenchang",
        name: "Unknown payload",
        vehicle: "Long March 8A",
        t0_utc: "2026-10-25T01:50:00Z",
        status: "Go",
        phase: "upcoming",
        illustrative: true,
        files: {
          csv: "/launches/lm8a-wenchang/trajectory.csv",
          kml: "/launches/lm8a-wenchang/trajectory.kml",
          csv_sim: "/launches/lm8a-wenchang/trajectory_sim.csv",
          kml_sim: "/launches/lm8a-wenchang/trajectory_sim.kml",
        },
      },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const manifest: LaunchManifest = { ...emptyManifest(), launches: parsed.manifest.launches };

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("trajectory_sim.csv")) return new Response(SIM, { status: 200, headers: { "Content-Type": "text/csv" } });
      if (u.endsWith("trajectory.csv")) return new Response(CSV, { status: 200, headers: { "Content-Type": "text/csv" } });
      return new Response("missing", { status: 404 });
    }));

    render(<LaunchesBoard state={{ kind: "ready", manifest }} />);
    expect(screen.queryByTestId("trajectory-viewer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("view-trajectory-lm8a-wenchang"));
    const viewer = await screen.findByTestId("trajectory-viewer");
    expect(within(viewer).getByTestId("viz-illustrative")).toBeInTheDocument();
    expect(within(viewer).getByTestId("ground-track-surrogate")).toBeInTheDocument();
    expect(within(viewer).getByTestId("ground-track-sim")).toBeInTheDocument();
    expect(screen.getByTestId("view-trajectory-lm8a-wenchang")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("Launches page still loads", () => {
  it("does not fetch trajectory files until a viewer is opened", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("index.json")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("no", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Launches />);
    expect(await screen.findByTestId("launch-manifest-empty")).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.endsWith("trajectory.csv"))).toBe(false);
  });
});
