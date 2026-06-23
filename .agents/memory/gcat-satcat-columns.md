---
name: GCAT satcat column quirks
description: Real column names and status/state codes for satcat.tsv from planet4589.org
---

TSV columns (lowercase): `jcat`, `satcat`, `type` (P/R/D objectClass), `name`, `plname`, `ldate` (format "1957 Oct  4" → parsed to ISO), `ddate`, `status` (satState), `owner`, `state` (country), `mass`, `perigee`, `apogee`, `inc`, `oporbit`

Status (satState) codes for operational: `"O"` and `"OX"` — NOT substring "op" or "active".

Date format: "1957 Oct  4" — parseLDate() converts to "YYYY-MM-DD".

Orbit normalization: LLEO/I → LEO, GEO/S → GEO, etc. via normaliseOrbit().

No LV/LVFamily column in satcat.tsv — always null. Needs cross-reference to GCAT launch.tsv for launch vehicle data.

**Why:** GCAT tsv header has 42 columns with non-obvious lowercase names; status field uses single-letter codes not human-readable strings.

**How to apply:** Any new feature using satcat.tsv columns must use these exact lowercase names. Status filtering must check `state === 'O' || state === 'OX'`.
