# Direct computer lifecycle qualification

This gate qualifies computer use on one exact Developer ID-signed Direct
candidate. Source tests and ad hoc apps do not satisfy it. The App Store build
must continue to expose no computer-use command or capability.

Use a blank local test workspace and the QA fixture below. Do not use a real
account, private document, credential field, payment surface, or destructive
control. Each evidence bundle should contain only its screenshot, redacted run
receipt, terminal probe, and relevant macOS lifecycle log excerpt.

## Prepare the exact candidate

Install the candidate from its notarized DMG, then confirm the installed binary
matches the source identity used by the candidate checker:

```bash
export CODELIT_CANDIDATE_APP="/Applications/Codelit.app"
export CODELIT_CANDIDATE_EXE="$CODELIT_CANDIDATE_APP/Contents/MacOS/codelit-mac"
"$CODELIT_CANDIDATE_EXE" --release-identity
"$CODELIT_CANDIDATE_EXE" --probe-computer-use
```

Build the isolated local fixture. It has two accessible buttons, no network
code, and no file access. It is a QA tool and is not bundled into Codelit.

```bash
npm run desktop:qa:computer:fixture -- \
  --output /tmp/Codelit-Lifecycle-QA.app
open /tmp/Codelit-Lifecycle-QA.app
```

In Codelit, approve only `Codelit Lifecycle QA` for the test bot. Grant the
candidate Accessibility and Screen Recording access, then create an observation
draft:

```bash
npm run desktop:qa:computer:draft -- \
  --output /absolute/path/computer-lifecycle-observations.json
```

## Record the matrix

Use one distinct evidence directory and zip for each row. Keep the fixture
window visible whenever an app action is expected.

| Check | Exact observation |
| --- | --- |
| `stable-action` | Run `Complete quick action`. The receipt must be completed with two proofs, one window ID, stable topology, and continuous readiness. |
| `stable-multi-display` | With at least two active displays, repeat the quick action. The probe and receipt must both report at least two displays. |
| `locked-session` | Schedule `--probe-computer-use` to run after a short delay, lock the Mac, then unlock. The delayed probe must report `locked`; no app action may dispatch. Reprobe after unlock and record `ready`. |
| `sleep-wake` | Schedule `pmset sleepnow` a few seconds ahead, approve `Hold action for 20 seconds`, then wake the Mac. The receipt must say continuity was lost, preserve only the before proof, say the action may have run, and perform no retry. Include the matching `pmset -g log` excerpt. |
| `display-asleep` | Schedule the exact binary probe, put the display to sleep, then wake it. The sleeping probe must report `display-asleep`; no app action may dispatch. Reprobe and record `ready`. |
| `display-topology-change` | Approve `Hold action for 20 seconds`, then disconnect or disable a secondary display until the run stops. The receipt must report changed display topology, preserve only the before proof, and perform no retry. |
| `accessibility-revoked` | Revoke Accessibility, relaunch the candidate if macOS requests it, and attempt the reviewed action. The receipt/probe must report `accessibility-required` before dispatch. Regrant, relaunch, and record `ready`. |
| `screen-recording-revoked` | Revoke Screen Recording and attempt the reviewed action. The receipt/probe must report `screen-recording-required` before dispatch. Regrant, relaunch, and record `ready`. |
| `approved-app-exit` | Prepare an exact fixture action, quit the fixture before selecting `Allow once`, then approve. The receipt must say the app is not open, record `failed-before-action`, and contain no action proof. |

For delayed lock and display probes, start this from Terminal and perform the
named macOS transition before the delay expires:

```bash
(sleep 8; "$CODELIT_CANDIDATE_EXE" --probe-computer-use > /absolute/path/probe.json) &
```

For the sleep check, prepare the system transition before approving the held
action:

```bash
(sleep 3; pmset sleepnow) &
```

Never infer a pass from the final UI alone. Preserve the exact redacted receipt,
the before/after or before-only proof metadata, and the terminal probe or power
log that establishes the lifecycle transition. The nine evidence archives must
have different SHA-256 digests.

Fill the draft's UTC timestamps, exact macOS version, fixture name and bundle ID,
observed display counts, and absolute evidence paths. Do not change the fixed
expected status, dispatch, continuity, outcome, retry, or proof-count fields.

## Bind and verify

The recorder re-inspects signatures, notarization staples, Gatekeeper, embedded
source identity, app CDHash, executable bytes, DMG bytes, and updater archive
bytes. It refuses to overwrite an existing receipt or accept reused proof
bundles.

```bash
npm run desktop:qa:computer:record -- \
  --artifact /absolute/path/Codelit.app.tar.gz \
  --dmg /absolute/path/Codelit_0.1.1_aarch64.dmg \
  --observations /absolute/path/computer-lifecycle-observations.json \
  --output /absolute/path/computer-lifecycle-receipt.json \
  --attest

npm run desktop:qa:computer:check -- \
  --artifact /absolute/path/Codelit.app.tar.gz \
  --dmg /absolute/path/Codelit_0.1.1_aarch64.dmg \
  --observations /absolute/path/computer-lifecycle-observations.json \
  --receipt /absolute/path/computer-lifecycle-receipt.json
```

Do not check the P5 lifecycle box or activate a public Direct update until the
checker returns `passed` for the exact candidate.
