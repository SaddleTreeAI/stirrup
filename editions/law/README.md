# Law edition

Optional product skin selected with `STIRRUP_EDITION=law` (or `pnpm dev:law` / `pnpm build:law`). Web and server entry points live under `src/`; this package stays self-contained and never imports `apps/*`.

## What the law edition changes

- **Environment rail** — far-left Cases / General switch (`ChromeFrame` + spacer).
- **Case tabs** — tab strip above the bots list (cases environment only); labels strip a leading `Commonwealth v. `.
- **Case column** — library / review document column and overlays (`MainAside`).
- **Roster filtering** — sidebar and create-menu show only the selected case's bots (`useShellExtension`).
- **Chat pin** — always pins chat to the OpenRouter model in `constants.ts`.
- **Mock** — when `LAW_OPENROUTER_API_KEY` is unset, replies stream from `law-mock` (~30–60 s).
- **Seed** — synthetic attorney, three cases, four bots each, library + review docs; login written only to `LAW_LOGIN_FILE`.

## Web

`editions/law/src/web.ts` exports a `WebEdition` wired into the core shell through seams W2–W7 (`docs/editions/README.md`).

| Export                           | Role                                                                                                           | Core seam |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| `ShellProvider` (`LawProvider`)  | Owns case list, selected case, environment (`cases` / `general`), and roster filter; fetches `/api/law/cases`. | W2        |
| `ChromeFrame` (`LawChromeFrame`) | Far-left `w-12` spacer, `LawEnvironmentRail`, and the `left-12` offset wrapper around the core shell.          | W3        |
| `SidebarLeading` (`LawCaseTabs`) | Case tab strip above the bots list (cases environment only).                                                   | W4        |
| `MainAside` (`LawCaseColumn`)    | Case file library / review column and document overlays.                                                       | W5        |
| `useShellExtension`              | Memoized `transformSidebarGroups` / `filterCreateMenuBots` / `onBotCreated` over the current roster.           | W6        |
| `hideStarPrompt: true`           | Hides the Star on GitHub prompt when the law edition is active.                                                | W7        |

Supporting modules under `src/web/`: `shell.tsx`, `roster.ts`, `files.tsx`, `lib.ts` (local `withSpaceHeaders` using `rakazo:space-id` localStorage).

## Server

`editions/law/src/server.ts` exports a `ServerEdition` mounted through seams S1–S5 and run hooks R1–R4.

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

Unauthenticated calls return 401.

### Hooks

| Hook               | Function                 | Role                                               |
| ------------------ | ------------------------ | -------------------------------------------------- |
| `turnNote`         | `lawTurnNote`            | Case brief + keyword snippets into the turn prompt |
| `limitTeammates`   | `limitLawTeammates`      | Hide other cases' bots from the teammate list      |
| `onReplyFinalized` | `saveLawReviewDraftHook` | Persist generator replies as review drafts         |
| `streamsProgress`  | `lawStreamsProgress`     | Flush scripted progress for the `law-mock` runtime |

`lawCaseAccess` is ported in `cases.ts` but has **no core caller yet** (needs a future seam).

### Pin and mock

`onProcessStart` always applies the chat pin (`LAW_CHAT_PROVIDER` / `LAW_CHAT_MODEL_ID` in `constants.ts`). `agentRuntime` returns the slow mock when `LAW_OPENROUTER_API_KEY` is unset. `afterBootstrap` refuses a deployment default model other than the pin.

## Run

```bash
STIRRUP_EDITION=law pnpm --filter @rakazo/db generate
pnpm db:migrate
LAW_LOGIN_FILE=/tmp/law-login.txt pnpm --filter @rakazo/edition-law seed
pnpm dev:law
```

Unset `LAW_OPENROUTER_API_KEY` for the slow mock. Set it to a real OpenRouter key for the pinned model. `LAW_LOGIN_FILE` must resolve outside the repository; the seed refuses paths inside the checkout. Never commit that file or put a real API key in the repo.

Demo smoke: `docs/editions/00-README.md`. Parity map: `docs/editions/law-parity.md`.
