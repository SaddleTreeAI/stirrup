# Law edition

Optional product skin selected with `STIRRUP_EDITION=law` (or `pnpm dev:law` / `pnpm build:law`). Web and server entry points live under `src/`; this package stays self-contained and never imports `apps/*`.

## What the law edition changes

- **Environment rail** — far-left Cases / General switch (`ChromeFrame` + spacer).
- **Case tabs** — tab strip above the bots list (cases environment only); labels strip a leading `Commonwealth v. `.
- **Case column** — library / review document column and overlays (`MainAside`).
- **Roster filtering** — sidebar and create-menu show only the selected case's bots (`useShellExtension`).
- **Chat pin** — always pins chat to the OpenRouter model in `constants.ts`.
- **Mock** — when the chat pin is enforced and `LAW_OPENROUTER_API_KEY` is blank, replies stream from `law-mock` (~30–60 s).
- **Seed** — synthetic attorney, three cases, four bots each, library + review docs; login written only to `LAW_LOGIN_FILE`.

## Web

`editions/law/src/web.ts` exports a `WebEdition` wired into the core shell through seams W2–W8 (`docs/editions/README.md`).

| Export                           | Role                                                                                                                        | Core seam |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------- |
| `ShellProvider` (`LawProvider`)  | Owns case list, selected case, environment (`cases` / `general`), and roster filter; fetches `/api/law/cases`.              | W2        |
| `ChromeFrame` (`LawChromeFrame`) | Far-left `w-12` spacer, `LawEnvironmentRail`, and the `left-12` offset wrapper around the core shell.                       | W3        |
| `SidebarLeading` (`LawCaseTabs`) | Case tab strip above the bots list (cases environment only).                                                                | W4        |
| `MainAside` (`LawCaseColumn`)    | Case file library / review column and document overlays.                                                                    | W5        |
| `useShellExtension`              | Memoized `transformSidebarGroups` / `filterCreateMenuBots` / `onBotCreated` / `chooseDefaultRoute` over the current roster. | W6 / W8   |
| `hideStarPrompt: true`           | Hides the Star on GitHub prompt when the law edition is active.                                                             | W7        |

Supporting modules under `src/web/`: `shell.tsx`, `roster.ts`, `files.tsx`, `lib.ts` (local `withSpaceHeaders` using `rakazo:space-id` localStorage).

## Server

`editions/law/src/server.ts` exports a `ServerEdition` mounted through seams S1 to S6, run hooks R0 to R4, and database and dev seams C1 to C3.

### Tables

Prisma models in `db/law.prisma` (scalar fields only). Migrations under `db/migrations/` (9999 prefix):

| Table                     | Purpose                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `law_cases`               | Case file per Space (`slug`, `name`, `brief`); soft delete / legal hold |
| `law_case_members`        | Which users may open a case                                             |
| `law_documents`           | Library files and review drafts (versioned; upload / status metadata)   |
| `law_document_pages`      | Per-page text for PDFs (OCR flag)                                       |
| `law_transcript_segments` | Timed transcript lines for audio / video                                |
| `law_media_frames`        | Sampled video frames with optional caption                              |
| `law_jobs`                | Background extract / OCR / transcribe / purge work                      |
| `law_case_bots`           | Role → bot link (`manager`, `documents`, `transcripts`, `generator`)    |

Row-level security is enabled and forced on every law table; tenant policies key off `app.space_id`, with an `app.rls_bypass` system policy.

### Routes

Mounted at `/api/law/*` by `mountRoutes`:

