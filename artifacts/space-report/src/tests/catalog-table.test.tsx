/**
 * Catalog page — the satcat search result table.
 *
 * API hooks are mocked so we test rendering only: one row per catalog
 * entry, the JCAT prefix treatment, class badges, the estimated-mass
 * marker, record counts, and the loading / error / empty states.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Catalog from "@/pages/catalog";

const useGetSatcat = vi.fn();
const useGetSatcatFilters = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetSatcat: (...args: unknown[]) => useGetSatcat(...args),
  useGetSatcatFilters: (...args: unknown[]) => useGetSatcatFilters(...args),
  getGetSatcatQueryKey: (p: unknown) => ["satcat", p],
  useGetSatcatTle: () => ({ data: undefined }),
  getGetSatcatTleQueryKey: (n: unknown) => ["tle", n],
  useGetSatcatPasses: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
  getGetSatcatPassesQueryKey: (p: unknown) => ["passes", p],
}));

const entries = [
  {
    jcat: "S25544", satno: 25544, name: "ISS (ZARYA)", ldate: "1998-11-20",
    owner: "NASA", objectClass: "P", opOrbit: "LLEO/I",
    massKg: 419725, massEstimated: false, satState: "O",
  },
  {
    jcat: "S47251", satno: 47251, name: "MYSTERY CUBESAT", ldate: "2020-12-01",
    owner: "UNKN", objectClass: "D", opOrbit: "LEO/S",
    massKg: 4, massEstimated: true, satState: "D",
  },
];

const okData = {
  data: entries,
  total: 2,
  pages: 1,
  filteredMassKg: 419729,
  filteredEstMassKg: 4,
};

const filters = {
  objectClasses: ["P", "R", "D", "U"],
  orbits: ["LLEO/I", "LEO/S"],
  owners: ["NASA", "UNKN"],
  satStates: ["O", "D"],
  gunterTypes: [],
  gunterMatched: 0,
  totalObjects: 2,
};

beforeEach(() => {
  useGetSatcat.mockReset();
  useGetSatcatFilters.mockReset();
  useGetSatcatFilters.mockReturnValue({ data: filters });
  window.history.replaceState(null, "", "/");
});

describe("Catalog search result table", () => {
  it("renders one row per catalog entry with key columns", () => {
    useGetSatcat.mockReturnValue({ data: okData, isLoading: false, isError: false });

    render(<Catalog />);

    // both entries listed by name
    expect(screen.getByText("ISS (ZARYA)")).toBeInTheDocument();
    expect(screen.getByText("MYSTERY CUBESAT")).toBeInTheDocument();

    // class badges use human labels
    expect(screen.getByText("PAYLOAD")).toBeInTheDocument();
    expect(screen.getByText("DEBRIS")).toBeInTheDocument();

    // estimated mass carries the EST marker; real mass does not
    expect(screen.getByText("EST")).toBeInTheDocument();
    expect(screen.getByText("419,725")).toBeInTheDocument();

    // record count footer
    expect(screen.getByText(/of 2 records/i)).toBeInTheDocument();
  });

  it("shows a loading state while the query is in flight", () => {
    useGetSatcat.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    render(<Catalog />);

    expect(screen.queryByText("ISS (ZARYA)")).not.toBeInTheDocument();
    expect(screen.queryByText(/of \d+ records/i)).not.toBeInTheDocument();
  });

  it("renders the search controls with an empty result set", () => {
    useGetSatcat.mockReturnValue({
      data: { ...okData, data: [], total: 0, filteredMassKg: 0, filteredEstMassKg: 0 },
      isLoading: false,
      isError: false,
    });

    render(<Catalog />);

    expect(
      screen.getByPlaceholderText(/SEARCH NAME, JCAT, OR NORAD ID/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Execute Query/i)).toBeInTheDocument();
    expect(screen.queryByText("ISS (ZARYA)")).not.toBeInTheDocument();
  });
});
