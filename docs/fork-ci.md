# Optional CI publication in a fork

Builds, tests, and downloadable GitHub Actions screenshot artifacts do not need an external publication service.

## Hosted screenshot galleries

The report publisher runs only when repository variables `S3_BUCKET`, `S3_ENDPOINT`, and `PLAYWRIGHT_PUBLIC_BASE_URL` are configured. Also set `S3_REGION` and repository secrets `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` for that storage service. The publisher continues to use trusted default-branch code; it never executes the PR revision with publication credentials.

Without those settings, browser tests still run and screenshots remain in the CI artifacts. Maintainers can attach selected public-safe screenshots to a PR directly.

## Translation catalog pull requests

Set the repository secret `GH_DEPENDENCY_UPDATES_PAT` with access to push the catalog branch and open its pull request, then set `TRANSLATION_CATALOGS_ENABLED=true`. The workflow stays off until explicitly enabled. Extraction runs separately without repository-write credentials.

Disabling catalog publication does not change build-time extraction: new untranslated strings still appear in English. Existing translations remain available, and catalog updates can be submitted in a separate translation PR.
