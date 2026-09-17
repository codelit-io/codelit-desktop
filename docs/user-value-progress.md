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

### Review follow-up 2026-09-17 (starting at 009bc4e)

- [x] Confirm branch and preserve prior commits; inspect README, release/harness contracts, picker/read paths and existing tests. No repository AGENTS.md found. Tracked tree initially clean.
- [x] Reproduce selection lifecycle failures with executable state tests; bind selection to bot, draft and approved folder, including async picker completion.
- [x] Add visible remove selection, consume only on successful read, preserve retry/cancel intent, invalidate on access/root changes, and keep native authorization authoritative.
- [x] Audit legacy code-file reads and remove the unused plural non-mac picker stub.
- [ ] Make one purposeful bounded renderer reduction without changing budgets or checking out baselines.
- [x] Run focused and full source checks; commit verified slices and continue independent feasible phase work.

Baseline: focused Node 24.14.0 file-intent/runtime tests pass (13 tests), but no picker lifecycle behavior is covered. Inspection confirms global string selection, no consumption/removal and a truthy path bypass of renderer folder readiness. Native scoped bookmark access still gates reads; root identity is not yet carried with picked paths. Current picker performs a local excerpt read, not a model summary despite its generated prompt. Physical sandbox, model quality and UI acceptance remain unverified.

### Review-follow-up slice 1: selection lifecycle (implemented, committed in this batch)

Renderer (`local-file-intent.ts` new reducer; `BotsApp.tsx`):
- Selections are now `{botId, root, path}` records derived through `documentSelectionReducer` with the active bot and validated folder as the scope; any bot switch, folder change or lost `accessValidated` clears the selection in render and via an effect, so a stale path can never be read for another bot or folder.
- The picker result is applied only if the scope is unchanged when the async panel returns; prefill targets that bot's own prompt draft and no longer overwrites user text.
- The composer send path (`sendComposer`) binds the visible selection to that one request via `options.document`; `submit` rejects a document from another bot, revoked access, a changed root, routines and delegations before any run starts, preserving retry intent on failure/cancel and consuming the selection only on a completed run. Successful sends clear the selection and the draft; failed sends keep both.
- The Document button becomes a visible "Remove document" chip (accessible name includes the filename); clicking removes the selection. `folderReady` no longer treats a stored path as folder access.
- Picked reads now flow through `readSelectedFiles(..., root)` (JSON lossless handoff + `toolInputs["Selected files"].expectedRoot`) and legacy typed reads use the restored `readLocalProjectFile` bounded path validation.

Native (`tool_runtime.rs`, `lib.rs`, `macos.rs`):
- `resolve_scoped_tool` carries `expectedRoot` from tool inputs; `execute_in_root` refuses a Selected-files read whose canonical root differs from the approved bookmark root before opening any file ("Select the document again inside the currently approved folder."). Plain FILES/JSON-array handoffs keep working for model/team flows.
- `choose_workspace_document` command requires `expectedRoot` to match the stored bookmark path and errors with a reselect action otherwise; native authorization remains the sole source of access (renderer never reads bytes).
- Removed the unused `choose_workspace_documents` non-mac stub (confirmed no references).

