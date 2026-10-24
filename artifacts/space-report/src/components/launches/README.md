# LaunchGlobe — integration note (for the Launches page)

```tsx
import LaunchGlobe from "@/components/launches/LaunchGlobe";
// top of the Launches page, above the table/downloads:
<LaunchGlobe />            // props: indexUrl="/launches/index.json", height=560, defaultOpen=true
```

Static import is fine. The shell is ~2 KB. three.js and the scene (`LaunchGlobeCanvas`) are
code-split with `React.lazy`, and they're imported only after first paint and idle, once the block is within 200px
of the viewport. The globe reads `index.json` and each launch's `files.track_lite` (~8 KB decimated
JSON, ≤600 pts/method). It never fetches the full CSVs.

Assets: `public/launches/globe/` holds the 512px placeholders (≈20 KB), which swap to 4K WebP (day 720 KB, night 174 KB), plus
`fallback.png`, which is shown when WebGL is unavailable. Rebuild tracks and textures with
`python3 scripts/build_launch_globe_assets.py [--textures day.jpg night.jpg]`. Run it after each new batch.

Features: day/night shading with the real sun direction for now, city lights, ocean glint, atmosphere rim, and a starfield.
Tracks are glowing fat lines (solid = recent, dashed = upcoming). Pad markers, an animated trace head, and a per-launch legend
toggle are included. You can switch between surrogate, 3DOF sim, or both, and between alt ×8 and true altitude. Hover or tap a track for its tooltip.
Perf: renders on demand, pauses when the tab is hidden or the globe is offscreen, caps DPR at 2, disposes everything on unmount,
and turns the trace off under prefers-reduced-motion.
Texture credits are in `index.json` references: `nasa-bluemarble`, `nasa-blackmarble`, `threejs`.
