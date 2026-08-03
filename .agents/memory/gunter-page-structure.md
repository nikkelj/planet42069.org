---
name: Gunter's Space Page structure & policy
description: How to parse space.skyrocket.de and the crawl/attribution rules we committed to
---

# Gunter's Space Page (space.skyrocket.de)

- Pages are served **iso-8859-1** — decode via arrayBuffer + `TextDecoder("iso-8859-1")`, not res.text().
- Chronology index pages: `doc_chr/lau<year>.htm` (1957→current). Discovery only — they link payload dossiers via `../doc_sdat/<slug>.htm`.
- Dossier pages (`doc_sdat/*.htm`): facts table `<table id="satdata">` with stable td ids `sdnat` (Nation), `sdtyp` (Type/Application), `sdope` (Operator), `sdcon` (Contractors); `<h1>` = title. Launch table `<table id="satlist">` has `<td class="cosid">` cells with COSPAR ids (`2023-026A`) — the join key to our catalog's intl_des.
- Site AI policy (meta on pages): RAG/summarization allowed **with attribution + link**. We store only type/nation/operator/contractors + cross-link; never prose/images.
- Citation format we must reproduce: `Krebs, Gunter D. "<title>". Gunter's Space Page. Retrieved <date>, from <url>`.
- Crawl etiquette committed to: identifying UA, ≥4s delay, ~30 fetches/day budget, 45-day dossier revisit. Steady paywall hook = optional `GUNTER_STEADY_COOKIE` secret (no login automation).
- **Why:** one-man subscription-funded site; politeness + attribution are conditions of use.
- **How to apply:** any future Gunter feature must go through the existing crawl store (obc_gunter_pages) and budgeted daily sync — never ad-hoc fetches.

## Ops lessons
- Gunter annotations live only in gunter_* columns of obc_objects; catalog merges rebuild rows, so annotations are re-applied from the crawl store after every merge (DB-only, no network).
- Crawl runs hold Postgres advisory lock 421069 on a dedicated pooled connection so autoscaled instances don't multiply the polite-crawl budget.
