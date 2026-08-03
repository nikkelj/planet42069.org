/**
 * PassFinder — the pass prediction list a visitor sees on a catalog row.
 *
 * The API hook is mocked so we test rendering only: one row per predicted
 * pass, the naked-eye visibility flag, the stale-TLE hint, and the
 * coordinate form when no observer location is set.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import PassFinder, { type PassRow } from "@/components/PassFinder";

const useGetSatcatPasses = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useGetSatcatPasses: (...args: unknown[]) => useGetSatcatPasses(...args),
  getGetSatcatPassesQueryKey: (p: unknown) => ["passes", p],
}));

const T = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 7, 2, h, m)).toISOString();

const passes: PassRow[] = [
  {
    startTime: T(2), maxTime: T(2, 5), endTime: T(2, 10),
    maxElevationDeg: 62, startAzDeg: 315, maxAzDeg: 0, endAzDeg: 45,
    visible: true,
  },
  {
    startTime: T(10), maxTime: T(10, 4), endTime: T(10, 8),
    maxElevationDeg: 21, startAzDeg: 180, maxAzDeg: 135, endAzDeg: 90,
    visible: false,
  },
];

const noop = () => {};
const baseProps = {
  norad: 25544,
  name: "ISS (ZARYA)",
  days: "3",
  onDaysChange: noop,
  onObserverChange: noop,
  selectedPass: null,
  onSelectPass: noop,
};

beforeEach(() => {
  useGetSatcatPasses.mockReset();
});

describe("PassFinder pass list", () => {
  it("renders one row per pass with visibility flags", () => {
    useGetSatcatPasses.mockReturnValue({
      data: { epoch: new Date().toISOString(), passes },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<PassFinder {...baseProps} observer={{ lat: 42.36, lon: -71.06 }} />);

    // header names the satellite
    expect(
      screen.getByText(/when can I see ISS \(ZARYA\)\?/i),
    ).toBeInTheDocument();

    // one body row per predicted pass
    const rows = screen.getAllByRole("row");
    // 1 header row + 2 pass rows
    expect(rows).toHaveLength(3);

    // naked-eye flag rendered per pass
    expect(screen.getByText(/^Visible$/i)).toBeInTheDocument();
    expect(screen.getByText(/In shadow \/ daylight/i)).toBeInTheDocument();

    // elevations shown
    expect(screen.getByText("62°")).toBeInTheDocument();
    expect(screen.getByText("21°")).toBeInTheDocument();
  });

  it("shows the coordinate form and no table when no observer is set", () => {
    useGetSatcatPasses.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<PassFinder {...baseProps} observer={null} />);

    expect(screen.getByPlaceholderText(/LAT/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/LON/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("flags a stale element set older than 24 h", () => {
    const staleEpoch = new Date(Date.now() - 3 * 86_400_000).toISOString();
    useGetSatcatPasses.mockReturnValue({
      data: { epoch: staleEpoch, passes },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<PassFinder {...baseProps} observer={{ lat: 0, lon: 0 }} />);

    // age label rendered in days, e.g. "3.0 d"
    expect(screen.getByText(/3\.0 d/)).toBeInTheDocument();
  });
});
