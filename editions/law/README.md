# Law edition

Optional product skin selected with `STIRRUP_EDITION=law`. Web and server entry points live under `src/`; this package stays self-contained and never imports `apps/*`.

## Web

`editions/law/src/web.ts` exports a `WebEdition` that A2 wires into the core shell through seams W2–W6 (`docs/editions/README.md`). Until those seams land, the UI compiles and unit-tests here but does not appear in the browser.

| Export                           | Role                                                                                                           | Core seam |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| `ShellProvider` (`LawProvider`)  | Owns case list, selected case, environment (`cases` / `general`), and roster filter; fetches `/api/law/cases`. | W2        |
| `ChromeFrame` (`LawChromeFrame`) | Far-left `w-12` spacer, `LawEnvironmentRail`, and the `left-12` offset wrapper around the core shell.          | W3        |
| `SidebarLeading` (`LawCaseTabs`) | Case tab strip above the bots list (cases environment only).                                                   | W4        |
| `MainAside` (`LawCaseColumn`)    | Case file library / review column and document overlays.                                                       | W5        |
| `useShellExtension`              | Memoized `transformSidebarGroups` / `filterCreateMenuBots` / `onBotCreated` over the current roster.           | W6        |
| `hideStarPrompt: true`           | Hides the Star on GitHub prompt when the law edition is active.                                                | W7 (A2)   |

Supporting modules under `src/web/`:

- `shell.tsx` — provider, rail, tabs, case column, chrome frame
- `roster.ts` — `applyLawRoster` / `filterLawCreateBots`
- `files.tsx` — case document cards, viewer, and editor
- `lib.ts` — local `withSpaceHeaders` (space id from `rakazo:space-id` localStorage)

## Server

`editions/law/src/server.ts` exports a `ServerEdition` that A3 mounts through seams S2/S3 (`docs/editions/README.md`). C3 adds `onProcessStart`, `agentRuntime`, and `afterBootstrap`.

### Tables

Prisma models in `db/law.prisma` (scalar fields only). Migrations under `db/migrations/` (9999 prefix):

| Table              | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `law_cases`        | Case file per Space (`slug`, `name`, `brief`)                        |
| `law_case_members` | Which users may open a case                                          |
| `law_documents`    | Library files and review drafts (versioned)                          |
| `law_case_bots`    | Role → bot link (`manager`, `documents`, `transcripts`, `generator`) |

Row-level security is enabled and forced on every law table; tenant policies key off `app.space_id`, with an `app.rls_bypass` system policy.

### Routes

Mounted at `/api/law/*` by `mountRoutes`:

| Method | Path                                           | Behavior                                     |
| ------ | ---------------------------------------------- | -------------------------------------------- |
| GET    | `/api/law/cases`                               | List the caller's cases and role bots        |
| POST   | `/api/law/cases`                               | Create a case and the four role bots         |
| POST   | `/api/law/cases/:id/bots`                      | Attach an existing Space bot to the case     |
| GET    | `/api/law/cases/:id/documents`                 | List library / review documents              |
| POST   | `/api/law/cases/:id/documents/:docId/versions` | Save a new review draft version (`{ body }`) |

Unauthenticated calls return 401. Response shapes match the B1 web client.

### Hooks

Always on while the law edition is selected (no `LAW_ENFORCE_CHAT_PIN` gate):

| Hook               | Function                 | Role                                               |
| ------------------ | ------------------------ | -------------------------------------------------- |
| `turnNote`         | `lawTurnNote`            | Case brief + keyword snippets into the turn prompt |
| `limitTeammates`   | `limitLawTeammates`      | Hide other cases' bots from the teammate list      |
| `onReplyFinalized` | `saveLawReviewDraftHook` | Persist generator replies as review drafts         |

### Env

No new env vars in C2. Chat pin / OpenRouter wiring and seed belong to C3 (`LAW_CHAT_PROVIDER` / `LAW_CHAT_MODEL_ID` live in `src/server/constants.ts` for that follow-up). Apply migrations with:

```bash
STIRRUP_EDITION=law pnpm --filter @rakazo/db generate
STIRRUP_EDITION=law pnpm db:migrate
```
