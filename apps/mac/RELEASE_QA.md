# Codelit for Mac release QA

This checklist separates deterministic source QA from physical testing of an
exact signed candidate. Passing the source suite does not authorize a release.

The focused Bots P1 product gate has its own exact-candidate journey in
[`P1_RELEASE_GATE.md`](./P1_RELEASE_GATE.md). Passing that journey closes P1 but
does not replace or weaken the public-release matrix below.

Direct computer use has a separate exact-candidate lifecycle gate in
[`COMPUTER_LIFECYCLE_QA.md`](./COMPUTER_LIFECYCLE_QA.md). It covers stable and
multi-display actions, lock, sleep/wake, display state and topology, permission
revocation, approved-app exit, recovery, and no automatic retry.

## Source-bound renderer gate

Run from the repository root on Apple Silicon macOS:

```bash
npm run desktop:qa:renderer
```

The command builds the production renderer and writes a temporary JSON receipt
plus focused QA screenshots. The receipt covers the bot roster, conversations,
profiles, settings, memory, skills, routines, multi-bot handoffs, approvals,
receipts, local data, and release-channel boundaries in:

- `1440x900`, light, en-US;
- `1440x900`, dark, en-US;
- `760x560`, light, de-DE locale formatting;
- `760x560`, dark, en-US.

Every run uses reduced motion, performs WCAG 2.2 AA Axe checks, rejects console
warnings and errors, rejects page-level overflow and unexpected nested
scrollers, enforces a 2,500-node DOM budget, and requires Home to become ready
within five seconds. The release-light pass also creates and edits bot profiles,
memory, skills, routines, local data, handoffs, receipts, and Settings states.

Production release preflight requires the receipt path:

```bash
export CODELIT_DESKTOP_RENDERER_QA_RECEIPT=/absolute/path/renderer-qa.json
npm run desktop:release:check -- --channel direct
npm run desktop:release:check -- --channel app-store
```

The gate rejects a failed, incomplete, dirty-tree, stale-commit, wrong-version,
or non-Apple-Silicon receipt. Ad hoc builds intentionally do not require one.
The App Store profile also carries an explicit positive `CFBundleVersion`; bump
it for every uploaded candidate, independently of the public semantic version.

The first App Store submission is en-US only. The de-DE run verifies locale-
sensitive formatting and layout resilience; it does not claim translated UI.

## Native deterministic suite

Both release profiles must pass independently:

```bash
PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo test \
  --manifest-path apps/mac/src-tauri/Cargo.toml --features direct-release
PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo test \
  --manifest-path apps/mac/src-tauri/Cargo.toml --features app-store-release
PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo clippy \
  --manifest-path apps/mac/src-tauri/Cargo.toml --all-targets \
  --features direct-release -- -D warnings
PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo clippy \
  --manifest-path apps/mac/src-tauri/Cargo.toml --all-targets \
  --features app-store-release -- -D warnings
```

The deterministic suite covers encrypted storage and export, ordered schema
migration, transaction interruption, offline edit/reopen/restore, run crash
recovery, duplicate schedule wakes, sleep/wake claims, DST, bounded retries,
quota and offline pauses, helper disable/delete, and revoked work. Native MLX
guards pause setup in Low Power Mode and terminate downloads, benchmarks, or
inference under serious or critical thermal pressure.

The physical P7 accessibility, idle energy, thermal policy, migration,
offline, and checkpoint recovery observations use the candidate-bound typed
receipt in [`LOCAL_RELIABILITY_QA.md`](./LOCAL_RELIABILITY_QA.md). A generic
evidence digest in the broad matrix is not a substitute for that focused gate.

## Exact signed-candidate receipt

Create the receipt only after the production artifacts exist. The command
verifies Apple signatures, embedded source identity, app CDHash, executable
digest, artifact hashes, bundle version, sandbox boundary, and the current
clean commit before it writes a draft.

```bash
# Direct
npm run desktop:qa:candidate:draft -- \
  --channel direct \
  --artifact /absolute/path/Codelit.app.tar.gz \
  --dmg /absolute/path/Codelit_X.Y.Z_aarch64.dmg \
  --output /absolute/path/direct-candidate-qa.json

# App Store
npm run desktop:qa:candidate:draft -- \
  --channel app-store \
  --package /absolute/path/Codelit-X.Y.Z-app-store.pkg \
  --output /absolute/path/app-store-candidate-qa.json
```

