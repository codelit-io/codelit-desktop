# Local Scheduler Lifecycle QA

This matrix is the release gate for Codelit for Mac background schedules. A
row is complete only when its named evidence passes. Deterministic checks run
on every development checkpoint; disruptive macOS session checks run against
the exact release-signed build during M6.

| Scenario | Expected result | Current evidence | Release gate |
| --- | --- | --- | --- |
| Sleep, then wake after one due time | The missed policy creates one occurrence and duplicate wakes create none | Native missed-policy and duplicate/concurrent wake tests | Repeat on release-signed Direct build |
| Log out, then log back in | The user LaunchAgent starts, claims one due occurrence, and opens Codelit without focus theft | Helper-to-app claim adoption test | Pending release-signed login-session probe |
| Network goes offline, then online | Network providers pause before execution and resume the same occurrence; MLX continues offline | Native environment pause/resume test and renderer provider-state tests | Repeat on release-signed Direct build |
| Background helper is disabled | Active work loses permission and no later occurrence is claimed | Native consent revocation test plus helper binary fixture | Repeat through Login Items on release-signed Direct build |
| Provider quota is exhausted | The occurrence pauses with a quota repair message and performs no retrying provider work | Renderer lifecycle test and native environment reason test | Automated gate complete |
| Project folder permission is revoked | The occurrence pauses before any Team tool runs | Renderer lifecycle test and native bookmark-state test | Repeat after bookmark revocation in release candidate |
| App and helper wake together | Exactly one idempotency key and run identity are created | Native duplicate, eight-way concurrent, and helper adoption tests | Automated gate complete |
| App is upgraded with a saved schedule | Migration runs once, the schedule survives, and the next due occurrence retains its revision semantics | Native reopen and idempotent migration test | Pending two-version release-signed replacement probe |
| Schedule is disabled or deleted during a claim | The claim is revoked before more external work and no future occurrence runs | Native disable/delete and renderer permission recheck tests | Automated gate complete |

## Release Probe

Run this only with a Developer ID-signed and notarized Direct candidate whose
scheduler helper has the same signing team and designated requirement.

1. Install version N in `/Applications`, enable background work, create one
   local MLX schedule and one network-provider schedule, then quit Codelit.
2. Sleep through one due time and wake. Confirm one run identity per schedule,
   the MLX run completes, and the unavailable network route pauses once.
3. Log out and back in after another due time. Confirm launchd starts the
   helper, Codelit opens without activation, and no duplicate occurrence is
   created.
4. Disable background work in Codelit and Login Items. Confirm an active claim
   is revoked and no due occurrence is created while disabled.
5. Re-enable it, revoke the selected project bookmark, and confirm the next
   Team occurrence pauses before a tool call with the folder repair action.
6. Replace version N with version N+1 without deleting local data. Confirm the
   schedule, revision, next due time, occurrence history, and encrypted receipt
   survive, and confirm the schema migration appears exactly once.
7. Delete both schedules and quit. Confirm neither the helper nor a manual app
   launch can create another occurrence.

Attach the app version, commit SHA, signature verification, notarization
result, macOS version, hardware, UTC timestamps, occurrence IDs, and redacted
notification screenshots to the release record. Never attach prompts, local
paths, credentials, provider output, or workspace content.
