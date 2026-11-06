/**
 * Launch desk — static /launches/index.json.
 *
 * Current file: { methods, references, launches: [...] }, with surrogate
 * files (csv/kml) and 3DOF sim files (csv_sim/kml_sim). A bare array still loads.
 */
import fs from "node:fs";
import path from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { MethodsMarkdown } from "@/components/MethodsMarkdown";
import Launches, { LaunchesBoard } from "@/pages/launches";
import {
  emptyManifest,
  formatPacific,
  formatUtc,
  launchClock,
  loadLaunchDesk,
  loadLaunchIndex,
  parseLaunchIndex,
  partitionLaunches,
  launchDownloadName,
  publicAssetHref,
  type LaunchEntry,
  type LaunchManifest,
} from "@/lib/launches";

/** Previous bare-array manifest. */
const ARRAY_MANIFEST = [
  {
    slug: "electron-hawkeye360",
    name: "We're Not Hawking Around (3x HawkEye 360)",
    vehicle: "Electron",
    t0_utc: "2026-10-23T07:11:00Z",
    status: "Success",
    phase: "recent",
    files: {
      csv: "/launches/electron-hawkeye360/electron-hawkeye360_2026-10-23_trajectory.csv",
      kml: "/launches/electron-hawkeye360/electron-hawkeye360_2026-10-23_trajectory.kml",
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
      csv: "/launches/lm6a-yaogan50-03/lm6a-yaogan50-03_2026-10-23_trajectory.csv",
      kml: "/launches/lm6a-yaogan50-03/lm6a-yaogan50-03_2026-10-23_trajectory.kml",
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
      csv: "/launches/lm4b-jiuquan/lm4b-jiuquan_2026-10-23_trajectory.csv",
      kml: "/launches/lm4b-jiuquan/lm4b-jiuquan_2026-10-23_trajectory.kml",
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
      csv: "/launches/lm8a-wenchang/lm8a-wenchang_2026-10-25_trajectory.csv",
      kml: "/launches/lm8a-wenchang/lm8a-wenchang_2026-10-25_trajectory.kml",
    },
    illustrative: true,
  },
];

const OBJECT_MANIFEST = {
  methods: {
    surrogate: {
      title: "Surrogate (published-profile)",
      summary: "Event knots from published brochures, interpolated every 5 s. ILLUSTRATIVE, not telemetry.",
    },
    sim: {
      title: "First-principles 3DOF sim",
      summary: "Point-mass ascent simulator with J2 gravity and staged thrust. ILLUSTRATIVE, not telemetry.",
    },
    methods_doc: "/launches/METHODS.md",
  },
  references: [
    {
      id: "rl-ug",
      title: "Rocket Lab Electron Payload User's Guide v8.0",
      url: "https://rocketlabcorp.com/assets/Rocket-Lab-Electron-Payload-User-Guide-8.0.pdf",
    },
    {
      id: "zj385",
      title: "China MSA debris-zone notice ZJ385/26 (LM-4B Jiuquan)",
      url: null,
    },
  ],
  launches: ARRAY_MANIFEST.map((launch) => ({
    ...launch,
    files: {
      ...launch.files,
      csv_sim: `/launches/${launch.slug}/${launch.slug}_${launch.t0_utc.slice(0, 10)}_trajectory_sim.csv`,
      kml_sim: `/launches/${launch.slug}/${launch.slug}_${launch.t0_utc.slice(0, 10)}_trajectory_sim.kml`,
    },
    method: {
      csv: "event-surrogate parametric (published event table + azimuth)",
      csv_sim: "first-principles 3DOF sim; ILLUSTRATIVE",
    },
    reference_ids: launch.slug === "lm4b-jiuquan" ? ["rl-ug", "zj385"] : ["rl-ug"],
  })),
};

const METHODS_MD = `# How the files are made

**Every trajectory here is ILLUSTRATIVE.**

## 1. Surrogate
- Event knots from a brochure.

See https://example.test/guide for the table.
`;

