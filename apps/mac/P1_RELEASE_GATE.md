# Codelit Bots P1 release gate

P1 closes only when one fresh user completes the smallest real-work loop against
the exact Developer ID-signed and notarized Direct candidate:

```text
ask -> Allow once -> in-window WebKit read -> Codex result -> local receipt
```

The conversation and receipt must still exist after quit and relaunch, and the
journey must finish in under five minutes. An ad hoc build, renderer fixture,
localhost page, API-key model, or external browser does not satisfy this gate.

This focused gate proves the P1 product claim. It does not replace the physical
hardware, lifecycle, accessibility, update, and recovery matrix required before
public release in [`RELEASE_QA.md`](./RELEASE_QA.md).

## Frozen beta contract

- Direct beta: Apple Silicon only.
- Bundled model: `mlx-community/Qwen3-0.6B-4bit` at revision
  `73e3e38d981303bc594367cd910ea6eb48349da8`, qualified on the 32 GB class.
- Browser state: app-owned and isolated per bot; every run still asks for one
  exact domain.
- Starter jobs: website inspection, approved-project inspection, and a small
  verifiable plan.
- Earlier Codelit work: preserved and exportable from Settings, with no legacy
  workbench in production navigation.

The machine-readable source of truth is
[`bots-p1-beta-policy.json`](./bots-p1-beta-policy.json). Production preflight
fails if this policy drifts from the exact MLX manifest or release target.

## 1. Produce the exact candidate

Use a clean, pushed commit and a passing renderer QA receipt. Configure the
Developer ID, notarization, and updater credentials described in
[`DIRECT_RELEASE_RUNBOOK.md`](./DIRECT_RELEASE_RUNBOOK.md), then run:

```bash
export CODELIT_DESKTOP_RENDERER_QA_RECEIPT=/absolute/path/renderer-qa.json
npm run desktop:release:check -- --channel direct
npm run desktop:release:direct
```

Record the exact updater archive and DMG paths emitted by the build. Do not
rename or rebuild either artifact after testing starts.

## 2. Run the fresh-profile journey

Install the candidate on an Apple Silicon Mac under a fresh macOS user profile.
The profile may already have Codex authenticated, but it must not contain a
Codelit database from an earlier build.

1. Start the timer immediately before launching Codelit.
2. Launch Codelit and confirm the starter bot is immediately usable.
3. Open Settings and confirm that `Codex` says `Ready`. If it says sign-in is
   required, use the single `Sign in` action, complete Codex sign-in in the browser, and
   return to Codelit before starting the timed qualification again.
4. Select the ready `Codex` subscription engine. Do not use `Auto` for this
   qualification because the proof must identify Codex exactly.
5. Ask the starter bot to inspect one public HTTPS page. Use a
   bounded request such as `Inspect https://codelit.io and summarize what the
   product does using only visible page evidence.`
6. Capture the approval showing the exact host, then select `Allow once`.
7. Capture the page visibly open inside Codelit's WebKit surface in read-only
   mode.
8. Capture the useful grounded Codex result.
9. Expand and capture the completed local receipt showing the Codex provider,
   browser host,
   read-only proof, completed status, and no metered fallback.
10. Quit Codelit completely, relaunch it, and capture the restored conversation
   with the same receipt.
11. Stop the timer. The elapsed time from initial launch through restored receipt must be
   less than five minutes.

Use five distinct, sanitized evidence files. Crop or redact unrelated accounts,
paths, prompts, page content, and personal data. Keep the source evidence in the
private release record; the generated receipt contains only byte counts and
SHA-256 digests.

## 3. Record the proof

Use exact ISO-8601 UTC timestamps and the Mac's exact version from
`sw_vers -productVersion`:

```bash
npm run desktop:qa:p1:record -- \
  --artifact /absolute/path/Codelit.app.tar.gz \
  --dmg /absolute/path/Codelit_0.1.0_aarch64.dmg \
  --output /absolute/path/codelit-0.1.0-p1-journey.json \
  --started-at 2026-08-13T17:00:00.000Z \
  --completed-at 2026-08-13T17:04:30.000Z \
  --macos-version 26.6.1 \
  --host codelit.io \
  --allow-once-evidence /absolute/path/01-allow-once.png \
  --in-window-webkit-evidence /absolute/path/02-webkit.png \
  --codex-result-evidence /absolute/path/03-result.png \
  --durable-receipt-evidence /absolute/path/04-receipt.png \
  --relaunch-restore-evidence /absolute/path/05-relaunch.png \
  --fresh-profile \
  --attest
```

`--attest` records the release owner's explicit statement that every supplied
file truthfully represents this exact candidate. The command refuses to replace
an existing receipt, rejects symlinks and empty evidence, checks the five-minute
budget, and reopens the signed candidate before writing a mode-0600 receipt.

## 4. Verify independently

```bash
npm run desktop:qa:p1:check -- \
  --artifact /absolute/path/Codelit.app.tar.gz \
  --dmg /absolute/path/Codelit_0.1.0_aarch64.dmg \
  --receipt /absolute/path/codelit-0.1.0-p1-journey.json \
  --allow-once-evidence /absolute/path/01-allow-once.png \
  --in-window-webkit-evidence /absolute/path/02-webkit.png \
  --codex-result-evidence /absolute/path/03-result.png \
  --durable-receipt-evidence /absolute/path/04-receipt.png \
  --relaunch-restore-evidence /absolute/path/05-relaunch.png
```

The verifier re-hashes all five private proof files and rejects a changed source
commit, signature, CDHash, executable, archive, DMG, journey contract, evidence
digest, duration, provider, browser mode, relaunch result, or attestation.

After it reports `passed`, check the P1 exit gate in the Bots design spec and
append the candidate fingerprint, version, hardware class, macOS version, and
elapsed time to its Progress log. Do not include private evidence or local paths
in the repository.

## Publication boundary

A passing P1 journey authorizes closing the product phase only. It does not
authorize publishing `latest.json`. Public activation remains blocked until the
full exact-candidate receipt in `RELEASE_QA.md` passes every required environment
and check.
