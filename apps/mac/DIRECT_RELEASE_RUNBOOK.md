# Codelit for Mac Direct Release

This runbook publishes the Developer ID-signed, notarized Apple Silicon build.
It does not apply to the Mac App Store profile. Never publish an ad hoc build,
an artifact from a dirty checkout, or an update package that did not pass the
standalone release verifier.

## Release invariants

- Source, `apps/mac/package.json`, its lockfile, Tauri, and Cargo use one stable
  `X.Y.Z` version.
- The release commit is pushed and the checkout is clean before the build.
- The embedded binary identity matches the release commit, version,
  `io.codelit.desktop`, and `sourceDirty: false`.
- `Codelit.app` and the DMG pass Developer ID, Hardened Runtime, Gatekeeper,
  notarization, and stapling checks.
- The updater archive and canonical update manifest have independent Minisign
  signatures from the private key outside this repository.
- The signed update manifest binds the version, notes, publication time,
  Apple Silicon platform, immutable archive URL, and archive signature.
- The signed provenance binds the source commit, release notes, update
  manifest, app archive, DMG, exact candidate QA receipt, all focused
  qualification receipts, public key, CycloneDX SBOM, and rollback intent.
- A rollback is a new, higher version built from the selected known-good source.
  Codelit never enables a downgrade comparator.
- Immutable release assets are published before `latest.json`. Advancing
  `latest.json` is the final activation step.

## One-time setup

1. Install the `Developer ID Application` certificate and its private key in
   the login Keychain.
2. Configure Apple notarization using either an App Store Connect API key or
   the Apple ID variables supported by Tauri.
3. Keep the updater private key and password outside the repository. Supply
   them to the release process through the Tauri signing environment variables
   from a maintainer-controlled secret store.
4. Keep `apps/mac/release/updater.pub` public. Its exact bytes must continue to
   match the Base64 key in `tauri.direct.conf.json`.

## Build

From the repository root, export credentials without printing them:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
export TAURI_SIGNING_PRIVATE_KEY_PATH="/path/from/your/secret-store/updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(your-secret-store read updater-password)"
```

The release command reads the private key from that path into Tauri's child
build environment without printing or committing it.

Export either `APPLE_API_KEY`, `APPLE_API_ISSUER`, and `APPLE_API_KEY_PATH`, or
the supported Apple ID notarization variables. Then run:

```bash
npm run desktop:release:check -- --channel direct
npm run desktop:release:direct
```

The preflight stops before compilation when the checkout is dirty, versions do
not match, a certificate or notarization credential is missing, the updater key
is unavailable, or the profile boundary changed.

Tauri writes the app archive and its `.sig` under
`apps/mac/src-tauri/target/release/bundle/macos/` and the DMG under
`apps/mac/src-tauri/target/release/bundle/dmg/`. Record those exact paths; do
not rename the source files manually.

The release command submits the final signed DMG separately, staples its Apple
ticket, and requires both `stapler validate` and Gatekeeper's open assessment
to pass before reporting success.

## Qualify the exact candidate

Before the broader release matrix, complete the focused Bots P1 journey in
[`P1_RELEASE_GATE.md`](./P1_RELEASE_GATE.md). Its receipt proves the first useful
run against these exact bytes; it does not authorize public activation.

Also complete the Direct-only computer lifecycle matrix in
[`COMPUTER_LIFECYCLE_QA.md`](./COMPUTER_LIFECYCLE_QA.md) and the typed local
reliability matrix in [`LOCAL_RELIABILITY_QA.md`](./LOCAL_RELIABILITY_QA.md)
against these same candidate bytes. Neither focused gate may be inherited from
an older build.

Create a candidate receipt from the exact archive and DMG, distribute those
bytes privately for the physical matrix in [`RELEASE_QA.md`](./RELEASE_QA.md),
and complete the receipt only from durable evidence:

```bash
npm run desktop:qa:candidate:draft -- \
  --channel direct \
  --artifact apps/mac/src-tauri/target/release/bundle/macos/Codelit.app.tar.gz \
  --dmg apps/mac/src-tauri/target/release/bundle/dmg/Codelit_0.1.0_aarch64.dmg \
  --output /absolute/path/direct-candidate-qa.json

npm run desktop:qa:candidate:check -- \
  --channel direct \
  --artifact apps/mac/src-tauri/target/release/bundle/macos/Codelit.app.tar.gz \
  --dmg apps/mac/src-tauri/target/release/bundle/dmg/Codelit_0.1.0_aarch64.dmg \
  --receipt /absolute/path/direct-candidate-qa.json