function ready(manifest: LaunchManifest) {
  return { kind: "ready" as const, manifest };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function clockLaunch(overrides: Partial<LaunchEntry> = {}): LaunchEntry {
  return {
    slug: "clock",
    name: "Clock flight",
    vehicle: "Test",
    t0Utc: "2026-11-07T00:48:42Z",
    t0Kind: "net",
    windowOpenUtc: "2026-11-07T00:46:00Z",
    windowCloseUtc: "2026-11-07T04:46:00Z",
    status: "Go",
    phase: "upcoming",
    files: { csv: null, kml: null, csvSim: null, kmlSim: null },
    illustrative: false,
    method: { csv: null, csvSim: null },
    referenceIds: [],
    ...overrides,
  };
}

describe("launch manifest parsing", () => {
  it("reads launches from the object wrapper and keeps methods and references", () => {
    const parsed = parseLaunchIndex(OBJECT_MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.launches).toHaveLength(4);
    expect(parsed.manifest.launches[0]).toMatchObject({
      slug: "electron-hawkeye360",
      name: "We're Not Hawking Around (3x HawkEye 360)",
      vehicle: "Electron",
      t0Utc: "2026-10-23T07:11:00Z",
      status: "Success",
      phase: "recent",
      illustrative: true,
      files: {
        csv: "/launches/electron-hawkeye360/electron-hawkeye360_2026-10-23_trajectory.csv",
        kml: "/launches/electron-hawkeye360/electron-hawkeye360_2026-10-23_trajectory.kml",
        csvSim: "/launches/electron-hawkeye360/electron-hawkeye360_2026-10-23_trajectory_sim.csv",
        kmlSim: "/launches/electron-hawkeye360/electron-hawkeye360_2026-10-23_trajectory_sim.kml",
      },
      method: {
        csv: "event-surrogate parametric (published event table + azimuth)",
        csvSim: "first-principles 3DOF sim; ILLUSTRATIVE",
      },
      referenceIds: ["rl-ug"],
    });
    expect(parsed.manifest.methods).toEqual([
      {
        key: "surrogate",
        title: "Surrogate (published-profile)",
        summary: "Event knots from published brochures, interpolated every 5 s. ILLUSTRATIVE, not telemetry.",
      },
      {
        key: "sim",
        title: "First-principles 3DOF sim",
        summary: "Point-mass ascent simulator with J2 gravity and staged thrust. ILLUSTRATIVE, not telemetry.",
      },
    ]);
    expect(parsed.manifest.methodsDoc).toBe("/launches/METHODS.md");
    expect(parsed.manifest.references[1]).toEqual({
      id: "zj385",
      title: "China MSA debris-zone notice ZJ385/26 (LM-4B Jiuquan)",
      url: null,
    });
  });

  it("keeps a bare array working, with no sim files unless they are present", () => {
    const parsed = parseLaunchIndex(ARRAY_MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.launches).toHaveLength(4);
    expect(parsed.manifest.methods).toEqual([]);
    expect(parsed.manifest.references).toEqual([]);
    expect(parsed.manifest.launches[0].files).toEqual({
      csv: "/launches/electron-hawkeye360/electron-hawkeye360_2026-10-23_trajectory.csv",
      kml: "/launches/electron-hawkeye360/electron-hawkeye360_2026-10-23_trajectory.kml",
      csvSim: null,
      kmlSim: null,
    });
    expect(parsed.manifest.launches[0].method).toEqual({ csv: null, csvSim: null });
  });

  it("splits upcoming (soonest NET first) from recent (latest T-0 first)", () => {
    const parsed = parseLaunchIndex(OBJECT_MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { upcoming, recent } = partitionLaunches(parsed.manifest.launches);
    expect(upcoming.map((l) => l.slug)).toEqual(["lm8a-wenchang"]);
    expect(recent.map((l) => l.slug)).toEqual([
      "lm4b-jiuquan",
      "lm6a-yaogan50-03",
      "electron-hawkeye360",
    ]);
  });

  it("treats an empty array and an empty launches list as an empty board", () => {
    expect(parseLaunchIndex([])).toEqual({ ok: true, manifest: emptyManifest() });
    const wrapped = parseLaunchIndex({ launches: [], methods: {}, references: [] });
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.manifest.launches).toEqual([]);
  });

  it("treats a missing shape as unavailable", () => {
    expect(parseLaunchIndex(null).ok).toBe(false);
    expect(parseLaunchIndex({ methods: {}, references: [] }).ok).toBe(false);
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
    expect(parsed.manifest.launches.map((l) => l.name)).toEqual(["Bare", "Plain", "String flag"]);
    expect(parsed.manifest.launches.map((l) => l.illustrative)).toEqual([false, false, false]);
    expect(parsed.manifest.launches[0].files).toEqual({ csv: null, kml: null, csvSim: null, kmlSim: null });
  });

  it("formats T-0 / NET instants in UTC and Pacific", () => {
    expect(formatUtc("2026-10-23T07:11:00Z")).toBe("2026-10-23 07:11:00 UTC");
    expect(formatUtc("")).toBe("—");
    expect(formatUtc("not-a-date")).toBe("—");
    expect(formatPacific("2026-11-07T00:48:42Z")).toBe("Fri Nov 6, 4:48:42 pm PST");
    expect(formatPacific("2026-11-08T20:25:00Z")).toBe("Sun Nov 8, 12:25:00 pm PST");
    expect(formatPacific("2026-07-15T19:00:00Z")).toBe("Wed Jul 15, 12:00:00 pm PDT");
    expect(formatPacific("")).toBe("—");
  });

  it("publishes USSF-432 and LM-12 as NET instants with a separate window open", () => {
    const root = path.resolve(import.meta.dirname, "../../public");
    const index = JSON.parse(fs.readFileSync(path.join(root, "launches/index.json"), "utf8"));
    const parsed = parseLaunchIndex(index);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const bySlug = Object.fromEntries(parsed.manifest.launches.map((launch) => [launch.slug, launch]));
    expect(bySlug["ussf-432"]).toMatchObject({
      t0Utc: "2026-11-07T00:48:42Z",
      t0Kind: "net",
      windowOpenUtc: "2026-11-07T00:46:00Z",
      windowCloseUtc: "2026-11-07T04:46:00Z",
      status: "Go",
      phase: "upcoming",
    });
    expect(bySlug["lm12-wenchang"]).toMatchObject({
      t0Utc: "2026-11-08T20:25:00Z",
      t0Kind: "net",
      windowOpenUtc: "2026-11-08T20:17:00Z",
      windowCloseUtc: "2026-11-08T20:47:00Z",
      status: "Go",
      phase: "upcoming",
    });
    expect(bySlug["lm2c-xichang"]).toMatchObject({
      t0Utc: "2026-11-05T15:58:00Z",
      status: "Success",
      phase: "flown",
    });
    const before = Date.parse("2026-11-05T12:00:00Z");
    const { upcoming, recent } = partitionLaunches(parsed.manifest.launches, before);
    expect(upcoming.map((launch) => launch.slug)).toEqual(["ussf-432", "lm12-wenchang"]);
    expect(recent.map((launch) => launch.slug)).toContain("lm2c-xichang");
  });

  it("reads NET versus window-open fields and files flown launches as recent before T-0", () => {
    const parsed = parseLaunchIndex({
      launches: [
        {
          slug: "net-flight",
          name: "NET flight",
          t0_utc: "2026-11-07T00:48:42Z",
          t0_kind: "NET",
          window_open_utc: "2026-11-07T00:46:00Z",
          window_close_utc: "2026-11-07T04:46:00Z",
          status: "Go",
          phase: "upcoming",
        },
        {
          slug: "window-flight",
          name: "Window flight",
          t0_utc: "2026-11-09T01:00:00Z",
          t0_kind: "window-open",
          status: "Go",
          phase: "upcoming",
        },
        {
          slug: "target-flight",
          name: "Target flight",
          t0_utc: "2026-11-10T01:00:00Z",
          t0_kind: "target",
          status: "Go",
          phase: "upcoming",
        },
        {
          slug: "flown-early",
          name: "Already flown",
          t0_utc: "2026-11-05T15:58:00Z",
          status: "Success",
          phase: "flown",
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.launches.map((launch) => launch.t0Kind)).toEqual([
      "net",
      "window_open",
      "target",
      null,
    ]);
    const beforeLiftoff = Date.parse("2026-11-05T12:00:00Z");
    const { upcoming, recent } = partitionLaunches(parsed.manifest.launches, beforeLiftoff);
    expect(upcoming.map((launch) => launch.slug)).toEqual(["net-flight", "window-flight", "target-flight"]);
    expect(recent.map((launch) => launch.slug)).toEqual(["flown-early"]);
  });

  it("resolves manifest paths under the site base", () => {
    expect(publicAssetHref("/launches/lm8a-wenchang/lm8a-wenchang_2026-10-25_trajectory.csv")).toBe(
      "/launches/lm8a-wenchang/lm8a-wenchang_2026-10-25_trajectory.csv",
    );
    expect(publicAssetHref("")).toBeNull();
    expect(publicAssetHref(null)).toBeNull();
  });

  it("uses the slug and date once in the visible download name", () => {
    const launch = { slug: "starlink-15-16", t0Utc: "2026-10-27T04:45:00Z" };
    const named = "/launches/starlink-15-16/starlink-15-16_2026-10-27_trajectory_sim.kml";
    expect(launchDownloadName(launch, named)).toBe("starlink-15-16_2026-10-27_trajectory_sim.kml");
    expect(launchDownloadName(launch, "/launches/starlink-15-16/trajectory.csv")).toBe(
      "starlink-15-16_2026-10-27_trajectory.csv",
    );
  });

  it("publishes every trajectory under the slug_date name and keeps the sim arc past insertion", () => {
    const root = path.resolve(import.meta.dirname, "../../public");
    const index = JSON.parse(fs.readFileSync(path.join(root, "launches/index.json"), "utf8")) as {
      launches: { slug: string; t0_utc: string; files: Record<string, string> }[];
    };
    expect(index.launches.length).toBeGreaterThan(0);
    for (const launch of index.launches) {
      const date = launch.t0_utc.slice(0, 10);
      const stem = `/launches/${launch.slug}/${launch.slug}_${date}`;
      expect(launch.files.csv).toBe(`${stem}_trajectory.csv`);
      expect(launch.files.kml).toBe(`${stem}_trajectory.kml`);
      expect(launch.files.csv_sim).toBe(`${stem}_trajectory_sim.csv`);
      expect(launch.files.kml_sim).toBe(`${stem}_trajectory_sim.kml`);
      for (const rel of [launch.files.csv, launch.files.kml, launch.files.csv_sim, launch.files.kml_sim, launch.files.track_lite]) {
        expect(fs.existsSync(path.join(root, rel.replace(/^\//, "")))).toBe(true);
      }
      const track = JSON.parse(fs.readFileSync(path.join(root, launch.files.track_lite.replace(/^\//, "")), "utf8")) as {
        sim: [number, number, number, number][];
        surrogate: [number, number, number, number][];
      };
      const simEnd = track.sim[track.sim.length - 1]?.[0] ?? 0;
      const surEnd = track.surrogate[track.surrogate.length - 1]?.[0] ?? 0;
      expect(simEnd).toBeGreaterThan(surEnd + 60);
      const csv = fs.readFileSync(path.join(root, launch.files.csv_sim.replace(/^\//, "")), "utf8");
      const rows = csv.split("\n").filter((line) => line && !line.startsWith("#") && !line.startsWith("elapsed_s"));
      const last = Number(rows[rows.length - 1]?.split(",")[0]);
      expect(Math.abs(last - simEnd)).toBeLessThan(1);
    }
  });

  it("reads an empty body as an empty manifest and a 404 as unavailable", async () => {
    const empty = await loadLaunchIndex(async () => new Response("", { status: 200 }));
    expect(empty).toEqual({ ok: true, manifest: emptyManifest() });

    const missing = await loadLaunchIndex(async () => new Response("not found", { status: 404 }));
    expect(missing).toEqual({ ok: false, reason: "unavailable" });

    const thrown = await loadLaunchIndex(async () => {
      throw new Error("network down");
    });
    expect(thrown).toEqual({ ok: false, reason: "unavailable" });

    const junk = await loadLaunchIndex(async () => new Response("{", { status: 200 }));
    expect(junk).toEqual({ ok: false, reason: "unavailable" });
  });

  it("attaches METHODS.md and ignores an HTML fallback for a missing file", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("index.json")) {
        return new Response(JSON.stringify(OBJECT_MANIFEST), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(METHODS_MD, { status: 200, headers: { "Content-Type": "text/markdown" } });
    });
    const loaded = await loadLaunchDesk(fetchImpl);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.manifest.methodsMarkdown).toContain("How the files are made");

    const htmlFallback = vi.fn(async (url: string) => {
      if (String(url).endsWith("index.json")) {
        return new Response(JSON.stringify(ARRAY_MANIFEST), { status: 200 });
      }
      return new Response("<!DOCTYPE html><html><body>index</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });
    const withoutDoc = await loadLaunchDesk(htmlFallback);
    expect(withoutDoc.ok).toBe(true);
    if (!withoutDoc.ok) return;
    expect(withoutDoc.manifest.methodsMarkdown).toBeNull();
  });
});

describe("Launches page", () => {
  it("shows two labelled download sets, both badged, for the object manifest", () => {
    const parsed = parseLaunchIndex(OBJECT_MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const manifest: LaunchManifest = {
      ...parsed.manifest,
      methodsMarkdown: METHODS_MD,
    };

    render(<LaunchesBoard state={ready(manifest)} />);

    expect(screen.getByRole("heading", { name: "Launches" })).toBeInTheDocument();
    expect(screen.getByTestId("synthetic-note")).toHaveTextContent(/trajectories are synthetic/i);
    expect(screen.getByTestId("synthetic-note")).toHaveTextContent(/not reconstructed flight telemetry/i);

    const upcoming = screen.getByTestId("launch-section-upcoming");
    expect(within(upcoming).getByRole("columnheader", { name: "T-0" })).toBeInTheDocument();
    expect(within(upcoming).getByTestId("launch-countdown-lm8a-wenchang")).toHaveTextContent(/T[+-] /);
    expect(within(upcoming).getByText("Go")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ascent globe/i })).toBeInTheDocument();
    expect(within(upcoming).getByText("Unknown payload")).toBeInTheDocument();
    expect(within(upcoming).getByText("Long March 8A")).toBeInTheDocument();
    expect(within(upcoming).getByText("2026-10-25 01:50:00 UTC")).toBeInTheDocument();
    expect(within(upcoming).getByText("Go")).toBeInTheDocument();

    const surrogate = within(upcoming).getByTestId("download-set-surrogate");
    expect(within(surrogate).getByText("Surrogate")).toBeInTheDocument();
    expect(within(surrogate).getByTestId("illustrative-badge")).toBeInTheDocument();
    expect(within(surrogate).getByRole("link", { name: "lm8a-wenchang_2026-10-25_trajectory.csv" })).toHaveAttribute(
      "href",
      "/launches/lm8a-wenchang/lm8a-wenchang_2026-10-25_trajectory.csv",
    );
    expect(within(surrogate).getByRole("link", { name: "lm8a-wenchang_2026-10-25_trajectory.kml" })).toHaveAttribute(
      "download",
      "lm8a-wenchang_2026-10-25_trajectory.kml",
    );
    expect(within(surrogate).getByTestId("method-note-surrogate")).toHaveTextContent(/event-surrogate parametric/i);

    const sim = within(upcoming).getByTestId("download-set-sim");
    expect(within(sim).getByText("3DOF sim")).toBeInTheDocument();
    expect(within(sim).getByTestId("illustrative-badge")).toBeInTheDocument();
    expect(within(sim).getByRole("link", { name: "lm8a-wenchang_2026-10-25_trajectory_sim.csv" })).toHaveAttribute(
      "href",
      "/launches/lm8a-wenchang/lm8a-wenchang_2026-10-25_trajectory_sim.csv",
    );
    expect(within(sim).getByRole("link", { name: "lm8a-wenchang_2026-10-25_trajectory_sim.kml" })).toHaveAttribute(
      "href",
      "/launches/lm8a-wenchang/lm8a-wenchang_2026-10-25_trajectory_sim.kml",
    );

    expect(screen.getAllByTestId("illustrative-badge")).toHaveLength(8);

    const recent = screen.getByTestId("launch-section-recent");
    expect(within(recent).getByRole("columnheader", { name: "T-0 (UTC)" })).toBeInTheDocument();
    const recentRows = within(recent).getAllByTestId("launch-row");
    expect(recentRows.map((row) => row.getAttribute("data-slug"))).toEqual([
      "lm4b-jiuquan",
      "lm6a-yaogan50-03",
      "electron-hawkeye360",
    ]);

    const methods = screen.getByTestId("launch-methods");
    expect(within(methods).getByText("Surrogate (published-profile)")).toBeInTheDocument();
    expect(within(methods).getByText(/interpolated every 5 s/i)).toBeInTheDocument();
    expect(within(methods).getByText("First-principles 3DOF sim")).toBeInTheDocument();
    expect(within(methods).getByText(/point-mass ascent simulator/i)).toBeInTheDocument();
    expect(within(methods).getByRole("link", { name: "METHODS.md" })).toHaveAttribute("href", "/launches/METHODS.md");

    const references = screen.getByTestId("launch-references");
    const guide = within(references).getByRole("link", { name: /Rocket Lab Electron Payload User's Guide/i });
    expect(guide).toHaveAttribute("href", "https://rocketlabcorp.com/assets/Rocket-Lab-Electron-Payload-User-Guide-8.0.pdf");
    expect(within(references).getByText(/China MSA debris-zone notice/)).toBeInTheDocument();
    expect(within(references).queryByRole("link", { name: /China MSA debris-zone notice/ })).not.toBeInTheDocument();
    expect(within(references).getByText(/notice id only/i)).toBeInTheDocument();
  });

  it("hides the badge when illustrative is not set and omits a missing file set", () => {
    render(
      <LaunchesBoard
        state={ready({
          ...emptyManifest(),
          launches: [
            {
              slug: "real",
              name: "Catalogued flight",
              vehicle: "Falcon 9",
              t0Utc: "2026-10-01T12:00:00Z",
              t0Kind: null,
              windowOpenUtc: null,
              windowCloseUtc: null,
              status: "Success",
              phase: "recent",
              files: { csv: "/launches/real/trajectory.csv", kml: null, csvSim: null, kmlSim: null },
              illustrative: false,
              method: { csv: null, csvSim: null },
              referenceIds: [],
            },
          ],
        })}
      />,
    );

    expect(screen.queryByTestId("illustrative-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("download-set-sim")).not.toBeInTheDocument();
    const recent = screen.getByTestId("launch-section-recent");
    expect(within(recent).getByRole("link", { name: "real_2026-10-01_trajectory.csv" })).toBeInTheDocument();
    expect(within(recent).queryByRole("link", { name: "trajectory.kml" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("launch-methods")).not.toBeInTheDocument();
    expect(screen.queryByTestId("launch-references")).not.toBeInTheDocument();
  });

  it("shows both empty sections when the manifest lists nothing", () => {
    render(<LaunchesBoard state={ready(emptyManifest())} />);
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

  it("loads an object manifest and its methods note through fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("index.json")) {
          return new Response(JSON.stringify(OBJECT_MANIFEST), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(METHODS_MD, { status: 200, headers: { "Content-Type": "text/markdown" } });
      }),
    );

    render(<Launches />);

    expect(await screen.findByText("Unknown payload")).toBeInTheDocument();
    expect(screen.getAllByTestId("illustrative-badge")).toHaveLength(8);
    expect(screen.getAllByText("3DOF sim").length).toBeGreaterThan(0);
    expect(screen.getByText("Surrogate (published-profile)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Rocket Lab Electron Payload User's Guide/i })).toBeInTheDocument();
  });
});

describe("launch countdown", () => {
  const t0 = Date.parse("2026-11-07T00:48:42Z");

  it("counts down with days only at 24h, and labels NET apart from window open", () => {
    const day = launchClock(clockLaunch(), t0 - 2 * 86400 * 1000);
    expect(day).toMatchObject({
      mode: "countdown",
      label: "NET",
      readout: "T- 2d 00:00:00",
      utc: "2026-11-07 00:48:42 UTC",
      pacific: "Fri Nov 6, 4:48:42 pm PST",
      ticking: true,
      notice: null,
    });
    expect(day.windowOpen).toEqual({
      utc: "2026-11-07 00:46:00 UTC",
      pacific: "Fri Nov 6, 4:46:00 pm PST",
    });
    expect(day.windowClose).toEqual({
      utc: "2026-11-07 04:46:00 UTC",
      pacific: "Fri Nov 6, 8:46:00 pm PST",
    });

    expect(launchClock(clockLaunch(), t0 - 86400 * 1000).readout).toBe("T- 1d 00:00:00");
    expect(launchClock(clockLaunch(), t0 - (86400 * 1000 - 1)).readout).toBe("T- 1d 00:00:00");
    expect(launchClock(clockLaunch(), t0 - 86399 * 1000).readout).toBe("T- 23:59:59");
    expect(launchClock(clockLaunch(), t0 - 1500).readout).toBe("T- 00:00:02");
    expect(launchClock(clockLaunch(), t0 - 1).readout).toBe("T- 00:00:01");
    expect(launchClock(clockLaunch(), t0).readout).toBe("T- 00:00:00");
  });

  it("labels a window-open instant and a target without repeating the same moment", () => {
    const windowOpen = launchClock(clockLaunch({
      t0Kind: "window_open",
      t0Utc: "2026-11-07T00:46:00Z",
      windowOpenUtc: "2026-11-07T00:46:00Z",
      windowCloseUtc: null,
    }), t0);
    expect(windowOpen.label).toBe("Window opens");
    expect(windowOpen.readout).toBe("T+ 00:02:42");
    expect(windowOpen.windowOpen).toBeNull();
    expect(windowOpen.notice).toBe("T-0 passed. Not marked flown.");

    const target = launchClock(clockLaunch({
      t0Kind: "target",
      windowOpenUtc: null,
      windowCloseUtc: null,
      status: "Scheduled",
    }), t0 - 5000);
    expect(target.label).toBe("Target");
    expect(target.readout).toBe("T- 00:00:05");
    expect(target.windowOpen).toBeNull();
  });

  it("does not call a passed T-0 flown, and keeps TBD, success, and slips distinct", () => {
    const passed = launchClock(clockLaunch(), t0 + 1000);
    expect(passed.mode).toBe("elapsed");
    expect(passed.readout).toBe("T+ 00:00:01");
    expect(passed.notice).toBe("T-0 passed. Not marked flown.");
    expect(launchClock(clockLaunch(), t0 + 1).readout).toBe("T+ 00:00:00");

    const tbd = launchClock(clockLaunch({ status: "TBD", t0Utc: "2026-11-07T00:48:42Z" }), t0);
    expect(tbd).toMatchObject({
      mode: "tbd",
      readout: "TBD",
      ticking: false,
      notice: "Published instant is not a fixed liftoff.",
    });
    const noTime = launchClock(clockLaunch({ status: "Go", t0Utc: "", t0Kind: null }), t0);
    expect(noTime.readout).toBe("TBD");
    expect(noTime.notice).toBe("No authoritative T-0 in the manifest.");
    expect(noTime.ticking).toBe(false);

    const success = launchClock(clockLaunch({ status: "Success", phase: "upcoming" }), t0 + 60_000);
    expect(success.mode).toBe("absolute");
    expect(success.readout).toBe("2026-11-07 00:48:42 UTC");
    expect(success.notice).toBeNull();
    expect(success.ticking).toBe(false);

    const slipped = launchClock(clockLaunch({ status: "Slipped" }), t0 - 90_000);
    expect(slipped.readout).toBe("T- 00:01:30");
    expect(slipped.notice).toBe("Slipped. Counting the current published instant.");
    const scrubbed = launchClock(clockLaunch({ status: "Scrubbed" }), t0 + 3600_000);
    expect(scrubbed.readout).toBe("T+ 01:00:00");
    expect(scrubbed.notice).toBe("T-0 passed. Slipped, not marked flown.");

    const held = launchClock(clockLaunch({ status: "Hold" }), t0 - 1000);
    expect(held.notice).toBe("Hold. Counting the current published instant.");
    expect(launchClock(clockLaunch({ phase: "flown", status: "Success" }), t0 - 1000).ticking).toBe(false);
  });

  it("ticks each second on upcoming rows and clears the timer on unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T00:48:42.000Z"));
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const { unmount } = render(
      <LaunchesBoard
        state={ready({
          ...emptyManifest(),
          launches: [
            clockLaunch({ slug: "ussf-432", name: "USSF-432" }),
            clockLaunch({
              slug: "no-time",
              name: "Date not set",
              status: "TBD",
              t0Utc: "",
              t0Kind: null,
              windowOpenUtc: null,
              windowCloseUtc: null,
            }),
          ],
        })}
      />,
    );

    const upcoming = screen.getByTestId("launch-section-upcoming");
    const countdown = within(upcoming).getByTestId("launch-countdown-ussf-432");
    expect(countdown).toHaveTextContent("NET");
    expect(countdown).toHaveTextContent("T- 1d 00:00:00");
    expect(countdown).not.toHaveTextContent(/flown/i);
    expect(within(upcoming).getByText("Fri Nov 6, 4:48:42 pm PST")).toBeInTheDocument();
    expect(within(upcoming).getByText("Window opens")).toBeInTheDocument();
    expect(screen.getByText("2026-11-07 00:46:00 UTC")).toBeInTheDocument();
    expect(screen.getByTestId("launch-countdown-no-time")).toHaveTextContent("TBD");
    expect(screen.getByTestId("launch-countdown-no-time")).not.toHaveAttribute("role", "timer");
    expect(screen.queryByRole("columnheader", { name: "NET (UTC)" })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId("launch-countdown-ussf-432")).toHaveTextContent("T- 23:59:59");

    unmount();
    expect(clearTimeout).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByTestId("launch-countdown-ussf-432")).not.toBeInTheDocument();
  });
});

describe("Methods note", () => {
  it("renders headings, a list, and a link from METHODS.md", () => {
    render(<MethodsMarkdown source={METHODS_MD} />);
    expect(screen.getByText("How the files are made")).toBeInTheDocument();
    expect(screen.getByText("1. Surrogate")).toBeInTheDocument();
    expect(screen.getByText(/Event knots from a brochure/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://example.test/guide" })).toHaveAttribute(
      "href",
      "https://example.test/guide",
    );
  });
});
