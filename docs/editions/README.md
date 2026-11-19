# Editions

An edition is an optional product skin layered on the shared Stirrup core: web UI slots, server hooks, Prisma models, and migrations that live under `editions/<id>/`, selected by `STIRRUP_EDITION` (default `default`). With the variable unset, blank, or set to `default`, behavior matches core Stirrup.

## Run (law)

```bash
pnpm install
STIRRUP_EDITION=law pnpm --filter @rakazo/db generate
pnpm db:migrate
LAW_LOGIN_FILE=/tmp/law-login.txt pnpm --filter @rakazo/edition-law seed
pnpm dev:law
```

- **`pnpm dev:law`** — `cross-env STIRRUP_EDITION=law node scripts/dev.mjs`. Forwards the edition into child env, runs `prepare-db`, generates the client when needed, then migrates before starting api/worker/web.
- **`pnpm build:law`** — `cross-env STIRRUP_EDITION=law turbo build`.
- **Seed login** — `LAW_LOGIN_FILE` must resolve **outside** the repository. The seed writes `email=` / `password=` there (mode 600) and never prints the password.
- **Mock vs real key** — leave `LAW_OPENROUTER_API_KEY` unset for the slow streaming mock (`law-mock`). Set it to a real OpenRouter key to call the pinned chat model. Optional `LAW_MOCK_LATENCY_MS` (30000–60000) overrides mock delay. Those law env vars are read by the api/worker process (from the shell or `.env` via `loadRootEnv`); they are **not** passed through Compose.

The law demo runs with `pnpm dev:law`. A law Docker deployment needs the generate step built with `STIRRUP_EDITION=law` (not wired yet): the web image accepts `ARG STIRRUP_EDITION` at build time, but the shared api/worker image's Prisma tree is prepared without it today.

Demo smoke checklist: [`00-README.md`](./00-README.md). Law ↔ law-demo file map: [`law-parity.md`](./law-parity.md).

## Selection

- **Web (build time).** Vite resolves `@edition/web` to `editions/<id>/src/web.ts`. Editors and `tsc` always see the default edition via `apps/web/tsconfig.json`. Core web code imports only through `apps/web/src/edition.ts`. An empty build arg / env must resolve to `default`.
- **API and worker (runtime).** Each process loads a static registry in `apps/api/src/edition/active.ts` and `apps/worker/src/edition/active.ts`, then calls `getEdition()` after `loadRootEnv()` so `STIRRUP_EDITION` is available (`?.trim() || "default"`).

## Seams

Core files must not grow edition behavior. When core must call into an edition, keep the change small (about ten lines), mark it with `// edition-seam:<ID>` (for example `// edition-seam:W3`), and avoid edition-specific wording in core. Only the listed seam files may import `@rakazo/edition-*` or `@edition/web`; `scripts/checks/edition-seams.test.mjs` enforces that.

Regenerate this table with `git grep -n "edition-seam:"` (excluding `docs/` and the check itself). Every id appears exactly once below.

