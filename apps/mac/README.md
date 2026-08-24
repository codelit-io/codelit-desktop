# Codelit for Mac

Local-first Codelit desktop shell for Apple Silicon Macs running macOS 14 or
later. The renderer is a local Vite build; SQLite, provider processes, folder
bookmarks, and helper status live behind typed Tauri commands.

Included surfaces:

- persistent local bots and conversations
- bot goals, approved memory, reusable skills, and local tables
- multi-bot conversations, handoffs, approvals, and receipts
- read-only user-selected project folders
- compact local runtime and privacy settings

Provider Center offers Codelit's verified MLX models with explicit install,
resume, repair, and device-check actions. It can also check recent public MLX
Community models against the Mac's memory and disk capacity. Discovered models
remain review-only until Codelit pins their files and verifies their behavior.
Model files download into the app container and are not committed here.

Provider Center keeps each billing and privacy boundary visible:

| Route | Availability | Authentication and billing |
| --- | --- | --- |
| Codex | Direct build | Existing provider-owned sign-in and subscription allowance |
| GitHub Copilot CLI | Direct build | Existing provider-owned sign-in and eligible Copilot subscription |
| OpenAI, Anthropic, and Gemini APIs | Direct and App Store builds | Explicit metered API key stored in macOS Keychain; never silently selected by Auto |
| Built-in MLX | Direct and App Store builds | Verified on-device model, downloadable from Provider Center |
| Ollama | Direct build | Verified local-only models from a loopback service with Ollama Cloud disabled |
| LM Studio | Direct build | Verified local model from the fixed loopback server at `127.0.0.1:1234` |

Copilot sign-in and runs share a Codelit-owned provider profile. Codelit keeps
run working directories, caches, logs, and session sidecars temporary and does
not import settings or customizations from the user's ambient Copilot profile.

Claude subscription execution remains policy-blocked, and Gemini subscription
execution remains blocked until its official CLI can isolate provider sign-in
from ambient user agents, hooks, plugins, MCP, and settings. Codelit does not
read or copy provider-owned subscription credentials.

## Commands

Run these from the repository root:

```bash
npm run desktop:dev
npm run desktop:check
npm run desktop:build
npm run desktop:build:app-store-spike
npm run desktop:release:check -- --channel direct
npm run desktop:qa:candidate:draft -- --channel direct --artifact /path/app.tar.gz --dmg /path/app.dmg --output /path/qa.json
npm run desktop:qa:candidate:check -- --channel direct --artifact /path/app.tar.gz --dmg /path/app.dmg --receipt /path/qa.json
```

`desktop:build` creates an ad-hoc signed Direct feasibility bundle.
`desktop:build:app-store-spike` creates an ad-hoc signed sandbox bundle with
the App Store entitlement profile. `desktop:release:check` reports every
missing production signing asset without building or printing credentials.
The production Direct build, immutable packaging, signed update activation,
and forward rollback sequence are defined in
[`DIRECT_RELEASE_RUNBOOK.md`](./DIRECT_RELEASE_RUNBOOK.md).
The signed-candidate matrix and App Store/TestFlight delivery boundary are in
[`RELEASE_QA.md`](./RELEASE_QA.md) and
[`APP_STORE_RELEASE_RUNBOOK.md`](./APP_STORE_RELEASE_RUNBOOK.md).

The release profiles are intentionally separate:

- Direct includes the scheduler helper and Codelit's signed updater channel.
- App Store includes the sandboxed MLX helper, excludes the scheduler helper,
  and receives updates only through the Mac App Store.
- Development restores both helpers for local runtime QA and never claims to
  be a signed release channel.

Production Direct release additionally requires a Developer ID Application
certificate, Apple notarization credentials, and the local Tauri updater key.
Production App Store packaging requires Apple Distribution and installer
certificates, an `io.codelit.desktop` provisioning profile, and the Apple team
identifier. Those credentials never belong in this repository.

Direct updater metadata is authenticated separately from the app archive. The
runtime verifies a signed canonical payload that binds the version, notes,
publication time, immutable download URL, and archive signature before it
offers an update. An older signed archive cannot be relabeled as a newer one.

The generated app lives at:

```text
apps/mac/src-tauri/target/release/bundle/macos/Codelit.app
```

## Security boundary

- Local data is stored in SQLite with WAL, foreign keys, migrations, and
  crash-safe transactions.
- Project folders are selected through `NSOpenPanel` and persisted as
  read-only security-scoped bookmarks.
- Provider processes receive an allowlisted environment and no API-key
  variables. Explicit API credentials live only in macOS Keychain and are sent
  directly to the single provider selected for that metered request.
- The sandbox build supports the bundled MLX helper and explicit API-key
  providers. External subscription CLIs and user-managed local servers remain
  Direct-only.
- The scheduler helper is bundled but not registered until an explicitly
  consented release-signed build passes the full lifecycle gate.

The standing design and phase ledger is in
`docs/superpowers/specs/2026-08-11-codelit-mac-local-first-design.md`.
