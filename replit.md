# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **X/social share cards for reports**: report links use hash fragments (`/#jcat-0001`) which crawlers never see, so every report gets its own static share page at `/r/<case-id>.html` with its own OG tags + instant redirect. Must be a flat `.html` file — production only serves real files on exact filename match; directory URLs (`/r/<id>/`) get swallowed by the SPA fallback. To add a card for a NEW report: add an entry to `artifacts/space-report/scripts/share-cards.json`; optionally capture a per-report card graphic (1280x720 screenshot of the app at `/#<case-id>`, saved as `artifacts/space-report/public/r/<case-id>.jpg` — the generator auto-uses it, falling back to the generic `opengraph.jpg`); run `node artifacts/space-report/scripts/generate-share-pages.mjs`; republish; post links as `www.planet42069.org/r/<case-id>.html`.
- Social card images must be served from `www.planet42069.org` — the `.replit.app` domain serves a platform-level `robots.txt` `Disallow: /` (blocks Twitterbot), and the bare apex `planet42069.org` refuses connections (only www is wired up).
- Building space-report manually requires env vars: `PORT=<any> BASE_PATH=/ pnpm --filter @workspace/space-report run build`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
