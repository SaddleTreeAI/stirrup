# Editions

An edition is an optional product skin layered on the shared Stirrup core: web UI slots and server hooks that live under `editions/<id>/`, selected by `STIRRUP_EDITION` (default `default`). With the variable unset or set to `default`, behavior matches core Stirrup.

## Selection

- **Web (build time).** Vite resolves `@edition/web` to `editions/<id>/src/web.ts`. Editors and `tsc` always see the default edition via `apps/web/tsconfig.json`. Core web code imports only through `apps/web/src/edition.ts`.
- **API and worker (runtime).** Each process loads a static registry in `apps/api/src/edition/active.ts` and `apps/worker/src/edition/active.ts`, then calls `getEdition()` after `loadRootEnv()` so `STIRRUP_EDITION` is available.

## Seams

Core files must not grow edition behavior. When core must call into an edition, keep the change small (about ten lines), mark it with `// edition-seam:<ID>` (for example `// edition-seam:A1-web`), and avoid edition-specific wording in core. Only the listed seam files may import `@rakazo/edition-*` or `@edition/web`; `scripts/checks/edition-seams.test.mjs` enforces that.

| Id  | File                                                                                    | What it does                                                                            |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| W2  | `apps/web/src/pages/Shell.tsx`                                                          | Wraps the shell in `edition.ShellProvider` when the edition defines one.                |
| W3  | `apps/web/src/pages/Shell.tsx`                                                          | Wraps the loaded shell tree in `edition.ChromeFrame` (pass-through by default).         |
| W4  | `apps/web/src/pages/Shell.tsx`, `apps/web/src/pages/shell/shell-sidebar.tsx`            | Optional sidebar `leading` slot above the header (`edition.SidebarLeading`).            |
| W5  | `apps/web/src/pages/Shell.tsx`                                                          | Renders `edition.MainAside` after `</main>` when defined.                               |
| W6  | `apps/web/src/pages/Shell.tsx`                                                          | `useShellExtension`: transform sidebar groups, filter create-menu bots, `onBotCreated`. |
| W7  | `apps/web/src/components/GitHubStarPrompt.tsx`, `apps/web/src/pages/shell/composer.tsx` | Skips the GitHub star prompt and its message count when `hideStarPrompt` is true.       |

## Adding an edition

1. Copy `editions/default` to `editions/<id>` and rename the package.
2. Register it in both `active.ts` registries under the same id.
3. The web Vite alias needs no change: it already points at `editions/$STIRRUP_EDITION/src/web.ts`.

## Running

```bash
STIRRUP_EDITION=law pnpm dev
```
