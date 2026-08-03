/**
 * CaseTimeline — one visual interval per shadowing spell.
 *
 * A reopened RPOD case carries a `spells` list from /rpod/events/:id
 * (closed spells plus the current one). The timeline must draw a
 * separate bar for each spell, with visibly distinct gap segments
 * between them — never one merged continuous bar.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CaseTimeline } from "@/pages/rpod";

const T = (h: number) => new Date(Date.UTC(2026, 6, 1, h)).toISOString();

describe("CaseTimeline spell rendering", () => {
  it("draws one bar per spell (2 closed + current) with gaps between", () => {
    render(
      <CaseTimeline
        firstDetectedAt={T(0)}
        lastSeenAt={T(60)}
        endedAt={null}
        status="active"
        spells={[
          { start: T(0), lastSeenAt: T(10), endedAt: T(12) },
          { start: T(20), lastSeenAt: T(30), endedAt: T(32) },
          { start: T(40), lastSeenAt: T(60), endedAt: null },
        ]}
      />,
    );

    // one visual interval per spell — the current spell included
    const bars = screen.getAllByTestId("timeline-spell");
    expect(bars).toHaveLength(3);

    // gaps between spells are separate, visibly distinct segments
    const gaps = screen.getAllByTestId("timeline-gap");
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) {
      expect(gap.className).toContain("border-dashed");
      expect(gap.className).not.toContain("bg-primary");
    }

    // bars and gaps alternate: obs, gap, obs, gap, obs
    const container = bars[0].parentElement!;
    const kinds = Array.from(container.children).map((el) =>
      (el as HTMLElement).dataset.testid,
    );
    expect(kinds).toEqual([
      "timeline-spell",
      "timeline-gap",
      "timeline-spell",
      "timeline-gap",
      "timeline-spell",
    ]);

    // every segment has non-zero width so short spells stay visible
    for (const el of container.children) {
      const w = parseFloat((el as HTMLElement).style.width);
      expect(w).toBeGreaterThan(0);
    }

    // header calls out the spell count
    expect(screen.getByText(/3 separate shadowing spells/)).toBeInTheDocument();
  });

  it("marks the trailing closure gap distinctly on an ended reopened case", () => {
    render(
      <CaseTimeline
        firstDetectedAt={T(0)}
        lastSeenAt={T(40)}
        endedAt={T(48)}
        status="ended"
        spells={[
          { start: T(0), lastSeenAt: T(10), endedAt: T(12) },
          { start: T(20), lastSeenAt: T(40), endedAt: T(48) },
        ]}
      />,
    );

    expect(screen.getAllByTestId("timeline-spell")).toHaveLength(2);
    expect(screen.getAllByTestId("timeline-gap")).toHaveLength(1);
    const finalGap = screen.getByTestId("timeline-final-gap");
    expect(finalGap.className).toContain("border-destructive/50");
  });

  it("renders a single continuous bar with no gaps for a never-reopened case", () => {
    render(
      <CaseTimeline
        firstDetectedAt={T(0)}
        lastSeenAt={T(24)}
        endedAt={null}
        status="active"
        spells={[{ start: T(0), lastSeenAt: T(24), endedAt: null }]}
      />,
    );

    expect(screen.getAllByTestId("timeline-spell")).toHaveLength(1);
    expect(screen.queryByTestId("timeline-gap")).toBeNull();
    expect(screen.queryByTestId("timeline-final-gap")).toBeNull();
  });
});