| Id        | File                                                                                    | Role                                                                             |
| --------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A1-web    | `apps/web/vite.config.ts`, `vitest.config.ts`                                           | Web edition Vite alias and test resolution                                       |
| A1-server | `apps/api/src/edition/active.ts`, `apps/worker/src/edition/active.ts`                   | Server edition registry                                                          |
| W2        | `apps/web/src/pages/Shell.tsx`                                                          | Wraps the shell in `edition.ShellProvider` when the edition defines one          |
| W3        | `apps/web/src/pages/Shell.tsx`                                                          | Wraps the loaded shell tree in `edition.ChromeFrame` (pass-through by default)   |
| W4        | `apps/web/src/pages/Shell.tsx`, `apps/web/src/pages/shell/shell-sidebar.tsx`            | Optional sidebar `leading` slot above the header (`edition.SidebarLeading`)      |
| W5        | `apps/web/src/pages/Shell.tsx`                                                          | Renders `edition.MainAside` after `</main>` when defined                         |
| W6        | `apps/web/src/pages/Shell.tsx`                                                          | `useShellExtension` hook entry on the shell                                      |
| W6a       | `apps/web/src/pages/Shell.tsx`                                                          | `transformSidebarGroups` over sidebar groups                                     |
| W6b       | `apps/web/src/pages/Shell.tsx`                                                          | `filterCreateMenuBots` for the create menu                                       |
| W6c       | `apps/web/src/pages/Shell.tsx`                                                          | `onBotCreated` after a bot is created                                            |
| W7        | `apps/web/src/components/GitHubStarPrompt.tsx`, `apps/web/src/pages/shell/composer.tsx` | Skips the GitHub star prompt and its message count when `hideStarPrompt` is true |
| W8        | `apps/web/src/pages/shell/use-space-roster.ts`                                          | `chooseDefaultRoute` may replace the chat a missing route opens                  |
| R0        | `packages/adapters/src/executor-deps.ts`, `packages/adapters/src/edition-run-hooks.ts`  | Optional `editionRunHooks` on executor deps                                      |
| R1        | `packages/adapters/src/run-assembly-context.ts`                                         | `turnNote` appended to the turn prompt                                           |
| R2        | `packages/adapters/src/run-assembly-context.ts`                                         | `limitTeammates` before the bot directory                                        |
| R3        | `packages/adapters/src/run-turn.ts`                                                     | `onReplyFinalized` after a successful reply                                      |
| R4        | `packages/adapters/src/run-turn.ts`, `packages/adapters/src/run-progress.ts`            | `streamsProgress` may flush progress while scripted                              |
| S1        | `apps/api/src/index.ts`, `apps/worker/src/index.ts`                                     | `onProcessStart` after env load                                                  |
| S2        | `apps/api/src/app.ts`                                                                   | `mountRoutes` beside other HTTP mounts                                           |
| S3        | `apps/api/src/app.ts`, `apps/worker/src/index.ts`                                       | Pass `runHooks` into `createRunRuntime`                                          |
| S4        | `apps/api/src/app.ts`, `apps/worker/src/index.ts`                                       | Optional `agentRuntime` before Pi                                                |
| S5        | `apps/api/src/app.ts`                                                                   | `afterBootstrap` after deployment settings upsert                                |
| S6        | `apps/api/src/routes/shared.ts`                                                         | Scripted edition runtimes skip the model-credential send gate (`needsModel`)     |
| S7        | `apps/api/src/routes/threads.ts`                                                        | Optional server-edition botAccess check on a bot thread (head, get, messages, subscribe, send) |
| C1        | `packages/db/prisma.config.ts`                                                          | Prefer the prepared `.edition` schema when `prepare-db` has run                  |
| C2        | `apps/api/src/cli/migrate-database.ts`                                                  | Refuse a mismatched prepared tree; use `.edition/migrations` when present        |
| C3        | `scripts/dev.mjs`                                                                       | Forward edition into child env; prefer prepared schema mtime; run `prepare-db`   |

## Adding an edition

1. Copy `editions/default` to `editions/<id>` and rename the package.
2. Register it in both `active.ts` registries under the same id.
3. The web Vite alias needs no change: it already points at `editions/$STIRRUP_EDITION/src/web.ts`.
4. Add Prisma models under `editions/<id>/db/` (scalars only) and `9999…` migrations if the edition needs tables.
5. Keep every core call behind a labeled seam of about ten lines.

## Upstream sync

When merging upstream `elie222/rakazo` changes, conflicts can only occur at the marked seam lines (`git grep -n edition-seam:`). Every seam is at most about ten lines, so resolve by keeping the seam comment and the edition call site, then re-run `pnpm checks` (including `edition-seams`).

## Database

Editions can add Prisma models and SQL migrations without editing `packages/db/prisma/schema.prisma` or `packages/db/prisma/migrations/`.

1. **Types.** The Prisma client is always generated from the core schema plus every edition's model file under `editions/*/db/*.prisma`. All packages typecheck in every build; unused edition tables simply do not exist in other editions' databases.
2. **Tables.** Migrations applied are core migrations plus only the active edition's migrations under `editions/<id>/db/migrations/*`. Edition migration directory names start with `9999` so they sort after every core migration.
3. **Scalar-only models.** Edition models use scalar fields only (no Prisma relations to core models), so the core schema never needs back-relations.
4. **Output.** `node scripts/editions/prepare-db.mjs` writes a generated, gitignored tree at `packages/db/prisma/.edition/`. With `STIRRUP_EDITION` unset (or `default`), tooling behaves as today: the prepared schema equals the core schema, and core migrations are used.

```bash
node scripts/editions/prepare-db.mjs [--edition <id>]
STIRRUP_EDITION=<id> pnpm --filter @rakazo/db generate
pnpm db:migrate
```

Always run `STIRRUP_EDITION=<id> pnpm --filter @rakazo/db generate` before `pnpm db:migrate` for a non-default edition so `.edition/migrations` matches. Edition migration SQL must not start with `-- deferred`. Do not run `migrate:dev` while edition models exist: it diffs the merged schema and would invent core migrations for edition tables.

To add an edition model: create `editions/<id>/db/<id>.prisma` with scalar fields only, then add a migration directory under `editions/<id>/db/migrations/` whose name starts with `9999`.
