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

| Method | Path                                             | Behavior                                                            |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------- |
| GET    | `/api/law/cases`                                 | List open cases, `canDelete`, `deletedBotIds`, `retentionDays`      |
| GET    | `/api/law/cases?deleted=1`                       | List soft-deleted cases (space owner / org admin only)              |
| POST   | `/api/law/cases`                                 | Create a case and the four role bots (`createdBy` = actor)          |
| DELETE | `/api/law/cases/:id`                             | Soft-delete a case; cancel queued/running jobs; audit               |
| POST   | `/api/law/cases/:id/restore`                     | Clear soft-delete fields (same permission as delete)                |
| POST   | `/api/law/cases/:id/bots`                        | Attach an existing Space bot to the case                            |
| GET    | `/api/law/cases/:id/documents`                   | List library / review documents (excludes soft-deleted)             |
| POST   | `/api/law/cases/:id/documents/upload`            | Multipart upload (`file`, optional `title`) into the case library   |
| POST   | `/api/law/cases/:id/documents`                   | Create a blank or pasted text note (`{ title, body? }`)             |
| PATCH  | `/api/law/cases/:id/documents/:docId`            | Rename a document version family (`{ title }`)                      |
| DELETE | `/api/law/cases/:id/documents/:docId`            | Soft-delete the version family; cancel queued jobs; audit           |
| GET    | `/api/law/cases/:id/documents/:docId/file`       | Download original bytes (`?inline=1` for pdf/audio/video only)      |
| GET    | `/api/law/cases/:id/documents/:docId/transcript` | Export transcript (`?format=txt\|srt\|vtt`; member-only attachment) |
| GET    | `/api/law/cases/:id/documents/:docId/segments`   | Timed segments window (`?from=ms&to=ms`; at most 500)               |
| POST   | `/api/law/cases/:id/documents/:docId/versions`   | Save a new review draft version (`{ body }`)                        |

Unauthenticated calls return 401. Non-members get 404 on every case-scoped route (same as the list). Soft-deleted cases return 404 on library and document routes; their bots stay in `deletedBotIds` so General never shows them.

**Case delete permissions (CASE1):** the case `createdBy`, or a space owner, or an organization owner/admin. When `createdBy` is null (older multi-member cases), only a space owner or org admin may delete or restore. Other members get 403; non-members get 404. A case with `legalHold` cannot be deleted (409). Retention defaults to 30 days (`LAW_CASE_RETENTION_DAYS`; `0` means never auto-purge). Hard purge after retention is CASE2 (below).

### Retention and purge

Soft-deleted cases stay recoverable until `purgeAfter`. The default retention is **30 days** (`LAW_CASE_RETENTION_DAYS`). Set `LAW_CASE_RETENTION_DAYS=0` to disable the sweeper and leave `purgeAfter` null on delete (no automatic purge).

The media sidecar sweeps every `LAW_PURGE_SWEEP_MINUTES` (default `60`) and enqueues idempotent `purge_case` jobs for rows where `deletedAt` is set, `purgeAfter < now()`, and `legalHold` is false. A case on legal hold is never purged until hold is cleared (`pnpm --filter @rakazo/edition-law case:hold <id> on|off`).

What purge removes: Library documents and their pages / transcript segments / media frames; original, derived, and frame artifacts in the artifact store; `law_jobs` for the case; `law_case_members` and `law_case_bots`; archives the linked bots (cancels active runs, pauses routines, sets `archivedAt`); writes `law.case.purged` (case id and counts only); deletes the `law_cases` row last.

What purge does **not** remove: database backups and any copies outside the artifact store (object-storage replicas, snapshots, offline exports). Those remain until JT's backup retention policy covers them — confirm that policy before enabling purge in production. Bot rows and their threads stay in the core tables as archived (hidden); a future generic core repo method (e.g. `archiveBotsByIds`) could own full adapter teardown including thread deletion.

CLI:

```bash
pnpm --filter @rakazo/edition-law case:purge --case <id> [--dry-run]
pnpm --filter @rakazo/edition-law case:purge --case <id> --force-before-retention --confirm <id>
pnpm --filter @rakazo/edition-law case:hold <id> on|off
```

Dry-run prints counts only and changes nothing. `--force-before-retention` still requires a soft-deleted case that is not on hold, and must repeat the id as `--confirm`. Do not enable automatic purge in production until JT confirms the retention window (30 days is only the default).

**Library permissions (L0):** any case member may upload, create notes, rename, and soft-delete. Tighten later (for example creator-only delete) without changing the route shapes.

### Hooks

