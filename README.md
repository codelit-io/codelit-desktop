# Codelit Desktop

Codelit Desktop is a local-first AI bot workspace for Apple Silicon Macs. It
keeps conversations, goals, approved memory, reusable skills, schedules, local
tables, run events, approvals, and receipts on the user's Mac.

This repository contains only the macOS application and the shared runtime
modules it needs. The Codelit website, hosted execution service, billing,
deployment configuration, and cloud backend are not included.

## What is included

- Persistent local bots and conversations
- Built-in on-device MLX inference with per-model install, resume, repair, and device checks
- Opt-in discovery of recent MLX Community models filtered for this Mac
- User-selected Codex, Copilot, Ollama, LM Studio, OpenAI, Anthropic, and Gemini
  providers, subject to each provider's own terms and availability
- Read-only access to explicitly selected project folders
- Exact approval before browser, computer, MCP, or project write actions
- Local goals, memories, skills, tables, schedules, handoffs, and receipts
- Separate Direct and Mac App Store capability profiles

Codelit's verified models are pinned by revision and checksum before they can
be installed or executed. Live discovery is review-only until a model passes
the same release verification. Model weights, signing certificates, provider
credentials, and Apple credentials are never stored in this repository.

## Requirements

- Apple Silicon Mac
- macOS 14 or later
- Xcode and Xcode Command Line Tools
- Node.js 24.14
- Rust stable

## Development

```bash
npm install
npm run test
npm run desktop:check
npm run desktop:dev
```

`desktop:dev` builds the local MLX and scheduler helpers before starting Tauri.
For renderer-only work, run `npm --prefix apps/mac run dev`.

An ad-hoc Direct build can be created without Codelit's signing credentials:

```bash
npm run desktop:build
```

Production signing, notarization, App Store submission, and updater activation
require maintainer-owned credentials that are intentionally outside the source
tree.

## Repository layout

- `apps/mac/src`: React renderer and local bot experience
- `apps/mac/src-tauri`: Rust host, local storage, providers, browser, computer,
  MCP, scheduler, and security boundaries
- `apps/mac/native`: MLX and scheduler helper sources
- `apps/mac/shared`: workflow types and runtime modules used by the desktop app
- `src/lib/mac-*.test.ts`: desktop regression and release-boundary tests

## Security model

- Local workspace records are encrypted and stored in SQLite.
- API credentials are stored in macOS Keychain.
- Provider processes receive an allowlisted environment.
- Browser, computer, MCP, and project mutations require bounded previews and
  exact approvals.
- App Store builds exclude Accessibility, Screen Recording, background
  scheduling, external subscription CLIs, and automated website inspection.
- Direct builds can expose those capabilities only after the user grants the
  corresponding macOS permission.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Official builds and forks

Source code is available under the Mozilla Public License 2.0. The Codelit name,
logo, bundle identifier, Apple signing identity, and official update channel are
not licensed for third-party distributions. Fork maintainers must change those
identifiers and provide their own signing and update infrastructure. See
[TRADEMARKS.md](TRADEMARKS.md).

Official downloads and product documentation remain available at
[codelit.io](https://codelit.io).

## License

[Mozilla Public License 2.0](LICENSE)
