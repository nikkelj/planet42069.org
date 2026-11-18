/**
 * Mass Analytics publishes the provisional Starship calculation: sources,
 * tagged inputs, formula, booked result and range, and the auto-retire note.
 * Chart hooks are stubbed so this does not need a live catalog.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Analytics from "@/pages/analytics";

vi.mock("wouter", () => ({
  useSearch: () => "",
  useLocation: () => ["/", () => {}],
}));

vi.mock("@/components/OrbitalMap", () => ({ OrbitalMap: () => null }));
vi.mock("@/components/DeorbitAnimation", () => ({ DeorbitAnimation: () => null }));
vi.mock("@/components/MassCDFChart", () => ({ MassCDFChart: () => null }));
vi.mock("@/components/VehicleMassChart", () => ({ VehicleMassChart: () => null }));
vi.mock("@/components/ShuttleVsFalconChart", () => ({ ShuttleVsFalconChart: () => null }));

const manifest = {
  calculatedOn: "2026-11-16",
  timezone: "America/Los_Angeles",
  activeMassKg: 39000,
  note: "Entries are replaced automatically once GCAT lists a payload mass for the launch.",
  entries: [
    {
      id: "starship-flight-15",
      launchDate: "2026-11-13",
      launchDateTimeUtc: "2026-11-13T22:47:36Z",
      vehicle: "Starship",
      lvFamilyIncludes: "starship",
      site: "Starbase",
      siteClass: "starbase",
      payloadName: "Starlink Group 31-2",
      payloadCount: 26,
      perSatMassKg: 1500,
      perSatLowKg: 1500,
      perSatHighKg: 2500,
      massKg: 39000,
      massLowKg: 39000,
      massHighKg: 65000,
      basis: "estimated",
      sourceUrls: ["https://www.spacex.com/launches/starship-flight-15"],
      note: "ESTIMATED / provisional. Booked below the prospectus ceiling.",
      calc: {
        title: "Starship Flight 15 — Starlink V3 provisional mass",
        formula: "26 × 1,500 kg = 39,000 kg booked",
        inputs: [
          { name: "Satellite count", value: "26 Starlink V3", kind: "published", source: "https://www.spacex.com/launches/starship-flight-15" },
          { name: "Prospectus ceiling", value: "1,667 kg per sat", kind: "derived", source: "https://content.spacex.com/prospectus.pdf" },
          { name: "Booked unit mass", value: "1,500 kg", kind: "editorial", source: "planet42069 desk" },
        ],
        resultKg: 39000,
        rangeKg: [39000, 65000],
        markdownPath: "provisional-calcs/starship-flight-15.md",
      },
      match: { ldate: "2026-11-13", lvFamilyIncludes: "starship", launchTag: "2026-256" },
      retired: false,
      cataloguedMassKg: 0,
      estimatedMassKg: 15450,
      markdown: "ESTIMATED / provisional.\n26 x 1,500 = 39,000 kg booked.",
    },
    {
      id: "starship-flight-14",
      launchDate: "2026-09-28",
      launchDateTimeUtc: "2026-09-28T12:48:59Z",
      vehicle: "Starship",
      lvFamilyIncludes: "starship",
      site: "Starbase",
      siteClass: "starbase",
      payloadName: "Starlink Group 31-1",
      payloadCount: 26,
      perSatMassKg: 1500,
      perSatLowKg: 1500,
      perSatHighKg: 2500,
      massKg: 39000,
      massLowKg: 39000,
      massHighKg: 65000,
      basis: "estimated",
      sourceUrls: ["https://www.spacex.com/launches/starship-flight-14"],
      note: "Retired example.",
      calc: {
        title: "Starship Flight 14 — Starlink V3 provisional mass",
        formula: "26 × 1,500 kg = 39,000 kg booked",
        inputs: [
          { name: "Satellite count", value: "26 Starlink V3", kind: "published", source: "https://www.spacex.com/launches/starship-flight-14" },
        ],
        resultKg: 39000,
        rangeKg: [39000, 65000],
        markdownPath: "provisional-calcs/starship-flight-14.md",
      },
      match: { ldate: "2026-09-28", lvFamilyIncludes: "starship", launchTag: "2026-225" },
      retired: true,
      cataloguedMassKg: 41000,
      estimatedMassKg: 0,
      markdown: "retired write-up",
    },
  ],
};

vi.mock("@workspace/api-client-react", () => ({
  useGetSatcatStats: () => ({
    isLoading: false,
    isError: false,
    data: {
      byYear: [],
      byCountry: [],
      byOrbit: [],
      byObjectClass: [],
      byLaunchVehicle: [],
      byGunterType: [],
      gunterCoverage: { matchedPayloads: 0, totalPayloads: 0 },
    },
  }),
  useGetSatcatByYearProvider: () => ({ isLoading: true, isError: false, data: undefined }),
  useGetSatcatFalconVsStarship: () => ({
    isLoading: false,
    data: {
      starshipTotal: 0,
      rows: [{ year: "2026", falcon: 0, starship: 0, pendingFalcon: 0, pendingStarship: 39000 }],
    },
  }),
  useGetSatcatSpacexBySite: () => ({ isLoading: true, data: undefined }),
  useGetSatcatSpacexBySiteMonthly: () => ({ isLoading: false, data: undefined }),
  useGetSatcatSpacexByEntity: () => ({ isLoading: true, data: undefined }),
  useGetSatcatLaunchRate: () => ({ isLoading: true, isError: false, data: undefined }),
  useGetSatcatProvisionalManifest: () => ({ isLoading: false, isError: false, data: manifest }),
  getGetSatcatFalconVsStarshipQueryKey: () => ["falcon"],
  getGetSatcatProvisionalManifestQueryKey: () => ["provisional"],
  getGetSatcatSpacexBySiteQueryKey: () => ["site"],
  getGetSatcatSpacexBySiteMonthlyQueryKey: () => ["site-month"],
  getGetSatcatSpacexByEntityQueryKey: () => ["entity"],
  getGetSatcatLaunchRateQueryKey: () => ["rate"],
}));

describe("provisional estimates section", () => {
  it("publishes the calculation, tagged inputs, and the auto-retire note", () => {
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
    render(<Analytics />);

    expect(screen.getByText(/Provisional estimates — how we got these numbers/i)).toBeInTheDocument();
    expect(screen.getAllByText(/replaced automatically once GCAT lists a payload mass/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /Starship Flight 15/i })).toBeInTheDocument();
    expect(screen.getAllByText("published").length).toBeGreaterThan(0);
    expect(screen.getAllByText("derived").length).toBeGreaterThan(0);
    expect(screen.getAllByText("editorial").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/26 × 1,500 kg = 39,000 kg booked/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/39,000 kg/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/39,000–65,000 kg/).length).toBeGreaterThan(0);
    const source = screen.getAllByRole("link", { name: "https://www.spacex.com/launches/starship-flight-15" });
    expect(source.length).toBeGreaterThan(0);
    expect(source[0]).toHaveAttribute("href", "https://www.spacex.com/launches/starship-flight-15");
    expect(screen.getByText(/Retired — GCAT has the mass/i)).toBeInTheDocument();
    expect(screen.getByText(/41,000 kg of catalogued payload mass/i)).toBeInTheDocument();
    expect(screen.getByText(/Bureau estimates are not included/i)).toBeInTheDocument();
    expect(screen.getByText(/15,450 kg of Bureau estimates/i)).toBeInTheDocument();
    expect(screen.getByText(/does not count as catalogued/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Provisional \(estimated, not yet catalogued\)/i).length).toBeGreaterThan(0);
  });
});
