# Other Jonathan's Space Report (PLANET 42069)

A parody "Space Police" website — Orbital Bureaucracy Command files deadpan bureaucratic reports, case studies, and complaints about real spaceflight events, backed by real data from Jonathan McDowell's GCAT catalog. Live at https://www.planet42069.org · X: @OrbitalBureau.

## Run & Operate

- `pnpm --filter @workspace/space-report run dev` — run the website (main artifact)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `node artifacts/space-report/scripts/generate-share-pages.mjs` — regenerate static social share pages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind, shadcn/ui, Recharts, wouter
- API: Express 5
- Validation: Zod (`zod/v4`)
- API codegen: Orval (from OpenAPI spec at `lib/api-spec/openapi.yaml`)

## Where things live

- `artifacts/space-report/` — the website: `src/pages/home.tsx` (briefing docket — all report/case-study sections live here), `src/pages/analytics.tsx` (Mass Analytics charts), satcat explorer; chart components in `src/components/`
- `artifacts/api-server/src/routes/satcat.ts` — all GCAT-backed data endpoints (satcat summary, mass analytics, launch cadence, shuttle-vs-falcon comparison)
- `lib/api-spec/openapi.yaml` — API contract source of truth; run codegen after editing
- `artifacts/space-report/scripts/share-cards.json` + `generate-share-pages.mjs` — social share card definitions and generator; output in `public/r/`
- `artifacts/mockup-sandbox/` — canvas component preview sandbox (design tooling, not part of the product)

## Architecture decisions

- Data comes live from GCAT (planet4589.org) fetched/parsed server-side; no database — the API server caches parsed catalogs in memory.
- Reports on the homepage are anchored sections (`/#<case-id>`); crawlers can't see hash fragments, hence the static share-page system (see Gotchas).
- Event annotations for charts (e.g. Shuttle/Falcon cadence) are hardcoded in the API route next to the data they annotate, so chart and briefing copy stay consistent with catalog counts.

## Product

- **Briefing** (home): dossier index + parody reports — field bulletins, complaints, case studies (e.g. CADENCE-0135 "The Missing Exponential").
- **Mass Analytics**: charts of mass-to-orbit by site/customer/vehicle, launch cadence by provider, Shuttle vs Falcon 9 cadence case study.
- **Satcat Explorer**: browse the satellite catalog.
- **X presence**: @OrbitalBureau posts report links and snarky quote-posts; tweet text is always user-approved before posting.

## User preferences

- Always confirm tweet text with the user (via a yes/no prompt) before posting to X.
- Humor register: deadpan bureaucratic parody — permits, filings, dockets, case numbers; snark grounded in real catalog data.

## Gotchas

- **X/social share cards for reports**: report links use hash fragments (`/#jcat-0001`) which crawlers never see, so every report gets its own static share page at `/r/<case-id>.html` with its own OG tags + instant redirect. Must be a flat `.html` file — production only serves real files on exact filename match; directory URLs (`/r/<id>/`) get swallowed by the SPA fallback. To add a card for a NEW report: add an entry to `artifacts/space-report/scripts/share-cards.json`; optionally capture a per-report card graphic (1280x720 screenshot of the app at `/#<case-id>`, saved as `artifacts/space-report/public/r/<case-id>.jpg` — the generator auto-uses it, falling back to the generic `opengraph.jpg`); run `node artifacts/space-report/scripts/generate-share-pages.mjs`; republish; post links as `www.planet42069.org/r/<case-id>.html`.
- Social card images must be served from `www.planet42069.org` — the `.replit.app` domain serves a platform-level `robots.txt` `Disallow: /` (blocks Twitterbot), and the bare apex `planet42069.org` refuses connections (only www is wired up).
- Building space-report manually requires env vars: `PORT=<any> BASE_PATH=/ pnpm --filter @workspace/space-report run build`.
- X posting is done via `twitter-api-v2` with the `X_API_KEY`/`X_API_SECRET`/`X_ACCESS_TOKEN`/`X_ACCESS_TOKEN_SECRET` secrets (bash/node, not the code sandbox). Editing a tweet = delete + repost with a cache-buster URL.
- GitHub repo: `nikkelj/planet42069.org` (pushed via the Replit GitHub integration).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
