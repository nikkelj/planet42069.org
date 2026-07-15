# Other Jonathan's Space Report

**PLANET 42069 // Orbital Bureaucracy Command**

Live at [www.planet42069.org](https://www.planet42069.org) · On X: [@OrbitalBureau](https://x.com/OrbitalBureau)

A parody "Space Police" publication. The Bureau files deadpan bureaucratic reports, official complaints, and case studies about real spaceflight events — all backed by real data from [Jonathan McDowell's GCAT](https://planet4589.org/space/gcat/) (General Catalog of Artificial Space Objects). The satire is fictional; the numbers are not.

## What's on the site

- **Briefing** — the docket: field bulletins, missing property reports, official complaints, and case studies (e.g. Case #CADENCE-0135, *The Missing Exponential*, on why the Shuttle lost its launch-rate curve and Falcon 9 kept it).
- **Mass Analytics** — charts of mass-to-orbit by launch site, customer segment, and vehicle; launch cadence by provider; the Shuttle vs Falcon 9 cadence comparison with annotated events.
- **Satcat Explorer** — browse the satellite catalog itself.

## How it works

This is a pnpm monorepo:

| Package | What it is |
| --- | --- |
| `artifacts/space-report` | The website — React + Vite, Tailwind, Recharts |
| `artifacts/api-server` | Express 5 API — fetches and parses GCAT catalogs live, serves analytics endpoints |
| `lib/api-spec` | OpenAPI spec + Orval codegen for typed API hooks |
| `artifacts/mockup-sandbox` | Internal design-preview tooling (not part of the product) |

There is no database — the API server pulls GCAT data over HTTP and caches parsed catalogs in memory.

## Running locally

Requires Node.js 24+ and pnpm.

```sh
pnpm install
pnpm --filter @workspace/api-server run dev    # API server
pnpm --filter @workspace/space-report run dev  # website
```

Other useful commands:

```sh
pnpm run typecheck                                  # typecheck all packages
pnpm --filter @workspace/api-spec run codegen       # regenerate API client from openapi.yaml
node artifacts/space-report/scripts/generate-share-pages.mjs  # rebuild social share pages
```

## Credits & disclaimer

- All catalog data: Jonathan McDowell's GCAT, used with gratitude.
- The Orbital Bureaucracy Command is not a real agency. No satellites were detained in the making of this website.

## License

MIT — see [LICENSE](LICENSE).
