# Codelit agentic harness release QA

This gate verifies the exact signed Direct candidate, not a source build or
renderer fixture. It supplements the broader candidate matrix in
[`RELEASE_QA.md`](./RELEASE_QA.md).

## Candidate boundary

- Install one unchanged Developer ID-signed and notarized candidate.
- Use a fresh disposable bot conversation with one approved project, one
  teammate, one observed Mac app, and one reviewed MCP connection.
- Run journeys 1-6 with a ready built-in MLX model.
- Run journeys 7-10 with one ready user-owned subscription provider.
- Keep metered fallback off throughout the gate.
- Capture the completed conversation, approval, and receipt evidence in one
  sanitized archive. Record only its SHA-256 digest in the candidate receipt.

## Ten journeys

1. Ask `Hi, what can you help me with?` and receive a natural answer without a
   file-read or project-failure claim.
2. Ask `I want you to own getting this release ready`. Confirm the model uses
   the typed local goal action, changes one goal, and offers Undo.
3. Ask for a private release-risk tracker without using the words `create a
   table`, then add one row conversationally. Confirm one table and one row.
4. Ask what the approved project does. Confirm the harness reads the approved
   folder before answering and names the completed read in the receipt.
5. Ask the bot to keep watching the project for material changes. Confirm it
   prepares one disabled project watch and requires one explicit start.
6. Ask the conversation's teammate to challenge the release evidence. Confirm
   one bounded delegation, one returned result, and no recursive delegation.
7. Ask for a read-only inspection of one public HTTPS page. Confirm the exact
   host approval, in-window browser evidence, grounded answer, and no external
   write.
8. Ask the bot to inspect one approved Mac app without changing it. Confirm the
   visible-state summary. If the model proposes an action, hold it and confirm
   nothing changed.
9. Ask the reviewed MCP connection to perform one harmless disposable action.
   Confirm typed arguments, exact approval, one invocation, checkpoint resume,
   and no repeated call.
10. Repeat one useful inspection twice. Use `Keep doing this`, confirm one
    disabled weekday routine, start it once, quit, relaunch, and verify the
    routine, conversation, and receipts return.

## Pass conditions

- Every journey finishes with a useful answer or one precise blocker.
- No native or external action runs twice after recovery or approval resume.
- Local writes match the typed preview and stay on this Mac.
- External, browser-write, and computer actions remain behind exact approval.
- Failed or paused work exposes `Retry one safe step` and `Explain the blocker`.
- The conversation offers no more than two contextual next actions.
- All ten receipts identify the selected provider and whether a metered
  invocation started.
- Quit and relaunch restore the goal, table, delegation result, routines,
  conversation, and receipts.

Mark `direct-agentic-harness` passed in the exact candidate receipt only after
all ten journeys pass against that same artifact.
