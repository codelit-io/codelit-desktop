# Local Reliability QA

This is the focused P7 reliability gate for Codelit Bots. It proves six
failure-sensitive behaviors against one exact signed Direct or App Store
candidate. It complements the broad environment matrix in
[`RELEASE_QA.md`](./RELEASE_QA.md); it does not replace it.

The receipt stores typed observations and SHA-256 evidence metadata. It never
stores local paths, prompts, workspace content, credentials, or provider
output. Every check needs a distinct durable evidence bundle.

## Safety rules

- Use disposable QA bots, local fixtures, and non-sensitive data.
- Do not create thermal pressure on purpose. The exact candidate's compiled
  policy probe exercises nominal, fair, Low Power Mode, serious, critical,
  constrained-memory, and critical-memory decisions without heating the Mac.
- Disable the network only after the bundled MLX model is installed and its
  license has been accepted.
- Force-quit only the disposable QA run named in the evidence. Never terminate
  another running app or repeat an external action to manufacture recovery.
- Keep the original candidate, observation file, probe JSON, and evidence
  bundles immutable after attestation.

## 1. Create the observation draft

```bash
npm run desktop:qa:reliability:draft -- \
  --output /absolute/path/local-reliability-observations.json
```

Replace every `RECORD_*` value and zero placeholder with the measured result.
Do not edit IDs, expected booleans, or evidence labels.

## 2. Capture the exact resource policy

Launch the app through macOS LaunchServices so sandboxed TestFlight builds run
inside their app container. Quit Codelit first, then capture stdout from the
same installed candidate used for the receipt:

```bash
open -n -W -g \
  -o /absolute/path/resource-policy-probe.json \
  --stderr /absolute/path/resource-policy-probe.err \
  /absolute/path/Codelit.app --args --probe-resource-policy
```

The probe identifies its channel, source commit, version, and executable
SHA-256. The recorder rejects it unless those values match the candidate. Both
release channels must contain this probe. A development build reports the
`development` channel and cannot qualify a release candidate. Do not execute a
Mac App Distribution-signed binary directly from Terminal; macOS terminates it
outside the App Sandbox container.

## 3. Complete the six checks

### Assistive access

Complete first launch, bot selection, a local run, approval review, receipt
review, routine creation, pause, and resume using only the keyboard. Repeat the
core path with VoiceOver. Repeat visual review with Increase Contrast and
Reduce Motion enabled. Record zero unlabelled controls, focus-order issues, and
blocked controls.

### Idle energy

Leave Codelit open and idle for at least five minutes with no routine due.
Collect at least 30 samples across the Codelit process tree. The median CPU must
be at most 1.5 percent, p95 at most 5 percent, and peak resident memory at most
1,024 MiB. Confirm no run starts and no unexpected Codelit or provider request
occurs. Record raw timestamped samples and the network capture in the evidence
bundle.

### Thermal backpressure

Attach the exact resource-policy JSON plus the live Low Power Mode observation.
The probe must show two healthy specialist lanes, one lane for fair, Low Power
Mode, and constrained memory, and zero new lanes for serious, critical, and
critical-memory states. It must block MLX setup in Low Power Mode and all MLX
work under serious or critical thermal pressure.

### Two-version migration

Install the preserved candidate whose schema is at least two revisions behind.
Create at least one bot, thread, run, routine, skill, memory, local table, and
browser session. Record a canonical logical export and counts, upgrade in
place, and confirm the export digest and every count are unchanged. Relaunch a
second time and confirm no migration row is applied. Attempt the old app and
confirm it refuses the newer database without changing it.

### Offline local run

Block all network traffic, launch the exact candidate, and complete one MLX
task. Record exactly one completion receipt, zero Codelit requests, zero
provider requests, and no automatic fallback. A cached page or a task that
started before the network block does not count.

### Checkpoint recovery

Use a disposable local fixture with one completed typed action. Stop the app
after the next checkpoint, relaunch, and confirm the run is `interrupted`, the
completed-action count is unchanged, and no retry starts automatically. Resume
from the preserved checkpoint and confirm completion with zero duplicate
actions and a final receipt.

## 4. Record and check the receipt

Direct:

```bash
npm run desktop:qa:reliability:record -- \
  --channel direct \
  --artifact /absolute/path/Codelit.app.tar.gz \
  --dmg /absolute/path/Codelit_X.Y.Z_aarch64.dmg \
  --observations /absolute/path/local-reliability-observations.json \
  --output /absolute/path/direct-local-reliability.json \
  --attest

npm run desktop:qa:reliability:check -- \
  --channel direct \
  --artifact /absolute/path/Codelit.app.tar.gz \
  --dmg /absolute/path/Codelit_X.Y.Z_aarch64.dmg \
  --observations /absolute/path/local-reliability-observations.json \
  --receipt /absolute/path/direct-local-reliability.json
```

App Store after installation through TestFlight:

```bash
npm run desktop:qa:reliability:record -- \
  --channel app-store \
  --package /absolute/path/Codelit-X.Y.Z-app-store.pkg \
  --observations /absolute/path/local-reliability-observations.json \
  --output /absolute/path/app-store-local-reliability.json \
  --attest

npm run desktop:qa:reliability:check -- \
  --channel app-store \
  --package /absolute/path/Codelit-X.Y.Z-app-store.pkg \
  --observations /absolute/path/local-reliability-observations.json \
  --receipt /absolute/path/app-store-local-reliability.json
```

Do not mark P7 complete from deterministic tests, a development build, one
channel, or an unbound screenshot. P7 closes only when this focused receipt,
the broad signed-candidate matrix, the physical P5 lifecycle matrix, and the
remaining pilot and publication criteria all pass.