Verification on this macOS checkout (Node 24.14.0 via npx pin; Rust stable; CARGO_BUILD_JOBS=2):
- Vitest 345 passed (36 files), including 5 new reducer lifecycle fixtures and the root-binding handoff test; regression-first evidence: the new suite failed 5 tests (missing reducer/handoff) before implementation.
- Native cargo test 276 passed / 7 ignored live prerequisites. New `picked_selection_is_rejected_after_the_approved_root_changes` failed first (exit 101: the other root's file was returned), then passed after the canonical-root gate.
- `tsc --noEmit` clean; clippy `--all-targets -D warnings` clean; `cargo fmt --check` clean.
- Renderer QA: full suite passed (74 records, exit 0) including the new `auditDocumentLifecycle` journey (fixture-only evidence): pick → remove chip appears with filename; bot switch and return clear it while preserving the draft; canceled pick preserves the draft; failed read keeps selection + draft with the error; successful send consumes selection, clears draft, records exactly one tool read bound to `/Users/qa/Codelit Project`; the read was verified absent on first run (new audit initially failed 5 times against real behavior) and passes now. No physical device, signed candidate, real model, or real sandbox permission was exercised; the fixture mocks `choose_workspace_document` and `run_local_tool_batch`.
- Renderer bundle gate remains failing and unchanged (entry 501,956/500,000; total 224,253/223,000 gzip; baseline at 009bc4e measured 500,177/223,628): the scoped lifecycle adds ~1.8 KiB entry / ~0.6 KiB gzip. Budget was not raised; the bounded reduction remains open work.

### Next batch 2026-09-17 (starting at ea6134f)

- [x] Confirm correct branch, prior commits and clean tracked tree; read task, roadmap, README and release/harness contracts. No AGENTS.md found.
- [x] Reproduce quoted/spaced path and missing-named-source regressions before fixing native selection parsing.
- [x] Verify bounded selected-path handling without broadening folder access (commit follows).
- [x] Wire the smallest native-backed composer source-selection surface; preserve the request on cancellation/errors.
- [x] Continue independent continuity and capability discovery work; run full source checks and record exact remaining gates.

Baseline remains eight files / 64 KiB each, approved folder bookmarks, no PDF parser or document picker. Existing untracked task inputs and `.qa-logs/` are not this batch's changes. Renderer budget and physical/model acceptance remain open; no owner decision is needed for independent native work.

### Next-batch slice 2: composer document picker (in progress)

- Added `choose_workspace_document` native command: NSOpenPanel scoped to the approved folder bookmark, files only, one file, validates path/extension/size via `selected_document_path` (TXT/MD/CSV, ≤64 KiB, no symlinks/protected names/traversal). Returns the relative path; no bytes are read at pick time.
- `BotsApp.tsx` adds a composer "Document" capability button (only when folder access is validated), prefilling `Summarize <name> with cited line numbers.` if the composer is empty; submission routes the picked path through the new `readSelectedFiles` JSON selection so spaces/quotes survive intact.
- Verification on this checkout: Node 24 tsc clean, vitest 339 passed (36 files) including a new JSON-selection handoff test; native 275 passed / 7 ignored; cargo fmt and clippy `-D warnings` clean. Measured renderer gate: entry 500,177 bytes (over 500,000 by 177) and total 223,456 gzip (over 223,000 by 456); clean baseline at `b231a5d` measured entry under budget and total 223,277 gzip (249 over). The picker adds ~177 entry bytes / ~179 gzip over that failing baseline; budget remains unchanged and failing, recorded as an open gate. No physical device, signed candidate, or real-model run.

## Final status 2026-09-17 (next-batch session end)

Commits this batch (branch `codex/union-alpha-mac-value`, starting at `ea6134f`): `b231a5d` (validate complete selected paths), `1581508` (sandboxed composer document selection). Final verification on the committed tree, Node 24.14.0 / Rust stable, this macOS checkout: native `cargo test` 275 passed / 7 ignored live prerequisites; `cargo fmt -- --check` and `cargo clippy --all-targets -- -D warnings` clean; vitest 339 passed (36 files); `tsc --noEmit` clean; renderer budget gate fails by measurement (entry 500,177/500,000; total 223,456/223,000 gzip) and was never weakened or bypassed.

- Completed: the task file's named next slice — quoted/spaced filenames read correctly and a missing named file now fails the read with an explicit recovery action instead of silent omission (`b231a5d`, regression-first with exit 101 evidence), plus the smallest sandbox-backed composer selection surface with JSON lossless handoff and request-preserving cancellation (`1581508`).
- Open gate (unchanged policy): renderer bundle budget — baseline was already 249 gzip bytes over before this batch; the picker adds ~177 entry / ~179 gzip bytes. A scoped functional reduction is possible follow-up work, but no further repeated comparison was made this session, and the budget was not raised.
- Blocked (recorded, not closed here): exact signed App Store candidate sandbox/source-opening checks, 8 GB physical-device document task, real supported-model 30-prompt corpus, provider/live probes (7 ignored native tests), observed-user acceptance. Web phases 3-4 remain the separate web agent's scope.
- Phase 3 (Mac continuity) next independent steps: structured CSV record parsing and memory-preference reuse UX; deletion already removes memory rows transactionally (`storage.rs` `delete_local_bot_memories` events verified by existing fixtures) and prompt filtering by expiry landed earlier (`709a1c1`).
- Not release-ready; v0.1.2 tag and release receipts untouched. Untracked `.qa-logs/` and the two task input documents remain uncommitted.



Recovery 2026-09-17: confirmed `codex/union-alpha-mac-value` at `3c5f1a5`, preserving `69cc9ca` and the pending 100-line native document diff. Finish bounded TXT/Markdown/CSV source context first; then one renderer-budget investigation, independent native-document work, reviewed continuity, and capability-aware starters. Existing progress is continued, not restarted.

Open gates: renderer bundle budget (prior run failed; exact current measurement pending), actual supported-model prompt corpus, signed App Store sandbox/source opening, 8 GB physical-device memory/cancellation, and observed-user acceptance. No runtime/model/customer outcomes inferred from fixtures.

Inspection: README, RELEASE_QA, HARNESS_RELEASE_QA, package scripts, current diff and native boundary read; no repository AGENTS.md found. Pending draft incorrectly labels CSV physical lines as records, may truncate disclosure, and treats unreadable bytes as a successful context. Correct those before committing. Keep the existing 64 KiB/file and eight-file boundary for this first slice; broader document limits and picker remain separate work.

## Log

### Next-batch slice 1: explicit selected paths

- Native regression tests first failed for quoted filenames containing spaces and a missing named file beside a valid file. Fixed `tool_runtime.rs` to parse the explicit FILES line with quote-aware tokens or a JSON string array (for lossless native-picker paths), ignoring explanatory lines rather than treating prose as filenames.
- Validate the whole selection before reading: missing/inaccessible/nonregular sources, protected/traversing/absolute paths, unclosed quotes and more than eight unique files fail with a recovery action, never silently turn a comparison into a successful one-source read. A missing name is identified; no document bytes are returned on that error. Existing protected-file test now expects failure for a mixed unsafe selection rather than silent omission.
- macOS native fixtures: both regressions observed failing (exit 101), then passing; full native suite 273 passed / 7 ignored before the additional JSON/limit fixture; final focused selection suite 13 passed. Cargo fmt and clippy all-targets `-D warnings` passed. No physical sandbox/model evidence or new parser/cache/permissions. Composer work follows.

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

### Recovery slice 3: reviewed-memory expiry

- Commit `709a1c1`: `bot-prompt.ts` rejects expired or invalid-expiry approved memories at prompt construction (including stale in-memory snapshots). Until-forgotten preferences remain usable. Regression first reproduced the obsolete preference in the generated prompt, then passed after the filter. Combined prompt/outcome tests passed 15/15; Node 24 TypeScript passed. This is prompt-fixture evidence, not a model or deletion-UX acceptance result.
- Commit `56cf438`: shared evidence validation, 12 outcome fixtures pass; renderer budget remains open. Commits `ad3de09` and `67aa505` contain the native document work and approved-tool integration fixture respectively.

### Recovery slice 4: bounded model context

- Reproduced a prompt fixture where a long first source consumed all 4,200 context characters and silently removed the second source. `bot-prompt.ts` now shares that existing budget across up to ten nonempty source sections, preserves complete lines when shortened, and discloses partial/omitted coverage. Native combined file sections are separated using their generated locator headers (content lines are numbered, so they cannot impersonate those headers). All document content remains untrusted; facts need supplied locators and unknown facts stay unknown.
- Five prompt fixtures and Node 24 TypeScript pass, including native-shaped combined Markdown/CSV context. This does not add semantic retrieval, structured CSV records, a larger model window, document selection UI, or PDF extraction. No real-model comparison quality claim.

## Final status 2026-09-17 (recovery session end)

Verification under Node 24.14.0 / Rust stable on this macOS checkout: `npm test` 338 passed (36 files); native `cargo test` 271 passed / 7 ignored live prerequisites; clippy `-D warnings` and `cargo fmt -- --check` clean. Working tree contains only the three task input documents and `.qa-logs/` from the prior session (untracked, untouched).

- Completed: Phase 1 outcome distinction (69cc9ca, prior), outcome evidence parity (56cf438), bounded cited document reading with cancellation and honest unsupported/binary/oversized states (ad3de09), approved-run integration fixture (67aa505), reviewed-memory expiry (709a1c1), bounded multi-source model context (ab6ead6), plus this progress record.
- Open gate (recorded, not bypassed): renderer bundle budget — Node 24 build measures 223,185 gzip bytes vs 223,000; one focused deduplication (56cf438) recovered 14 bytes without weakening the budget. Remaining gap requires either code removal or an owner budget decision; per task constraints, stopped after one investigation.
- Blocked (cannot close from this environment, recorded as open): exact signed App Store candidate sandbox/source-opening checks, 8 GB physical-device document task, real supported-model 30-prompt corpus run, provider/live probes (native suite ignores them without installed subscriptions/models), and observed-user acceptance for Phase 2. Physical/device/model work remains owner-side per task constraints.
- Phase 3 (web recurring) and Phase 4 (Google delivery) belong to the separate web agent/checkout per task scope; not attempted here. Mac capability starters already gate on ready capabilities; no unexecutable starter was added. Phase 5 continuity: memory expiry filtering improves reuse correctness; broader preference UX remains open.
- Not release-ready; v0.1.2 tag and release receipts untouched. Next: owner decision on the 185-byte bundle gap or a functionally scoped reduction; native composer document picker for explicit file selection; structured CSV record parsing; maintained text-PDF parser evaluation (license/sandbox/memory) before the PDF slice.

## Observations / baseline notes

- `apps/mac/src/bot-outcomes.ts:123` (`latestBotOutcome`): scanning backwards, any `assistant-message`, `receipt`, or completed `run` block sets `status = "completed"` even when the user's latest request is a greeting/clarification/chat-only answer; no evidence distinction.
- Callers: `apps/mac/src/components/BotOutcomeActions.tsx:26` renders "next actions" (goal/skill/monitor prompts) from that status; `latestCompletedBotRequest` feeds repetition UX. Risk: conversational answers escalate to automation suggestions.
- `apps/mac/src/local-file-intent.ts`: greetings handled via exact regex only ("hi", "thanks"); natural variants ("hi there", "hello!") fall through to file-intent parsing and may produce a wrong folder-listing action.
- App Store sandbox excludes browser/computer/scheduler; starters already gate on capability flags; keep that contract.
