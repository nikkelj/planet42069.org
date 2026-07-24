---
name: OBC catalogue merge rules
description: Merged GCAT + space-track Postgres catalog — key scheme, sentinels, and sync gotchas
---

- Object key = GCAT JCAT id, or `ST<norad>` for space-track-only rows. Sync must dedupe: when GCAT later catalogs an ST-only norad, the ST row is deleted post-upsert (JOIN on norad where jcat is null).
- **Why:** upsert targets `key` only, so identity transitions would otherwise double-count mass in every analytics endpoint.
- ST-only rows use satState sentinel `"O?"` — do NOT treat as operational in `satState === "O" || "OX"` checks unless intended.
- Estimated masses carry `massEstimated=true` + `massEstMethod` (name-family → class+lvFamily → class medians); charts render them as 0.55-opacity "theorized" segments (estMassKg fields).
- space-track full satcat JSON fetch (~70k rows) takes ~5s; GCAT TSVs ~7s. Whole sync ≈ 25s. Analytics never fetch upstream on the request path — DB store with 10-min memory cache; empty catalog throws (Express 5 turns async throws into error responses).
