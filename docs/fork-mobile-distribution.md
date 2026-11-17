# Fork mobile distribution

The optional `release-mobile-fork` workflow builds the configured fork on `main` and uploads it to TestFlight. It does not submit public App Review or build Android. Native signing credentials must already exist in the build service for the app and its extensions.

Set these repository secrets:

- `MOBILE_DISTRIBUTION_TOKEN`: the build-service access token for the account that owns the fork project. This separate secret does not enable the upstream release or update workflows.
- `MOBILE_APPLE_TEAM_ID`: the existing app's Apple signing team. Together with `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_API_KEY_P8`, this lets the build service validate and renew its provisioning profile. The API key needs provisioning access; it is written only to a private temporary file and removed when the build step exits.
- `MOBILE_DISTRIBUTION_CONFIG`: a JSON object containing `name`, `slug`, `owner`, `scheme`, `projectId`, `bundleIdentifier`, `version`, `appStoreConnectAppId`, and `apiUrl`. Use the fork's identities and an HTTPS server URL. Never commit the real values.

The workflow rewrites configuration only in its temporary checkout, including native extension identities, app groups, and the update project. Native fingerprints keep incompatible builds from sharing updates. Build numbers increment in the build service. Keep `version` at least as new as the installed app version, and raise it for a new marketing release.

Run the workflow from Actions or through an authorized repository connection. Only the exact finished iOS build whose project and bundle identifier match the configuration is submitted. Private build logs remain in the temporary runner filesystem; investigate failures in the build-service dashboard. Testers install through TestFlight; their device controls automatic installation.

## Installing Stirrup

Existing testers install updates from TestFlight. Public App Store distribution is not enabled by this workflow. The display name comes from `app.json`; the existing bundle, signing, project and legacy URL-scheme identities are preserved.

## Android APK

The separate `release-android-fork` workflow produces an installable APK artifact from `main`, without submitting to a store. Set an explicit `androidPackage` in the private distribution configuration or the `MOBILE_ANDROID_PACKAGE` secret. The workflow refuses to build without it and verifies the finished build's project, package, and profile before downloading it. Configure the signing key in the owned build-service project first; retain that key for future updates.

Android push additionally needs that application's messaging configuration and server credentials in the owned build project. An APK can be built without them, but background push notifications will not work. The build does not provision messaging credentials or borrow the upstream project's configuration. Account switching and foreground usage remain available.
