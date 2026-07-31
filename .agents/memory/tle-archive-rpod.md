---
name: TLE archive & RPOD screening lessons
description: Durable quirks from building the space-track TLE history archive and RPOD event detection
---

- **space-track publishes future-dated epochs** (seen ~2 weeks ahead in the gp class). Any "advance watermark to max epoch seen" logic must clamp at `now()` or it silently skips everything in between.
  - **How to apply:** whenever consuming EPOCH-ordered feeds, cap cursors/watermarks at current time.
- **Backward-walking gp_history backfill must order EPOCH desc.** With `asc` + row limit, a capped chunk leaves the *newest* part of the interval unfetched while the cursor moves past it, creating permanent gaps. With `desc`, coverage stays contiguous with the already-covered future side; on overflow resume just below the oldest received epoch.
- **Cluster pairs, not members.** Union-find for multi-craft event clustering must operate on *pairs* as nodes (union when pairs share a member AND TCAs are within the merge window). Unioning member IDs directly makes the time-window condition vacuous (each pair's own TCA always matches itself) and fuses temporally separate operations of the same craft.
- **Any polite-crawl/scan worker needs a Postgres advisory lock** so request budgets hold across autoscaled instances — an in-process singleton is not enough.
  - **Why:** autoscale deployments run multiple instances; each would otherwise run its own scheduler and multiply upstream traffic.
- **Docked station stacks (ISS, Tiangong) appear as permanent ~0 km multi-craft "RPOD events".** Expected physics, but they must be labeled/filtered or they drown out real proximity operations.
- **Coplanar "shadowing" detection can't rely on geometry alone.** Plane + radial-shell overlap yields ~143k pairs catalog-wide; even 0.1° plane match leaves 100+ events. The workable gates, calibrated on a known shadowing pair (Δinc 0.073°, ΔRAAN 0.061°, Δa 5.4 km, ~175 km in-track): along-track phase within a few degrees (THE big cut), both members payloads (class P), different launches (co-launched formations are routine), and same-mega-constellation names excluded via an explicit list — never a generic name-prefix rule, or catch-all "Kosmos-NNNN" inspector pairs get hidden.
- **Sustained-range is NOT a shadowing discriminator:** even a real shadowing pair drifts hundreds of km/day between TLE refreshes; range at window edges looks like noise pairs.
- **R3F gotcha:** `useFrame` callbacks still run when the component returns `null` — guard array-length assumptions inside the callback, not just in the render path.
