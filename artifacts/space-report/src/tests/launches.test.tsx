/**
 * Launch desk — static /launches/index.json.
 *
 * The manifest is an array of { slug, name, vehicle, t0_utc, status, phase,
 * files: { csv, kml }, illustrative }. Upcoming and Recent are separate
 * boards. A missing or unreadable file must not crash the page.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import Launches, { LaunchesBoard } from "@/pages/launches";
import {
  formatUtc,
  loadLaunchIndex,
  parseLaunchIndex,
  partitionLaunches,
  publicAssetHref,
} from "@/lib/launches";

/** Shape published by the launches manifest (illustrative batch). */
const MANIFEST = [
  {
    slug: "electron-hawkeye360",
    name: "We're Not Hawking Around (3x HawkEye 360)",
    vehicle: "Electron",
    t0_utc: "2026-10-23T07:11:00Z",
    status: "Success",
    phase: "recent",
    files: {
      csv: "/launches/electron-hawkeye360/trajectory.csv",
      kml: "/launches/electron-hawkeye360/trajectory.kml",
    },
    illustrative: true,
    confidence: "low-medium",
    sources: ["https://example.test/electron"],
  },
  {
    slug: "lm6a-yaogan50-03",
    name: "Yaogan 50-03",
    vehicle: "Long March 6A",
    t0_utc: "2026-10-23T10:15:00Z",
    status: "Success",
    phase: "recent",
    files: {
      csv: "/launches/lm6a-yaogan50-03/trajectory.csv",
      kml: "/launches/lm6a-yaogan50-03/trajectory.kml",
    },
    illustrative: true,
    confidence: "low",
  },
  {
    slug: "lm4b-jiuquan",
    name: "Yaogan 53-07..09 / 56-19..21",
    vehicle: "Long March 4B",
    t0_utc: "2026-10-23T19:25:00Z",
    status: "Success",
    phase: "recent",
    files: {
      csv: "/launches/lm4b-jiuquan/trajectory.csv",
      kml: "/launches/lm4b-jiuquan/trajectory.kml",
    },
    illustrative: true,
  },
  {
    slug: "lm8a-wenchang",
    name: "Unknown payload",
    vehicle: "Long March 8A",
    t0_utc: "2026-10-25T01:50:00Z",
    status: "Go",
    phase: "upcoming",
    files: {
      csv: "/launches/lm8a-wenchang/trajectory.csv",
      kml: "/launches/lm8a-wenchang/trajectory.kml",
    },
    illustrative: true,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("launch manifest parsing", () => {
  it("keeps the published fields and ignores extras", () => {
    const parsed = parseLaunchIndex(MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.launches).toHaveLength(4);
    expect(parsed.launches[0]).toMatchObject({
      slug: "electron-hawkeye360",
      name: "We're Not Hawking Around (3x HawkEye 360)",
      vehicle: "Electron",
      t0Utc: "2026-10-23T07:11:00Z",
      status: "Success",
      phase: "recent",
      illustrative: true,
      files: {
        csv: "/launches/electron-hawkeye360/trajectory.csv",
        kml: "/launches/electron-hawkeye360/trajectory.kml",
      },
    });
  });

  it("splits upcoming (soonest NET first) from recent (latest T-0 first)", () => {
    const parsed = parseLaunchIndex(MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { upcoming, recent } = partitionLaunches(parsed.launches);
    expect(upcoming.map((l) => l.slug)).toEqual(["lm8a-wenchang"]);
    expect(recent.map((l) => l.slug)).toEqual([
      "lm4b-jiuquan",
      "lm6a-yaogan50-03",
      "electron-hawkeye360",
    ]);
  });

  it("treats an empty array as an empty board, not a failure", () => {
    const parsed = parseLaunchIndex([]);
    expect(parsed).toEqual({ ok: true, launches: [] });
  });

  it("treats a missing shape as unavailable", () => {
    expect(parseLaunchIndex(null).ok).toBe(false);
    expect(parseLaunchIndex({ launches: [] }).ok).toBe(false);
    expect(parseLaunchIndex("nope").ok).toBe(false);
  });

  it("skips rows with no name and only badges illustrative === true", () => {
    const parsed = parseLaunchIndex([
      { slug: "bare", name: "Bare", vehicle: "Test", t0_utc: "2026-01-01T00:00:00Z", status: "Go", phase: "upcoming" },
      { illustrative: false, name: "Plain", phase: "recent", vehicle: "Test", t0_utc: "2026-01-02T00:00:00Z", status: "Success", files: {} },
      { illustrative: "true", name: "String flag", phase: "recent" },
      { phase: "recent" },
      "nope",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.launches.map((l) => l.name)).toEqual(["Bare", "Plain", "String flag"]);
    expect(parsed.launches.map((l) => l.illustrative)).toEqual([false, false, false]);
    expect(parsed.launches[0].files).toEqual({ csv: null, kml: null });
  });

  it("formats T-0 / NET instants in UTC", () => {
    expect(formatUtc("2026-10-23T07:11:00Z")).toBe("2026-10-23 07:11:00 UTC");
    expect(formatUtc("")).toBe("—");
    expect(formatUtc("not-a-date")).toBe("—");
  });

  it("resolves manifest paths under the site base", () => {
    expect(publicAssetHref("/launches/lm8a-wenchang/trajectory.csv")).toBe(
      "/launches/lm8a-wenchang/trajectory.csv",
    );
    expect(publicAssetHref("")).toBeNull();
    expect(publicAssetHref(null)).toBeNull();
  });

  it("reads an empty body as an empty manifest and a 404 as unavailable", async () => {
    const empty = await loadLaunchIndex(async () => new Response("", { status: 200 }));
    expect(empty).toEqual({ ok: true, launches: [] });

    const missing = await loadLaunchIndex(async () => new Response("not found", { status: 404 }));
    expect(missing).toEqual({ ok: false, reason: "unavailable" });

    const thrown = await loadLaunchIndex(async () => {
      throw new Error("network down");
    });
    expect(thrown).toEqual({ ok: false, reason: "unavailable" });

    const junk = await loadLaunchIndex(async () => new Response("{", { status: 200 }));
    expect(junk).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("Launches page", () => {
  it("shows upcoming and recent rows, the badge, UTC times, and download links", () => {
    const parsed = parseLaunchIndex(MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    render(<LaunchesBoard state={{ kind: "ready", launches: parsed.launches }} />);

    expect(screen.getByRole("heading", { name: "Launches" })).toBeInTheDocument();
    expect(screen.getByTestId("synthetic-note")).toHaveTextContent(/trajectories are synthetic/i);
    expect(screen.getByTestId("synthetic-note")).toHaveTextContent(/not reconstructed flight telemetry/i);

    const upcoming = screen.getByTestId("launch-section-upcoming");
    expect(within(upcoming).getByRole("columnheader", { name: "NET (UTC)" })).toBeInTheDocument();
    expect(within(upcoming).getByText("Unknown payload")).toBeInTheDocument();
    expect(within(upcoming).getByText("Long March 8A")).toBeInTheDocument();
    expect(within(upcoming).getByText("2026-10-25 01:50:00 UTC")).toBeInTheDocument();
    expect(within(upcoming).getByText("Go")).toBeInTheDocument();
    expect(within(upcoming).queryByText("Yaogan 50-03")).not.toBeInTheDocument();

    const recent = screen.getByTestId("launch-section-recent");
    expect(within(recent).getByRole("columnheader", { name: "T-0 (UTC)" })).toBeInTheDocument();
    expect(within(recent).getByText("We're Not Hawking Around (3x HawkEye 360)")).toBeInTheDocument();
    expect(within(recent).getByText("2026-10-23 19:25:00 UTC")).toBeInTheDocument();
    const recentRows = within(recent).getAllByTestId("launch-row");
    expect(recentRows.map((row) => row.getAttribute("data-slug"))).toEqual([
      "lm4b-jiuquan",
      "lm6a-yaogan50-03",
      "electron-hawkeye360",
    ]);

    expect(screen.getAllByTestId("illustrative-badge")).toHaveLength(4);
    const csv = within(upcoming).getByRole("link", { name: "trajectory.csv" });
    const kml = within(upcoming).getByRole("link", { name: "trajectory.kml" });
    expect(csv).toHaveAttribute("href", "/launches/lm8a-wenchang/trajectory.csv");
    expect(csv).toHaveAttribute("download", "trajectory.csv");
    expect(kml).toHaveAttribute("href", "/launches/lm8a-wenchang/trajectory.kml");
    expect(kml).toHaveAttribute("download", "trajectory.kml");
  });

  it("hides the badge when illustrative is not set and omits a missing file link", () => {
    render(
      <LaunchesBoard
        state={{
          kind: "ready",
          launches: [
            {
              slug: "real",
              name: "Catalogued flight",
              vehicle: "Falcon 9",
              t0Utc: "2026-10-01T12:00:00Z",
              status: "Success",
              phase: "recent",
              files: { csv: "/launches/real/trajectory.csv", kml: null },
              illustrative: false,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByTestId("illustrative-badge")).not.toBeInTheDocument();
    const recent = screen.getByTestId("launch-section-recent");
    expect(within(recent).getByRole("link", { name: "trajectory.csv" })).toBeInTheDocument();
    expect(within(recent).queryByRole("link", { name: "trajectory.kml" })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("launch-section-upcoming")).getByText(/no upcoming launches/i)).toBeInTheDocument();
  });

  it("shows both empty sections when the manifest lists nothing", () => {
    render(<LaunchesBoard state={{ kind: "ready", launches: [] }} />);
    expect(screen.getByTestId("launch-manifest-empty")).toHaveTextContent(/lists no launches/i);
    expect(screen.getByText(/no upcoming launches on the board/i)).toBeInTheDocument();
    expect(screen.getByText(/no recent launches on the board/i)).toBeInTheDocument();
    expect(screen.queryByTestId("launch-manifest-unavailable")).not.toBeInTheDocument();
  });

  it("stays up when the manifest is missing", () => {
    render(<LaunchesBoard state={{ kind: "unavailable" }} />);
    expect(screen.getByTestId("launch-manifest-unavailable")).toHaveTextContent(/launch manifest unavailable/i);
    expect(screen.getByTestId("launch-manifest-unavailable")).toHaveTextContent(/\/launches\/index\.json/);
    expect(screen.queryByTestId("launch-section-upcoming")).not.toBeInTheDocument();
    expect(screen.getByTestId("synthetic-note")).toBeInTheDocument();
  });

  it("loads /launches/index.json and renders a 404 without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Launches />);

    expect(await screen.findByTestId("launch-manifest-unavailable")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/launches/index.json",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("loads a published manifest through fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(MANIFEST), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );

    render(<Launches />);

    expect(await screen.findByText("Unknown payload")).toBeInTheDocument();
    expect(screen.getAllByTestId("illustrative-badge")).toHaveLength(4);
    expect(screen.getByText("Electron")).toBeInTheDocument();
  });
});