```

The checker reopens both artifacts and rejects a changed signature, CDHash,
binary, source identity, artifact hash, matrix entry, evidence digest, or
attestation. Do not continue with a pending or TestFlight-only receipt.

## Prepare immutable assets

Write short release notes in a reviewed file outside the generated artifact
directory. For the first release:

```bash
npm run desktop:release:prepare -- \
  --artifact apps/mac/src-tauri/target/release/bundle/macos/Codelit.app.tar.gz \
  --signature apps/mac/src-tauri/target/release/bundle/macos/Codelit.app.tar.gz.sig \
  --dmg apps/mac/src-tauri/target/release/bundle/dmg/Codelit_0.1.0_aarch64.dmg \
  --qa-receipt /absolute/path/direct-candidate-qa.json \
  --p1-receipt /absolute/path/direct-p1-journey.json \
  --computer-lifecycle-receipt /absolute/path/direct-computer-lifecycle.json \
  --reliability-receipt /absolute/path/direct-local-reliability.json \
  --notes-file /absolute/path/to/release-notes.md \
  --initial-release
```

For every later release, download the currently published `latest.json` and
replace `--initial-release` with `--previous-manifest /absolute/path/latest.json`.
The new version must be strictly greater than the published version.

The generated `artifacts/mac/vX.Y.Z/` directory is immutable. It contains the
archive, archive signature, DMG, exact candidate QA receipt, P1 journey receipt,
computer lifecycle receipt, local reliability receipt, CycloneDX SBOM, signed
provenance, release metadata, checksums, and `latest.json`. Preparation fails
unless all four receipts identify the same exact signed candidate. The directory
is excluded from Git.

Verify it independently before upload:

```bash
npm run desktop:release:verify -- artifacts/mac/vX.Y.Z --initial-release
```

Use `--previous-manifest` instead of `--initial-release` after version 1.
Verification repeats cryptographic signatures, hashes, source identity,
Gatekeeper, notarization, stapling, DMG integrity, exact file inventory, SBOM,
and signed-manifest checks.

## Publish in two steps

The dedicated public `codelit-io/codelit-mac-releases` repository must use
`main` and have GitHub immutable releases enabled. Publish and activate are two
separate commands and two separate durable receipts.

First publish only the immutable assets. For release 1:

```bash
npm run desktop:release:publish-assets -- \
  artifacts/mac/vX.Y.Z \
  --output /absolute/path/direct-publication-vX.Y.Z.json \
  --initial-release
```

For later releases, replace `--initial-release` with the same
`--previous-manifest` used during preparation. The command re-verifies the
local release, requires a public repository with immutable releases enabled,
creates the GitHub release without `latest.json`, checks GitHub's asset SHA-256
digests, anonymously downloads every asset, and reruns the standalone verifier.
It writes a mode-0600 receipt before the first remote mutation and records
failure without activating an update. If upload is interrupted, rerun with a
new receipt path. The command resumes only an exact draft, skips matching
assets, uploads only missing files without `--clobber`, and publishes only a
complete draft.

Only after that receipt is verified, activate the exact pointer:

```bash
npm run desktop:release:activate -- \
  artifacts/mac/vX.Y.Z \
  --publication-receipt /absolute/path/direct-publication-vX.Y.Z.json \
  --output /absolute/path/direct-activation-vX.Y.Z.json \
  --initial-release
```

Use `--previous-manifest /absolute/path/current-latest.json` for every later
release. Activation rechecks the immutable release and receipt, compares the
public assets through another anonymous standalone verification, compares the
published pointer byte-for-byte with the expected previous manifest, updates
`latest.json` through GitHub's blob-SHA compare-and-swap, and anonymously
downloads the raw pointer before recording success. Re-running the exact
successful activation is idempotent; any different occupied pointer stops.

Finally, test `Check for updates` from the previous signed release and attach
both receipts to the internal release record.

If any immutable upload differs, stop. Do not advance `latest.json`. A public
release with no pointer is inert to installed clients and can be investigated
without offering a bad update.

## Forward rollback

Never repoint `latest.json` to an older version and never enable downgrade
installation. Restore the known-good source in a new branch, increment to a
higher version, and prepare it with:

```bash
npm run desktop:release:prepare -- \
  --artifact /absolute/path/Codelit.app.tar.gz \
  --signature /absolute/path/Codelit.app.tar.gz.sig \
  --dmg /absolute/path/Codelit_X.Y.Z_aarch64.dmg \
  --qa-receipt /absolute/path/direct-candidate-qa.json \
  --p1-receipt /absolute/path/direct-p1-journey.json \
  --computer-lifecycle-receipt /absolute/path/direct-computer-lifecycle.json \
  --reliability-receipt /absolute/path/direct-local-reliability.json \
  --notes-file /absolute/path/rollback-notes.md \
  --previous-manifest /absolute/path/current-latest.json \
  --rollback-of OLD.VERSION \
  --rollback-commit FULL_40_CHARACTER_COMMIT
```

The signed provenance records the restored version and commit while clients
still receive a normal forward update. Preserve the failed release and its
evidence; never replace its immutable tag or assets.

## Release evidence

Attach the full test result, version, source commit, `SHA256SUMS`, signed
provenance, candidate QA receipt, focused qualification receipts, notarization
result, Gatekeeper output, hardware and macOS version, and the completed
scheduler lifecycle matrix to the release record. Never
attach credentials, updater private keys, prompts, provider output, local paths,
browser data, or workspace content.