Never replace the generated `candidate`, `candidateFingerprint`, environment
classes, check IDs, labels, or attestation statements. For every measured
result, store the SHA-256 digest of its durable evidence bundle, not a local
path or credential. Produce one with
`shasum -a 256 /absolute/path/evidence.zip`.

For Direct, finish every environment and check, set `status` to `passed`, record
UTC `preflightCompletedAt` and `completedAt`, sign both attestations, and verify:

```bash
npm run desktop:qa:candidate:check -- \
  --channel direct \
  --artifact /absolute/path/Codelit.app.tar.gz \
  --dmg /absolute/path/Codelit_X.Y.Z_aarch64.dmg \
  --receipt /absolute/path/direct-candidate-qa.json
```

For App Store, first set `status` to `testflight-ready`, record
`preflightCompletedAt`, and sign only the preflight attestation. Hardware
environments and checks remain `pending` until the exact package is installed
through TestFlight. Verify this limited state with `--stage testflight-upload`.
After TestFlight QA, mark every item passed with evidence, set `status` to
`passed`, record `completedAt`, sign the release attestation, and rerun without
`--stage`. A TestFlight-ready receipt cannot authorize App Review or release.

## Measured preflight baseline

On 2026-08-12, an ad hoc-signed App Store-profile build was measured on an M1
Pro Mac with 32 GB unified memory running macOS 26.6.1:

| Measurement | Result |
| --- | --- |
| App bundle | 62 MB |
| Renderer assets | 532 KB |
| Main-process physical footprint | 19.9-20 MB |
| Main-process peak physical footprint | 21.7 MB |
| Main-process idle CPU, three samples | 0.3-0.4% |

These are idle preflight measurements, not total WebKit-process memory and not
local-model inference measurements. Xcode's Power Profiler does not support a
macOS target, so energy is evaluated with idle samples, runtime thermal and
Low Power Mode guards, and the physical battery test below. The Mac was locked
during the native sample; startup was waiting on protected Keychain access, so
workspace-ready timing must be repeated after unlock.

## Signed candidate matrix

Run these checks on the exact Developer ID and App Store/TestFlight candidates.
Record the version, source commit, code-signing identity, CDHash, hardware,
memory, macOS version, and result. Never reuse an ad hoc result.

- Fresh install, launch, create a bot plus every shipped local record kind, quit, relaunch, and restore.
- Upgrade across two schema versions; reject a downgrade without data loss.
- Uninstall/reinstall and complete local-data deletion.
- Signed out; each advertised provider ready; provider sign-out mid-run; quota;
  missing and incompatible provider versions.
- Offline, intermittent network, sleep/wake, logout/login, restart, low battery,
  Low Power Mode, thermal pressure, and low disk.
- Folder permission revoked, repository moved, symlink escape, dirty repository,
  worktree conflict, and a large repository.
- Model download interruption, corruption, insufficient disk, invalid license,
  memory pressure, cancellation, and killed helper/provider.
- Duplicate schedule wake, stale approval, disabled helper, schedule deletion,
  and upgrade replacement.
- Network capture proving an on-device run makes no Codelit or provider request.
- VoiceOver, keyboard-only use, increased contrast, reduced motion, light/dark,
  and minimum and release window sizes.
- Direct update signature, notarization, staple, forward rollback, and relaunch.
- App Store sandbox capability set, local-data deletion, no-account launch, no purchase CTA, and
  TestFlight install/update.

Test the minimum, previous, and current supported macOS releases across the
locked 8 GB, 16 GB, 24 GB, 32 GB, and 64 GB Apple Silicon receipt environments.
Local-model availability must
remain disabled for any hardware class that has not passed its model benchmark.
The first release manifest enables the bundled model only for the measured
32 GB class. Add another exact memory size to `releaseValidatedMemoryGiB` only
after the signed candidate passes this matrix on that hardware.

## Publication stop

Do not publish Direct `latest.json`, submit the App Store build, or check the M6
QA box in the design spec until the signed candidate matrix is complete. Direct
ships first. App Store submission may follow only with the exact sandboxed
capabilities that passed TestFlight.
