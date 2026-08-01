---
name: Stale composite builds in shared libs
description: Typecheck errors claiming fields "don't exist" on workspace types usually mean a stale tsc composite dist, not bad source.
---
Shared libs (`lib/db`, `lib/api-zod`, `lib/api-client-react`) are composite TS projects emitting declarations to `dist/`. Downstream artifact typechecks (`tsc -p --noEmit`) resolve those stale `.d.ts` files and can report properties "missing" on types (e.g. schema columns, generated API fields) even though the source is correct.

**Why:** `tsc -p --noEmit` does not rebuild project references; a lib edited without `tsc -b` leaves outdated declarations behind, which also fails completion validation workflows.

**How to apply:** when a typecheck complains a known-present field doesn't exist on a `@workspace/*` type, run `pnpm exec tsc -b lib/<pkg>` for the affected lib(s) and re-run the typecheck before hunting for code bugs. Note `lib/api-spec` has no tsconfig — don't include it in `tsc -b`.
