# Codelit Mac user-value progress

Branch: `codex/union-alpha-mac-value`. Model: opencode/union-alpha (free tier only). Owner tasks: push/merge, Apple submission, physical-device acceptance, real-provider QA.

Baseline (2026-09-17): released v0.1.2 App Store build; capability profile excludes browser automation, computer control, background routines, and external subscription CLIs. Desktop sources inspected for greeting/outcome handling, file intents, and tool runtime before edits.

## Phase checklist

### Phase 1: first useful task and recovery
- [x] Audit `latestBotOutcome` + callers; assistant text alone must not claim success (commit 69cc9ca)
- [x] Distinguish answered vs completed-with-evidence vs blocked/cancelled in next-action logic (commit 69cc9ca)
- [ ] Greeting/clarification parity for natural phrasing (no action loss)
- [x] Recovery actions bounded and prompt-preserving after failure (verified unchanged; conversational questions no longer get goal/skill suggestions)

### Phase 2: private document assistant MVP
- [ ] Selected-file documents (TXT/MD/CSV) through existing sandboxed file access
- [x] First native slice: bounded UTF-8 excerpts with physical-line citations (CSV records/columns still pending)
- [ ] Cancellation + resource limits; clear states for unreadable/unsupported files
- [ ] Text-PDF slice after maintained-parser license/sandbox validation

### Phase 3: continuity (reviewed memory/preferences)
- [ ] Reviewed bot/workspace memory reuse without new permissions
- [ ] Deletion removes derived state from future retrieval

### Phase 4: capability-aware starters + docs
- [ ] Starters reflect executable App Store capabilities only
- [ ] Docs updated; App Store/Direct boundaries unchanged

## Current task

Recovery 2026-09-17: confirmed `codex/union-alpha-mac-value` at `3c5f1a5`, preserving `69cc9ca` and the pending 100-line native document diff. Finish bounded TXT/Markdown/CSV source context first; then one renderer-budget investigation, independent native-document work, reviewed continuity, and capability-aware starters. Existing progress is continued, not restarted.

Open gates: renderer bundle budget (prior run failed; exact current measurement pending), actual supported-model prompt corpus, signed App Store sandbox/source opening, 8 GB physical-device memory/cancellation, and observed-user acceptance. No runtime/model/customer outcomes inferred from fixtures.

Inspection: README, RELEASE_QA, HARNESS_RELEASE_QA, package scripts, current diff and native boundary read; no repository AGENTS.md found. Pending draft incorrectly labels CSV physical lines as records, may truncate disclosure, and treats unreadable bytes as a successful context. Correct those before committing. Keep the existing 64 KiB/file and eight-file boundary for this first slice; broader document limits and picker remain separate work.

## Log

- 2026-09-17: docs written; Phase 1 slice 1 started (audit + test-first repair).
- 2026-09-17: Phase 1 slice 1 committed (69cc9ca). `latestBotOutcome` now takes the workspace receipts and only reports "completed" when the matching receipt body says completed AND has bounded completedTools evidence; assistant text alone yields "answered" (no goal/skill escalation; recovery actions now only for failed/partial/blocked). `buildBotNextActions` gained a CONVERSATIONAL_REQUEST guard so "What can you help me with?" produces no actions. `BotOutcomeActions` passes receipts from the workspace snapshot. Verification: vitest `src/lib/mac-bot-outcomes.test.ts` 11/11 pass under Node 24 (via npx node@24.14.0; local default node is v26.5.0, pinned engines.node=24.x respected); `tsc --noEmit` clean for apps/mac. Environment: repo workspace, macOS host. Limits: renderer-only fixture test; no physical-device or real-model run (no installed model/provider in this environment); no release/QA receipt changed.
- 2026-09-17: Started Phase 2 slice 1 (selected documents). Inspection: `macos.rs` `choose_workspace_folder`/`with_workspace_folder_access` + `resolve_workspace_bookmark` provide sandboxed folder selection; `tool_runtime.rs` `ToolKind::SelectedFiles`/`selected_file_context` reads bounded UTF-8 files from the approved root; `BotsApp.tsx:5578` gates file intents on `workspaceFolder.accessValidated`. Plan: add an explicit document-file intent (TXT/MD/CSV) with line-bounded excerpts + citations, reusing selected-folder validation, before PDF.

### Recovery slice 1: bounded selected text context

- Changed `apps/mac/src-tauri/src/tool_runtime.rs`: retain approved-folder/protected-path boundary; bounded reads cap allocation at 64 KiB + one overflow byte; each selected source gets a fair context share; source lines and explicit partial/empty states fit the 32,000-byte total. CSV references intentionally mean physical lines, not records (quoted multiline fields are not mislabelled). Unsupported formats, binary/invalid UTF-8 and oversized input fail with an export/smaller-excerpt action rather than fabricated successful extraction. Existing cancellation checked before reading and between files. No new cache, permissions, dependency, provider choice, or upload path.
- Added native tests for line fidelity, multiline CSV, non-ASCII byte bounds, partial disclosure, two-source coverage, changed/deleted files, cancellation, oversized/binary/disguised PDF, and empty/long-line documents. Initial regression failed as expected; an incorrect test line count and bool-return assertion were corrected from compiler/test output.
- Verification on this macOS development checkout: Node 24.14.0 `npm test` passed 334 tests/36 files; native default-profile `cargo test` passed 270, ignored 7 live prerequisites; `cargo clippy --all-targets -- -D warnings` and `cargo fmt -- --check` passed. No real model, sandbox permission, source-opening UI, or customer acceptance claimed.
- `npm run desktop:check` reproduced a failure: total JavaScript 223,199 gzip bytes against unchanged 223,000 budget. TypeScript/build succeeded, chained native tests were skipped by that command; native tests were run separately. Prior logged 223,015 is not the current measurement. Focused investigation completed: shared the duplicated completed-tool validator in `bot-outcomes.ts`; Node 24 build remains over budget at 223,185 bytes (185 over), a 14-byte reduction. Inline/persisted receipt parity test added. No budget increase or removal of functionality. Default Node 26 measured different gzip bytes and is not acceptance evidence. Stop bundle comparisons and proceed with independent work.
- Limits: still the existing eight-file/64 KiB reader, folder-based selection and textual citations only; missing named paths alongside valid paths can still be omitted by legacy handoff parsing. Explicit composer document picker, quoted filenames with spaces, structured CSV/PDF parser, source-opening links, extraction identity/cache and 25 MB/10-file limits are not implemented by this slice. Historical conversation excerpts remain stored until conversation deletion. Not release-ready.
- Follow-up: added an `execute_in_root` integration test proving the real approved "Selected files" tool run emits the cited, untrusted-bounded document context (271 native tests pass).

## Observations / baseline notes

- `apps/mac/src/bot-outcomes.ts:123` (`latestBotOutcome`): scanning backwards, any `assistant-message`, `receipt`, or completed `run` block sets `status = "completed"` even when the user's latest request is a greeting/clarification/chat-only answer; no evidence distinction.
- Callers: `apps/mac/src/components/BotOutcomeActions.tsx:26` renders "next actions" (goal/skill/monitor prompts) from that status; `latestCompletedBotRequest` feeds repetition UX. Risk: conversational answers escalate to automation suggestions.
- `apps/mac/src/local-file-intent.ts`: greetings handled via exact regex only ("hi", "thanks"); natural variants ("hi there", "hello!") fall through to file-intent parsing and may produce a wrong folder-listing action.
- App Store sandbox excludes browser/computer/scheduler; starters already gate on capability flags; keep that contract.