| Hook               | Function                 | Seam | Role                                                                  |
| ------------------ | ------------------------ | ---- | --------------------------------------------------------------------- |
| `turnNote`         | `lawTurnNote`            | R1   | Case brief, library manifest, and keyword snippets into the turn note |
| `limitTeammates`   | `limitLawTeammates`      | R2   | Hide other cases' bots from the teammate list                         |
| `onReplyFinalized` | `saveLawReviewDraftHook` | R3   | Persist generator replies as review drafts                            |
| `streamsProgress`  | `lawStreamsProgress`     | R4   | Flush scripted progress for the `law-mock` runtime                    |
| `tools`            | `lawCaseTools`           | R5   | `search_case_library`, `read_case_document`, and `save_to_case_library` for case bots |

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
- Local: run `pnpm --filter @rakazo/edition-law media:dev` in a second terminal alongside `pnpm dev:law` (tsx), same as the seed CLI.
- Image: install tsx in the media image only; `ENTRYPOINT` runs that file. Api/worker still bundle edition code via `scripts/build-server.mjs`; the sidecar is a second container sharing the same workspace source already present in the law server image. No core change and no committed `dist-media`.

### Commands

```bash
pnpm --filter @rakazo/edition-law media:doctor
pnpm --filter @rakazo/edition-law media:dev
pnpm --filter @rakazo/edition-law media:models -- --yes
```

`media:doctor` prints one line per tool (`ffmpeg 6.1.1` or `ffmpeg MISSING`) plus `tesseract-langs …`, `gpu …`, `cuda …`, `models …`, the optional `faster-whisper` version when installed, and a per-job-kind summary (`extract_pdf pdfinfo,pdftotext`, `ocr_pdf ocrmypdf,tesseract,pdftotext`). Exits 1 when a required tool is missing. Defaults require poppler (`pdfinfo`, `pdftotext`) for PDF extraction, ffmpeg/ffprobe/python3 for transcription, and ocrmypdf/tesseract for OCR (now that `ocr_pdf` is registered). Override with `LAW_MEDIA_REQUIRED_TOOLS` (comma-separated).

`media:models` downloads the CTranslate2 Whisper weights once (operator step; never CI or runtime). Requires `--yes`. Repositories match faster-whisper 1.2.1 `_MODELS`: `small` → `Systran/faster-whisper-small`, `large-v3-turbo` → `mobiuslabsgmbh/faster-whisper-large-v3-turbo`.

### Transcription (V1)

Audio (`mp3`, `m4a`, `wav`, `aac`, `ogg`, `flac`, `opus`, `wma`) and video (`mp4`, `mov`, `mkv`, `webm`, `avi`, `m4v`) uploads enqueue a `transcribe` job. The sidecar probes with ffprobe, extracts mono 16 kHz PCM with ffmpeg, runs `media-tools/asr.py` (faster-whisper by default; whisper-cpp optional), merges short segments, seals `law_transcript_segments`, and writes a readable `[hh:mm:ss] text` body. Status detail after success:

> Machine transcript. Not a certified transcript; check against the recording.

### Env (sidecar only)

| Variable                                    | Role                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                              | Runtime Postgres role (same as api); claims use RLS bypass as a system worker              |
| `DATA_DIR`                                  | Shared data volume with api (default `./data`)                                             |
| `ENCRYPTION_KEY` / `ENCRYPTION_MASTER_KEYS` | Same content-encryption keys as api                                                        |
| `OBJECT_STORAGE_*`                          | Same object-storage settings as api when artifacts are remote                              |
| `LAW_MEDIA_CONCURRENCY`                     | Parallel jobs (default `1`; keep at 1 for GPU work)                                        |
| `LAW_MEDIA_STALE_MINUTES`                   | Requeue running jobs whose heartbeat is older than this (default `120`)                    |
| `LAW_MEDIA_TMP`                             | Per-job temp root (default `os.tmpdir()/law-media`)                                        |
| `LAW_MEDIA_WORKER_ID`                       | Claim owner id (default `media-<hostname>`)                                                |
| `LAW_MEDIA_REQUIRED_TOOLS`                  | Doctor required list (default pdfinfo,pdftotext,ffmpeg,ffprobe,python3,ocrmypdf,tesseract) |
| `LAW_MEDIA_MAX_MINUTES`                     | Reject media longer than this (default `360`)                                              |
| `LAW_MODELS_DIR`                            | Whisper model root (default `/models`)                                                     |
| `LAW_ASR_ENGINE`                            | `faster-whisper` (default) or `whisper-cpp`                                                |
| `LAW_ASR_MODEL`                             | Model name or `auto` (large-v3-turbo on CUDA / ≥8 cores, else small)                       |
| `LAW_ASR_DEVICE`                            | `auto` / `cpu` / `cuda`                                                                    |
| `LAW_ASR_COMPUTE`                           | `auto` (float16 on CUDA, int8 on CPU) or a CTranslate2 compute type                        |
| `LAW_ASR_LANGUAGE`                          | `auto` (default) or an ISO language code                                                   |
| `LAW_ASR_SCRIPT`                            | Path to `asr.py` (image default `/opt/law-media-tools/asr.py`)                             |
| `HF_HUB_OFFLINE`                            | Set to `1` by the image / runner (no model download at runtime)                            |
| `LAW_PURGE_SWEEP_MINUTES`                   | How often to enqueue due `purge_case` jobs (default `60`; disabled when retention is 0)    |
| `LAW_CASE_RETENTION_DAYS`                   | Soft-delete retention before purge (default `30`; `0` disables the sweeper)                |
| `LAW_SEARCH_MAX_ROWS`                       | Max sealed rows scanned per Library search (default `20000`; API process)                  |
| `LAW_OCR_LANGS`                             | Tesseract languages, `eng` or `eng+spa` (default `eng`)                                    |
| `LAW_OCR_JOBS`                              | ocrmypdf `--jobs` (default CPU count, capped at 4)                                         |
| `LAW_OCR_MAX_PAGES`                         | Skip OCR above this page count (default `400`)                                             |
| `LAW_OCR_TIMEOUT_MINUTES`                   | Kill ocrmypdf after this many minutes (default `120`)                                      |