| Method | Path                                           | Behavior                                                          |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/api/law/cases`                               | List the caller's cases and role bots                             |
| POST   | `/api/law/cases`                               | Create a case and the four role bots                              |
| POST   | `/api/law/cases/:id/bots`                      | Attach an existing Space bot to the case                          |
| GET    | `/api/law/cases/:id/documents`                 | List library / review documents (excludes soft-deleted)           |
| POST   | `/api/law/cases/:id/documents/upload`          | Multipart upload (`file`, optional `title`) into the case library |
| POST   | `/api/law/cases/:id/documents`                 | Create a blank or pasted text note (`{ title, body? }`)           |
| PATCH  | `/api/law/cases/:id/documents/:docId`          | Rename a document version family (`{ title }`)                    |
| DELETE | `/api/law/cases/:id/documents/:docId`          | Soft-delete the version family; cancel queued jobs; audit         |
| GET    | `/api/law/cases/:id/documents/:docId/file`     | Download original bytes (`?inline=1` for pdf/audio/video only)    |
| POST   | `/api/law/cases/:id/documents/:docId/versions` | Save a new review draft version (`{ body }`)                      |

Unauthenticated calls return 401. Non-members get 404 on every case-scoped route (same as the list).

**Library permissions (L0):** any case member may upload, create notes, rename, and soft-delete. Tighten later (for example creator-only delete) without changing the route shapes.

### Hooks

| Hook               | Function                 | Seam | Role                                               |
| ------------------ | ------------------------ | ---- | -------------------------------------------------- |
| `turnNote`         | `lawTurnNote`            | R1   | Case brief + keyword snippets into the turn prompt |
| `limitTeammates`   | `limitLawTeammates`      | R2   | Hide other cases' bots from the teammate list      |
| `onReplyFinalized` | `saveLawReviewDraftHook` | R3   | Persist generator replies as review drafts         |
| `streamsProgress`  | `lawStreamsProgress`     | R4   | Flush scripted progress for the `law-mock` runtime |

`lawCaseAccess` is wired through `botAccess` (S7).

Other server edition members:

| Member           | Seam                          | Role                                                             |
| ---------------- | ----------------------------- | ---------------------------------------------------------------- |
| `onProcessStart` | S1                            | Apply the chat pin at process start                              |
| `mountRoutes`    | S2                            | Mount `/api/law/*`                                               |
| `runHooks`       | S3                            | Wire the hooks above into `createRunRuntime`                     |
| `agentRuntime`   | S4 (S6 for the scripted gate) | Return the slow mock when enabled; S6 skips the model credential |
| `afterBootstrap` | S5                            | Refuse a deployment default model other than the pin             |

### Pin and mock

`onProcessStart` always applies the chat pin (`LAW_CHAT_PROVIDER` / `LAW_CHAT_MODEL_ID` in `constants.ts`) and sets `LAW_ENFORCE_CHAT_PIN=1`. The slow mock is used only when that pin flag is `1` and `LAW_OPENROUTER_API_KEY` is blank; S6 is why the scripted mock can chat without a model credential. Optional `LAW_MOCK_LATENCY_MS` must be between 30000 and 60000 inclusive, otherwise the default is 40000. `afterBootstrap` refuses a deployment default model other than the pin.

## Run

```bash
STIRRUP_EDITION=law pnpm --filter @rakazo/db generate
pnpm db:migrate
LAW_LOGIN_FILE=/tmp/law-login.txt pnpm --filter @rakazo/edition-law seed
pnpm dev:law
```

Unset `LAW_OPENROUTER_API_KEY` for the slow mock. Set it to a real OpenRouter key for the pinned model. `LAW_LOGIN_FILE` must resolve outside the repository; the seed refuses paths inside the checkout. Never commit that file or put a real API key in the repo.

## Media sidecar

A separate process claims `law_jobs` from Postgres, shells out to local tools, and writes derived artifacts. It does not run inside Graphile Worker: the app image only ships openssl, so PDF/OCR/ffmpeg live in `editions/law/docker/media.Dockerfile` (derived `FROM` the law server image).

### Run mechanism

- Entry: `editions/law/src/server/media/main.ts`.
- Local: `pnpm --filter @rakazo/edition-law media:dev` (tsx), same as the seed CLI.
- Image: install tsx in the media image only; `ENTRYPOINT` runs that file. Api/worker still bundle edition code via `scripts/build-server.mjs`; the sidecar is a second container sharing the same workspace source already present in the law server image. No core change and no committed `dist-media`.

### Commands

```bash
pnpm --filter @rakazo/edition-law media:doctor
pnpm --filter @rakazo/edition-law media:dev
```

`media:doctor` prints one line per tool (`ffmpeg 6.1.1` or `ffmpeg MISSING`) plus `gpu …`, and exits 1 when a required tool is missing. Override the required set with `LAW_MEDIA_REQUIRED_TOOLS` (comma-separated).

### Env (sidecar only)

| Variable                                    | Role                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`                              | Runtime Postgres role (same as api); claims use RLS bypass as a system worker      |
| `DATA_DIR`                                  | Shared data volume with api (default `./data`)                                     |
| `ENCRYPTION_KEY` / `ENCRYPTION_MASTER_KEYS` | Same content-encryption keys as api                                                |
| `OBJECT_STORAGE_*`                          | Same object-storage settings as api when artifacts are remote                      |
| `LAW_MEDIA_CONCURRENCY`                     | Parallel jobs (default `1`; keep at 1 for GPU work)                                |
| `LAW_MEDIA_STALE_MINUTES`                   | Requeue running jobs whose heartbeat is older than this (default `120`)            |
| `LAW_MEDIA_TMP`                             | Per-job temp root (default `os.tmpdir()/law-media`)                                |
| `LAW_MEDIA_WORKER_ID`                       | Claim owner id (default `media-<hostname>`)                                        |
| `LAW_MEDIA_REQUIRED_TOOLS`                  | Doctor required list (default ffmpeg,ffprobe,pdftotext,tesseract,ocrmypdf,python3) |

### Compose overlay

```bash
docker compose -f infra/compose/docker-compose.yml \
  -f editions/law/docker/compose.media.yml up law-media
```

Builds `editions/law/docker/media.Dockerfile` with `SERVER_IMAGE` / `LAW_SERVER_IMAGE`, mounts the app data volume and a `law-models` volume (for later transcription models), and documents a commented NVIDIA device block for GPU hosts. A CI job that publishes the media image is a follow-up.

Enqueue from ingest with `enqueueExtraction` → `enqueueLawJob` (idempotent per document+kind while queued or running). Handlers register in `src/server/media/handlers/index.ts` (`selftest` only in M0).

Demo smoke: `docs/editions/00-README.md`. Parity map: `docs/editions/law-parity.md`.
