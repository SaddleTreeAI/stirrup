# Editions

An edition is an optional product skin layered on the shared Stirrup core: web UI slots and server hooks that live under `editions/<id>/`, selected by `STIRRUP_EDITION` (default `default`). With the variable unset or set to `default`, behavior matches core Stirrup.

## Selection

- **Web (build time).** Vite resolves `@edition/web` to `editions/<id>/src/web.ts`. Editors and `tsc` always see the default edition via `apps/web/tsconfig.json`. Core web code imports only through `apps/web/src/edition.ts`.
- **API and worker (runtime).** Each process loads a static registry in `apps/api/src/edition/active.ts` and `apps/worker/src/edition/active.ts`, then calls `getEdition()` after `loadRootEnv()` so `STIRRUP_EDITION` is available.

## Seams

Core files must not grow edition behavior. When core must call into an edition, keep the change small (about ten lines), mark it with `// edition-seam:<ID>` (for example `// edition-seam:A1-web`), and avoid edition-specific wording in core. Only the listed seam files may import `@rakazo/edition-*` or `@edition/web`; `scripts/checks/edition-seams.test.mjs` enforces that.

## Adding an edition

1. Copy `editions/default` to `editions/<id>` and rename the package.
2. Register it in both `active.ts` registries under the same id.
3. The web Vite alias needs no change: it already points at `editions/$STIRRUP_EDITION/src/web.ts`.

## Running

```bash
STIRRUP_EDITION=law pnpm dev
```
