---
name: Orval path+query params collision
description: Why an OpenAPI operation with BOTH path and query params breaks the api-zod build (TS2308)
---

Rule: in `lib/api-spec/openapi.yaml`, never give one operation both path parameters and query parameters. Use query-only (or path-only) parameter sets.

**Why:** Orval emits a Zod const `<OpIdPascal>Params` (path params) into `generated/api.ts` and a TS type `<OpIdPascal>Params` (query params) into `generated/types/`. The `lib/api-zod` barrel `export *`s both, so the names collide → `TS2308: Module "./generated/api" has already exported a member named '<OpIdPascal>Params'` during the codegen-chained `typecheck:libs`.

**How to apply:** when an endpoint needs an id plus query filters, move the id into the query string (e.g. `/satcat/passes?norad=...&lat=...`) instead of `/satcat/passes/{norad}?lat=...`.