### Compose overlay

```bash
docker compose -f infra/compose/docker-compose.yml \
  -f editions/law/docker/compose.media.yml up law-media
```

Builds `editions/law/docker/media.Dockerfile` with `SERVER_IMAGE` / `LAW_SERVER_IMAGE`, mounts the app data volume and a `law-models` volume (for later transcription models), and documents a commented NVIDIA device block for GPU hosts. A CI job that publishes the media image is a follow-up.

Enqueue from ingest with `enqueueExtraction` → `enqueueLawJob` (idempotent per document+kind while queued or running). Handlers register in `src/server/media/handlers/index.ts` (`selftest`, `extract_pdf`, `ocr_pdf`, `import_docx`, `transcribe`, `purge_case`).

### PDF extract and OCR (P1 / P2)

`extract_pdf` runs `pdfinfo` + `pdftotext`. When at least half the pages look blank, it enqueues `ocr_pdf`. The OCR handler runs `ocrmypdf --skip-text` (never `--force-ocr`), writes a sidecar text file, replaces only blank page rows with `ocr=true`, stores a searchable PDF as `derivedArtifactId`, and sets status detail:

> OCR complete (machine-read text; check against the original)

`GET .../documents/:docId/file?variant=searchable` returns that derived PDF (404 when none). The PDF viewer shows an OCR badge and caveat on machine-read pages, and a Download searchable copy action when a derived PDF exists. Retrieval labels OCR hits `(OCR)` so bots can hedge. Sidecar skip placeholders (`[OCR skipped on page(s) N]` / `N-M`) are never stored; only blank pages with real OCR text are filled.

Media image build arg `OCR_LANGS` (default `eng`; space-separated) installs `tesseract-ocr-<lang>` packages. Compose forwards `LAW_OCR_*` and the build arg. `media:doctor` prints `tesseract-langs eng,spa` (installed list).

GPU image (documented, not built by default): base `nvidia/cuda:12.3.2-cudnn9-runtime-ubuntu22.04` (CUDA 12 + cuDNN 9, matching faster-whisper 1.2.1 / current ctranslate2), then uncomment the NVIDIA device block in `compose.media.yml`.

Demo smoke: `docs/editions/00-README.md`. Parity map: `docs/editions/law-parity.md`.

## Content encryption

Law text columns use the same space data keys and `rkz1:` ciphertext as core content (`docs/content-encryption.md`). Sealed columns: `law_cases.brief`, `law_documents.body`, `law_document_pages.text`, `law_transcript_segments.text`, `law_media_frames.caption`. Titles, filenames, ids, timestamps and statuses stay plaintext. Original uploaded bytes are already sealed through the artifact store.

`CONTENT_ENCRYPTION=off` writes plaintext; reads still decrypt existing ciphertext. SQL `LIKE` / full-text search over sealed columns is impossible; case chat retrieval scores decrypted snippets in memory (SRCH1 will extend that). Do not add Postgres FTS indexes on these columns.

### Backfill

After turning encryption on (or after upgrading a database that already holds plaintext law rows):

```bash
pnpm --filter @rakazo/edition-law encrypt:backfill [--dry-run] [--case <id>]
```

Idempotent: skips rows that already start with `rkz1:`. Prints per-column counts only (never text). Emergency exit:

```bash
pnpm --filter @rakazo/edition-law encrypt:decrypt [--dry-run] [--case <id>]
```

### Rotation

Core `content-encryption rotate` / `reencrypt` only know core tables. After rotating space data keys, re-seal law text with:

```bash
pnpm --filter @rakazo/edition-law encrypt:reencrypt [--dry-run] [--case <id>]
```

That rewrites rows still sealed under an older key version. Master-key rewrap of `space_keys` remains a core CLI step.
