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
- [ ] Local parsing + bounded excerpts with line/row citations
- [ ] Cancellation + resource limits; clear states for unreadable/unsupported files
- [ ] Text-PDF slice after maintained-parser license/sandbox validation

### Phase 3: continuity (reviewed memory/preferences)
- [ ] Reviewed bot/workspace memory reuse without new permissions
- [ ] Deletion removes derived state from future retrieval

### Phase 4: capability-aware starters + docs
- [ ] Starters reflect executable App Store capabilities only
- [ ] Docs updated; App Store/Direct boundaries unchanged

## Current task

Phase 2, slice 1: selected-document reading (TXT/Markdown/CSV) via existing sandboxed access.

## Log

- 2026-09-17: docs written; Phase 1 slice 1 started (audit + test-first repair).
- 2026-09-17: Phase 1 slice 1 committed (69cc9ca). `latestBotOutcome` now takes the workspace receipts and only reports "completed" when the matching receipt body says completed AND has bounded completedTools evidence; assistant text alone yields "answered" (no goal/skill escalation; recovery actions now only for failed/partial/blocked). `buildBotNextActions` gained a CONVERSATIONAL_REQUEST guard so "What can you help me with?" produces no actions. `BotOutcomeActions` passes receipts from the workspace snapshot. Verification: vitest `src/lib/mac-bot-outcomes.test.ts` 11/11 pass under Node 24 (via npx node@24.14.0; local default node is v26.5.0, pinned engines.node=24.x respected); `tsc --noEmit` clean for apps/mac. Environment: repo workspace, macOS host. Limits: renderer-only fixture test; no physical-device or real-model run (no installed model/provider in this environment); no release/QA receipt changed.
- 2026-09-17: Started Phase 2 slice 1 (selected documents). Inspection: `macos.rs` `choose_workspace_folder`/`with_workspace_folder_access` + `resolve_workspace_bookmark` provide sandboxed folder selection; `tool_runtime.rs` `ToolKind::SelectedFiles`/`selected_file_context` reads bounded UTF-8 files from the approved root; `BotsApp.tsx:5578` gates file intents on `workspaceFolder.accessValidated`. Plan: add an explicit document-file intent (TXT/MD/CSV) with line-bounded excerpts + citations, reusing selected-folder validation, before PDF.

## Observations / baseline notes

- `apps/mac/src/bot-outcomes.ts:123` (`latestBotOutcome`): scanning backwards, any `assistant-message`, `receipt`, or completed `run` block sets `status = "completed"` even when the user's latest request is a greeting/clarification/chat-only answer; no evidence distinction.
- Callers: `apps/mac/src/components/BotOutcomeActions.tsx:26` renders "next actions" (goal/skill/monitor prompts) from that status; `latestCompletedBotRequest` feeds repetition UX. Risk: conversational answers escalate to automation suggestions.
- `apps/mac/src/local-file-intent.ts`: greetings handled via exact regex only ("hi", "thanks"); natural variants ("hi there", "hello!") fall through to file-intent parsing and may produce a wrong folder-listing action.
- App Store sandbox excludes browser/computer/scheduler; starters already gate on capability flags; keep that contract.
