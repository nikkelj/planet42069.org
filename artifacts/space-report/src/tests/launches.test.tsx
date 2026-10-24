/**
 * Launch desk — static /launches/index.json.
 *
 * Current file: { methods, references, launches: [...] }, with surrogate
 * files (csv/kml) and 3DOF sim files (csv_sim/kml_sim). A bare array still loads.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { MethodsMarkdown } from "@/components/MethodsMarkdown";
import Launches, { LaunchesBoard } from "@/pages/launches";
import {
  emptyManifest,
  formatUtc,
  loadLaunchDesk,
  loadLaunchIndex,
  parseLaunchIndex,
  partitionLaunches,
  publicAssetHref,
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
      csv_sim: `/launches/${launch.slug}/trajectory_sim.csv`,
      kml_sim: `/launches/${launch.slug}/trajectory_sim.kml`,
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
        csv: "/launches/electron-hawkeye360/trajectory.csv",
        kml: "/launches/electron-hawkeye360/trajectory.kml",
        csvSim: "/launches/electron-hawkeye360/trajectory_sim.csv",
        kmlSim: "/launches/electron-hawkeye360/trajectory_sim.kml",
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
      csv: "/launches/electron-hawkeye360/trajectory.csv",
      kml: "/launches/electron-hawkeye360/trajectory.kml",
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
    expect(within(upcoming).getByRole("columnheader", { name: "NET (UTC)" })).toBeInTheDocument();
    expect(within(upcoming).getByText("Unknown payload")).toBeInTheDocument();
    expect(within(upcoming).getByText("Long March 8A")).toBeInTheDocument();
    expect(within(upcoming).getByText("2026-10-25 01:50:00 UTC")).toBeInTheDocument();
    expect(within(upcoming).getByText("Go")).toBeInTheDocument();

    const surrogate = within(upcoming).getByTestId("download-set-surrogate");
    expect(within(surrogate).getByText("Surrogate")).toBeInTheDocument();
    expect(within(surrogate).getByTestId("illustrative-badge")).toBeInTheDocument();
    expect(within(surrogate).getByRole("link", { name: "trajectory.csv" })).toHaveAttribute(
      "href",
      "/launches/lm8a-wenchang/trajectory.csv",
    );
    expect(within(surrogate).getByRole("link", { name: "trajectory.kml" })).toHaveAttribute(
      "download",
      "trajectory.kml",
    );
    expect(within(surrogate).getByTestId("method-note-surrogate")).toHaveTextContent(/event-surrogate parametric/i);

    const sim = within(upcoming).getByTestId("download-set-sim");
    expect(within(sim).getByText("3DOF sim")).toBeInTheDocument();
    expect(within(sim).getByTestId("illustrative-badge")).toBeInTheDocument();
    expect(within(sim).getByRole("link", { name: "trajectory_sim.csv" })).toHaveAttribute(
      "href",
      "/launches/lm8a-wenchang/trajectory_sim.csv",
    );
    expect(within(sim).getByRole("link", { name: "trajectory_sim.kml" })).toHaveAttribute(
      "href",
      "/launches/lm8a-wenchang/trajectory_sim.kml",
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
    expect(within(recent).getByRole("link", { name: "trajectory.csv" })).toBeInTheDocument();
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
