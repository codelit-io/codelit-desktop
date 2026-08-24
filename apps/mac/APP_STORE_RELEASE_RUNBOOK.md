# Codelit for Mac App Store Release

This runbook produces the sandboxed Mac App Store package, uploads it privately
to TestFlight, and stops before App Review submission. It never applies Direct
entitlements, updater files, subscription CLIs, or the local scheduler helper.

## Release invariants

- The source checkout is clean and pushed, and the renderer QA receipt belongs
  to that exact commit and desktop version.
- `CFBundleVersion` is a positive integer matching
  `app-store/submission.json`; increment it for every uploaded build.
- The app uses Mac App Distribution signing, the package uses Mac Installer
  Distribution signing, and the embedded provisioning profile authorizes
  `io.codelit.desktop` for the configured Apple team.
- The package contains App Sandbox, read-only user-selected files, outbound
  network access, `PrivacyInfo.xcprivacy`, and no Direct-only files.
- A `testflight-ready` QA receipt may authorize only private TestFlight upload.
  App Review requires the same exact candidate receipt to reach `passed`.
- Uploading a build does not submit it for App Review. Review submission remains
  a separate App Store Connect action after the full matrix passes.

## One-time setup

1. Create the `io.codelit.desktop` macOS App ID and App Store Connect app record.
2. Install the Mac App Distribution certificate and private key, Mac Installer
   Distribution certificate and private key, and explicit distribution profile.
3. Create an App Store Connect API key with the minimum role needed to validate
   and upload builds. Keep its `.p8` file outside this repository.
4. Complete Apple's encryption questionnaire. Record the resulting reference;
   keep France unavailable until any required declaration is cleared.
5. Fill the secure review contact phone in App Store Connect. Do not commit it.

## Build

Export paths and exact identity names without printing credentials:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
export CODELIT_DESKTOP_RENDERER_QA_RECEIPT=/absolute/path/renderer-qa.json
export APPLE_SIGNING_IDENTITY="Apple Distribution: Codelit (TEAMID)"
export CODELIT_INSTALLER_SIGNING_IDENTITY="Mac Installer Distribution: Codelit (TEAMID)"
export CODELIT_APP_STORE_PROFILE=/absolute/path/Codelit_App_Store.provisionprofile
export CODELIT_APPLE_TEAM_ID=TEAMID

npm run desktop:release:check -- --channel app-store
npm run desktop:release:app-store
```

The package is written beside `Codelit.app` as
`Codelit-X.Y.Z-app-store.pkg`. Record the exact path and do not rebuild or
replace it after QA starts.

## Open private TestFlight

Create the receipt from the exact package:

```bash
npm run desktop:qa:candidate:draft -- \
  --channel app-store \
  --package /absolute/path/Codelit-X.Y.Z-app-store.pkg \
  --output /absolute/path/app-store-candidate-qa.json
```

Review the candidate identity. Set the receipt to `testflight-ready`, record its
UTC `preflightCompletedAt`, and sign the preflight attestation. Leave every
environment and check pending, `completedAt` null, and the release attestation
unsigned. Verify the limited state:

```bash
npm run desktop:qa:candidate:check -- \
  --stage testflight-upload \
  --channel app-store \
  --package /absolute/path/Codelit-X.Y.Z-app-store.pkg \
  --receipt /absolute/path/app-store-candidate-qa.json
```

The four App Store screenshots intentionally remain pending at this stage. They
must come from the exact TestFlight-installed build, so they cannot gate the
private TestFlight upload that makes that installation possible.

Export App Store Connect delivery values:

```bash
export APPLE_API_KEY=KEY_ID
export APPLE_API_ISSUER=ISSUER_UUID
export APPLE_API_KEY_PATH=/absolute/path/AuthKey_KEY_ID.p8
export CODELIT_APP_STORE_APP_ID=NUMERIC_APP_ID
export CODELIT_APP_STORE_EXPORT_COMPLIANCE_REFERENCE=APPLE_REFERENCE
```

Validate first. This contacts App Store Connect but does not upload the package:

```bash
npm run desktop:app-store:validate -- \
  --package /absolute/path/Codelit-X.Y.Z-app-store.pkg \
  --qa-receipt /absolute/path/app-store-candidate-qa.json \
  --output /absolute/path/app-store-validation.json
```

Only after validation succeeds, explicitly upload the same bytes to private
TestFlight:

```bash
npm run desktop:app-store:upload -- \
  --package /absolute/path/Codelit-X.Y.Z-app-store.pkg \
  --qa-receipt /absolute/path/app-store-candidate-qa.json \
  --output /absolute/path/app-store-upload.json
```

The delivery receipt binds the package version, build, candidate fingerprint,
QA receipt digest, metadata digest, export reference, and Apple response. If
exact screenshots already exist, their digests are included, but they are not a
private TestFlight prerequisite. Store the receipt with the release evidence
and never commit credentials.

## Complete TestFlight and review readiness

Install the uploaded build through TestFlight and complete every environment and
check in [`RELEASE_QA.md`](./RELEASE_QA.md). Add durable evidence digests, set
the receipt to `passed`, record `completedAt`, and sign the release attestation.
Complete the typed accessibility, idle energy, thermal policy, migration,
offline, and checkpoint recovery gate in
[`LOCAL_RELIABILITY_QA.md`](./LOCAL_RELIABILITY_QA.md). Its resource probe must
identify the same App Store executable SHA-256 as this package.
Capture the four exact signed-candidate screenshots listed in
`app-store/submission.json` into `app-store/screenshots/`, then require
`npm run desktop:app-store:check -- --release` to pass before App Review.
Verify the exact package again without the TestFlight stage:

```bash
npm run desktop:qa:candidate:check -- \
  --channel app-store \
  --package /absolute/path/Codelit-X.Y.Z-app-store.pkg \
  --receipt /absolute/path/app-store-candidate-qa.json
```

Confirm the App Store Connect listing, screenshots, privacy answers, age rating,
export compliance, support URL, review notes, free-local commerce, and build
selection match this candidate. Only then may a release owner submit it for App
Review. Preserve the validation, upload, TestFlight, and final QA receipts.

## Failure and replacement

Never overwrite a receipt or reuse a build number. If the binary, package,
metadata-sensitive capability set, or screenshots must change, increment
`CFBundleVersion`, rebuild from a clean commit, create a new receipt, and repeat
private TestFlight. Expire or remove the rejected candidate in App Store Connect
only after the replacement is traceable.
