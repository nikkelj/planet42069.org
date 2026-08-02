/**
 * GroundTrackMap — the 2D world-map ground track shown when a visitor
 * selects a pass in the pass finder.
 *
 * Uses a real ISS element set and a pass window near its epoch, so SGP4
 * propagation is exercised for real: the highlighted pass segment, the
 * dashed context track, and the observer marker must all render.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import GroundTrackMap from "@/components/GroundTrackMap";

// ISS (ZARYA) elset, epoch 2024-01-01ish
const LINE1 = "1 25544U 98067A   24001.50000000  .00016717  00000-0  30229-3 0  9995";
const LINE2 = "2 25544  51.6416 252.0970 0006703 130.5360 325.0288 15.49521063429399";

const PASS = {
  // ~10-minute window shortly after the elset epoch
  startTime: "2024-01-01T13:00:00.000Z",
  endTime: "2024-01-01T13:10:00.000Z",
};

const OBSERVER = { lat: 42.36, lon: -71.06 };

describe("GroundTrackMap", () => {
  it("renders the map with a highlighted pass segment and observer marker", () => {
    const { container } = render(
      <GroundTrackMap line1={LINE1} line2={LINE2} observer={OBSERVER} pass={PASS} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();

    // continents drawn
    expect(container.querySelectorAll("path").length).toBeGreaterThan(100);

    // highlighted (solid, primary) pass segment and dashed context track
    const solid = [...container.querySelectorAll("path")].filter(
      (p) => p.getAttribute("stroke") === "hsl(var(--primary))",
    );
    const dashed = [...container.querySelectorAll("path")].filter(
      (p) => p.getAttribute("stroke-dasharray"),
    );
    expect(solid.length).toBeGreaterThan(0);
    expect(dashed.length).toBeGreaterThan(0);

    // every track vertex projects inside the viewBox
    for (const p of [...solid, ...dashed]) {
      const nums = (p.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)!.map(Number);
      for (let i = 0; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(0);
        expect(nums[i]).toBeLessThanOrEqual(720);
        expect(nums[i + 1]).toBeGreaterThanOrEqual(0);
        expect(nums[i + 1]).toBeLessThanOrEqual(360);
      }
    }

    // observer crosshair
    expect(container.querySelector("circle[fill='hsl(var(--accent))']")).toBeTruthy();

    expect(screen.getByText(/ground track/i)).toBeTruthy();
  });

  it("shows a fallback message when the pass window is malformed", () => {
    render(
      <GroundTrackMap
        line1={LINE1}
        line2={LINE2}
        observer={OBSERVER}
        pass={{ startTime: "not-a-date", endTime: "also-not" }}
      />,
    );
    expect(screen.getByText(/ground track unavailable/i)).toBeTruthy();
  });
});
