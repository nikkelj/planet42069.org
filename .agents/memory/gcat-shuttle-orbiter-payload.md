---
name: GCAT counts Shuttle orbiter as payload
description: Why Space Shuttle dominates mass-to-orbit charts computed from GCAT payload rows
---

GCAT catalogs the Space Shuttle orbiter itself as a payload-class object (objectClass P, Type "PH") on every flight — one satcat row per mission, ~90–100t each, identifiable by PLName matching `OV-(099|10[2-5])`.

**Why:** Any mass-by-launch-vehicle aggregation over payload rows inflates "Space Shuttle" to ~13,125t, of which ~12,911t (98.4%) is the orbiter fleet weighing itself; actual catalogued deployed cargo is only ~214t. Falcon 9's ~7,900t is all genuine payloads.

**How to apply:** When aggregating GCAT payload mass per vehicle/provider, either exclude or segment orbiter rows (PLName OV-xxx). The `/api/satcat/shuttle-audit` endpoint provides the split, including a theorized delivered-mass estimate using published orbiter dry masses (~78–81.6t each). The same class of quirk may apply to other crewed/reusable spacecraft catalogued as payloads (Soyuz, Crew Dragon capsules) — though those are legitimately delivered spacecraft, not reused launch hardware.
