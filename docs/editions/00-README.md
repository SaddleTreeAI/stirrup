# Law edition — demo smoke test

Run this on a clean checkout with a fresh database. Record pass/fail for each step.

Prerequisites: Node 24.15+ (or 26+), pnpm 12, Postgres reachable via `DATABASE_URL` / `DATABASE_MIGRATION_URL` in `.env` (see `docs/development.md`). Do not set `LAW_OPENROUTER_API_KEY` (mock path). Put the seed login file **outside** the repo. Prefer `SANDBOX_PROVIDER=fake` so chat does not need Docker.

```bash
pnpm install
STIRRUP_EDITION=law pnpm --filter @rakazo/db generate
pnpm db:migrate
LAW_LOGIN_FILE=/tmp/law-login.txt pnpm --filter @rakazo/edition-law seed
pnpm dev:law
```

| #   | Step                                                                           | Expect                                                                                                                |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install`                                                                 | Lockfile unchanged; workspace installs.                                                                               |
| 2   | `STIRRUP_EDITION=law pnpm --filter @rakazo/db generate` then `pnpm db:migrate` | Law migrations under `9999…` apply; mismatch of `.edition/edition` vs `STIRRUP_EDITION` refuses.                      |
| 3   | `LAW_LOGIN_FILE=/tmp/law-login.txt pnpm --filter @rakazo/edition-law seed`     | Seeds three cases; writes email/password to the login file (mode 600); password never printed.                        |
| 4   | `pnpm dev:law`                                                                 | Web/API/worker start; prepared law schema used.                                                                       |
| 5   | Sign in with credentials from `LAW_LOGIN_FILE`                                 | Cases environment: far-left rail, case tabs (Ruiz / Ward / Nunez after stripping `Commonwealth v. `). **Screenshot.** |
| 6   | Open a case bot; switch cases                                                  | Roster shows only that case's four bots; other cases' bots hidden. **Screenshot.**                                    |
| 7   | Open the case column                                                           | Library and review documents for the selected case.                                                                   |
| 8   | Send a short message with no OpenRouter key                                    | Slow mock streams a reply (~30–60 s); no GitHub star prompt. **Screenshot.**                                          |
| 9   | Stop; run plain `pnpm dev` (`STIRRUP_EDITION` unset)                           | Ordinary Stirrup shell — no law rail/tabs/column. **Screenshot.**                                                     |
| 10  | Compare with law-demo v2                                                       | Note gaps in the E1 PR; full file map in `docs/editions/law-parity.md`.                                               |

`pnpm dev:law` alone also prepares the DB and migrates when Postgres is up; steps 2–3 remain the explicit clean-checkout path.
