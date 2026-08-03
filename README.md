# Other Jonathan's Space Report

**PLANET 42069 // Orbital Bureaucracy Command**

Live at [www.planet42069.org](https://www.planet42069.org) · On X: [@OrbitalBureau](https://x.com/OrbitalBureau)

A parody "Space Police" publication. The Bureau files deadpan bureaucratic reports, official complaints, and case studies about real spaceflight events — all backed by real data from [Jonathan McDowell's GCAT](https://planet4589.org/space/gcat/) (General Catalog of Artificial Space Objects), [Space-Track](https://www.space-track.org/), and [Gunter's Space Page](https://space.skyrocket.de/). The satire is fictional; the numbers are not.

## What's on the site

- **Briefing** — the docket: field bulletins, missing property reports, official complaints, and case studies (e.g. Case #CADENCE-0135, *The Missing Exponential*, on why the Shuttle lost its launch-rate curve and Falcon 9 kept it).
- **Mass Analytics** — charts of mass-to-orbit by launch site, customer segment, and vehicle; launch cadence by provider; the Shuttle vs Falcon 9 cadence comparison with annotated events.
- **Satcat Explorer** — browse the merged satellite catalog (GCAT + Space-Track), with full country names, satellite-type details from Gunter's Space Page, and overhead pass predictions for your location.
- **RPOD Watch** — automated proximity-operations screening: the Bureau's TLE archive is scanned hourly for satellites closing ranks in orbit; cases get filed, tracked, filtered by kind/status/country, and — for genuinely new cases in production — cited publicly on X.
- **Constellations** — constellation-level views of the catalog.

## How it works

This is a pnpm monorepo:

| Package | What it is |
| --- | --- |
| `artifacts/space-report` | The website — React + Vite, Tailwind, Recharts |
| `artifacts/api-server` | Express 5 API — merges GCAT, Space-Track, and Gunter's Space Page data into a PostgreSQL catalog; runs background workers (TLE archive backfill, RPOD screening, polite Gunter crawl); serves analytics, catalog, pass-prediction, and RPOD endpoints |
| `lib/api-spec` | OpenAPI spec + Orval codegen for typed API hooks |
| `lib/db` | Drizzle schema and database client |
| `artifacts/mockup-sandbox` | Internal design-preview tooling (not part of the product) |

Data lives in PostgreSQL: a merged object catalog (GCAT + Space-Track, deduped by NORAD id), a retention-managed TLE history archive (~2-year horizon, thinned with age), and RPOD case records. Space-Track credentials (`SPACETRACK_USERNAME`/`SPACETRACK_PASSWORD`) are required for TLE ingest; X API secrets are required only for posting citations.

## Running locally

Requires Node.js 24+, pnpm, and a PostgreSQL database (`DATABASE_URL`).

```sh
pnpm install
pnpm --filter @workspace/api-server run dev    # API server
pnpm --filter @workspace/space-report run dev  # website
```

Other useful commands:

```sh
pnpm run typecheck                                  # typecheck all packages
pnpm --filter @workspace/api-spec run codegen       # regenerate API client from openapi.yaml
pnpm --filter @workspace/api-server run test:rpod   # RPOD screening/API test suite
pnpm --filter @workspace/api-server run test:passes # pass-prediction accuracy tests
node artifacts/space-report/scripts/generate-share-pages.mjs  # rebuild social share pages
```

## Deployment

The site runs on Replit Autoscale at **www.planet42069.org** (only the `www` subdomain is wired up; the bare apex does not resolve).

- Publish from the Replit workspace (Publish/Deploy button). The build compiles all packages; the API server bundles with esbuild (native modules like `@resvg/resvg-js` stay external) and the website builds with Vite (`worker.format: "es"` is required for the satellite.js WASM worker).
- Production needs these secrets set in the deployment: `DATABASE_URL`, `SESSION_SECRET`, `SPACETRACK_USERNAME`, `SPACETRACK_PASSWORD`, and (for X citations) `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`.
- Automated RPOD citation posts only fire in production (`NODE_ENV=production`), capped at 5/day, never for docked stacks or co-launched formations.
- After adding a new report/case study, regenerate the static share pages (`generate-share-pages.mjs`) before republishing so X/social link previews work — report links use hash fragments crawlers can't see.

## Credits & disclaimer

- Catalog data: Jonathan McDowell's GCAT, used with gratitude; orbital elements from Space-Track; satellite details from Gunter's Space Page (Krebs), cited per their usage policy.
- The Orbital Bureaucracy Command is not a real agency. No satellites were detained in the making of this website.

## License

MIT — see [LICENSE](LICENSE).
