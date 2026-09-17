# Codelit Mac user-value progress

Branch: `codex/union-alpha-mac-value`. Model: opencode/union-alpha (free tier only). Owner tasks: push/merge, Apple submission, physical-device acceptance, real-provider QA.

Baseline (2026-09-17): released v0.1.2 App Store build; capability profile excludes browser automation, computer control, background routines, and external subscription CLIs. Desktop sources inspected for greeting/outcome handling, file intents, and tool runtime before edits.

## Phase checklist

### Phase 1: first useful task and recovery
- [ ] Audit `latestBotOutcome` + callers; assistant text alone must not claim success
- [ ] Distinguish answered vs completed-with-evidence vs blocked/cancelled in next-action logic
- [ ] Greeting/clarification parity for natural phrasing (no action loss)
- [ ] Recovery actions bounded and prompt-preserving after failure

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

Phase 1, slice 1: outcome-evidence audit and repair.

## Observations / baseline notes

- `apps/mac/src/bot-outcomes.ts:123` (`latestBotOutcome`): scanning backwards, any `assistant-message`, `receipt`, or completed `run` block sets `status = "completed"` even when the user's latest request is a greeting/clarification/chat-only answer; no evidence distinction.
- Callers: `apps/mac/src/components/BotOutcomeActions.tsx:26` renders "next actions" (goal/skill/monitor prompts) from that status; `latestCompletedBotRequest` feeds repetition UX. Risk: conversational answers escalate to automation suggestions.
- `apps/mac/src/local-file-intent.ts`: greetings handled via exact regex only ("hi", "thanks"); natural variants ("hi there", "hello!") fall through to file-intent parsing and may produce a wrong folder-listing action.
- App Store sandbox excludes browser/computer/scheduler; starters already gate on capability flags; keep that contract.

## Log

- 2026-09-17: docs written; Phase 1 slice 1 started (audit + test-first repair).
