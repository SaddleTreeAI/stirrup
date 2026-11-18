# Editions

An edition is an optional product skin layered on the shared Stirrup core: web UI slots and server hooks that live under `editions/<id>/`, selected by `STIRRUP_EDITION` (default `default`). With the variable unset or set to `default`, behavior matches core Stirrup.

## Selection

- **Web (build time).** Vite resolves `@edition/web` to `editions/<id>/src/web.ts`. Editors and `tsc` always see the default edition via `apps/web/tsconfig.json`. Core web code imports only through `apps/web/src/edition.ts`.
- **API and worker (runtime).** Each process loads a static registry in `apps/api/src/edition/active.ts` and `apps/worker/src/edition/active.ts`, then calls `getEdition()` after `loadRootEnv()` so `STIRRUP_EDITION` is available.

## Seams

Core files must not grow edition behavior. When core must call into an edition, keep the change small (about ten lines), mark it with `// edition-seam:<ID>` (for example `// edition-seam:A1-web`), and avoid edition-specific wording in core. Only the listed seam files may import `@rakazo/edition-*` or `@edition/web`; `scripts/checks/edition-seams.test.mjs` enforces that.

| Id        | File                                                                                   | Role                                                |
| --------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| A1-web    | `apps/web/vite.config.ts`, `vitest.config.ts`                                          | Web edition Vite alias and test resolution          |
| A1-server | `apps/api/src/edition/active.ts`, `apps/worker/src/edition/active.ts`                  | Server edition registry                             |
| R0        | `packages/adapters/src/executor-deps.ts`, `packages/adapters/src/edition-run-hooks.ts` | Optional `editionRunHooks` on executor deps         |
| R1        | `packages/adapters/src/run-assembly-context.ts`                                        | `turnNote` appended to the turn prompt              |
| R2        | `packages/adapters/src/run-assembly-context.ts`                                        | `limitTeammates` before the bot directory           |
| R3        | `packages/adapters/src/run-turn.ts`                                                    | `onReplyFinalized` after a successful reply         |
| R4        | `packages/adapters/src/run-turn.ts`, `packages/adapters/src/run-progress.ts`           | `streamsProgress` may flush progress while scripted |
| S1        | `apps/api/src/index.ts`, `apps/worker/src/index.ts`                                    | `onProcessStart` after env load                     |
| S2        | `apps/api/src/app.ts`                                                                  | `mountRoutes` beside other HTTP mounts              |
| S3        | `apps/api/src/app.ts`, `apps/worker/src/index.ts`                                      | Pass `runHooks` into `createRunRuntime`             |
| S4        | `apps/api/src/app.ts`, `apps/worker/src/index.ts`                                      | Optional `agentRuntime` before Pi                   |
| S5        | `apps/api/src/app.ts`                                                                  | `afterBootstrap` after deployment settings upsert   |

## Adding an edition

1. Copy `editions/default` to `editions/<id>` and rename the package.
2. Register it in both `active.ts` registries under the same id.
3. The web Vite alias needs no change: it already points at `editions/$STIRRUP_EDITION/src/web.ts`.

## Running

```bash
STIRRUP_EDITION=law pnpm dev
```

## Database

Editions can add Prisma models and SQL migrations without editing `packages/db/prisma/schema.prisma` or `packages/db/prisma/migrations/`.

1. **Types.** The Prisma client is always generated from the core schema plus every edition's model file under `editions/*/db/*.prisma`. All packages typecheck in every build; unused edition tables simply do not exist in other editions' databases.
2. **Tables.** Migrations applied are core migrations plus only the active edition's migrations under `editions/<id>/db/migrations/*`. Edition migration directory names start with `9999` (for example `99990001000000_…`) so they sort after every core migration.
3. **Scalar-only models.** Edition models use scalar fields only (no Prisma relations to core models), so the core schema never needs back-relations.
4. **Output.** `node scripts/editions/prepare-db.mjs` writes a generated, gitignored tree at `packages/db/prisma/.edition/`. With `STIRRUP_EDITION` unset (or `default`), tooling behaves as today: the prepared schema equals the core schema, and core migrations are used.

```bash
node scripts/editions/prepare-db.mjs [--edition <id>]
STIRRUP_EDITION=<id> pnpm --filter @rakazo/db generate
pnpm db:migrate
```

Always run `STIRRUP_EDITION=<id> pnpm --filter @rakazo/db generate` before `pnpm db:migrate` for a non-default edition so `.edition/migrations` matches. Edition migration SQL must not start with `-- deferred` (that marker is for core deferred drops). Do not run `migrate:dev` while edition models exist: it diffs the merged schema and would invent core migrations for edition tables.

To add an edition model: create `editions/<id>/db/<id>.prisma` with scalar fields only, then add a migration directory under `editions/<id>/db/migrations/` whose name starts with `9999`.
