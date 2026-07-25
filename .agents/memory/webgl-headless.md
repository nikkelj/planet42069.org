---
name: WebGL in headless verification
description: Screenshot/testing browsers here have no WebGL; Three.js scenes can't be visually verified headlessly
---
The workspace screenshot tool and Playwright testing subagent browsers cannot create WebGL contexts, so react-three-fiber scenes render nothing there.
**Why:** observed July 2026 building the satcat 3D orbit viewer; Canvas failed with "Could not create a WebGL context".
**How to apply:** any Three.js component needs a WebGL-detect fallback UI (also good for users on weak devices); verify 3D math by code review + data readouts, not screenshots. Also: browsers hard-limit concurrent WebGL contexts — never mount one Canvas per table row; enforce a single expanded viewer.
