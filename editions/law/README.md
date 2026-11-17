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

Skeleton `src/server.ts` returns `id: "law"` with no routes or hooks yet; later tasks C2 and C3 fill those in.
