---
name: space-track TLE fetching
description: Working patterns for per-object GP/TLE queries against space-track.org
---

- Per-NORAAD element sets come from the `gp` class: `/basicspacedata/query/class/gp/NORAD_CAT_ID/{id}/orderby/EPOCH%20desc/limit/1/format/json` — returns TLE_LINE1/2 plus parsed elements (RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, ECCENTRICITY, MEAN_MOTION, EPOCH without trailing Z).
- Rate limits are strict (<30 req/min, <300 req/hr): cache elsets ~6h, cache misses ~1h, reuse the login cookie ~2h, and serialize outbound requests with a ≥2s gap (see `artifacts/api-server/src/lib/tle.ts`).
- A 401/403 mid-session means the cookie expired — drop it and re-auth rather than failing.

**Why:** space-track bans accounts that hammer the API; the credentials are the user's personal account.
