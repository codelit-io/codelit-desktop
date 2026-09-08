# Codelit Bots for Mac App Review

## Review boundary

- No account is required. The app opens into a seeded, device-local bot workspace.
- The App Store build includes persistent bot conversations, a built-in local model, bot profiles and goals, approved memory, reusable skills, local tables, multi-bot conversations, read-only user-selected folders, and inspectable run receipts.
- It does not include external subscription command-line agents, automated website inspection, computer control, background routines, an updater, prices, checkout links, or purchase prompts.
- The app does not request Accessibility or Screen Recording permission.

## Suggested review path

1. Launch Codelit and open the seeded `Codelit` bot.
2. Select `New bot`, describe one job, and create the bot.
3. Select the bot name to customize its identity. Review its current goal in the workspace, then use the conversation to approve a memory or teach a reusable skill.
4. Add another bot as a conversation teammate, then remove it. No account or network service is required.
5. Open Settings > Intelligence. The built-in model download is optional for reviewing the workspace. On supported hardware, download it and send a short prompt to verify an on-device run and local receipt.
6. Choose a project folder. Codelit uses read-only bookmarks and tools for the selected project, and removing the project revokes that access.
7. Open All activity to inspect completed work and multi-bot handoffs. The App Store build clearly identifies background routines as unavailable.
8. Open Settings > Privacy and confirm automated website inspection and computer control remain unavailable in this profile.
9. In Settings > Privacy, choose `Export all local data`, select a destination, and save the `.codelit` workspace archive. Repeat to replace that backup, then cancel another save dialog to confirm the workspace remains usable. Exports omit sign-ins and folder permissions.
10. Use Command-F to find text in a conversation; navigate matches with Enter and Shift-Enter, then close with Escape. Completed answers and code blocks have explicit Copy controls.
11. Use `Delete local workspace` only when finished reviewing; type `DELETE` to remove app-owned local data while leaving selected project files unchanged.

## Changes addressing the September 2 review

- Guideline 5.2.5: the subtitle is now `Private AI workspace`, with the Apple product term removed.
- Guideline 2.1(a): build 17 adds the sandbox entitlement required by the native Save dialog. Dialog creation is fallible, so an unavailable file picker produces an error instead of terminating the app. Exports use a macOS-authorized temporary directory on the destination volume, then atomically place the completed file at the selected location. Preparing a replacement never truncates the existing backup. Selected project folders continue to use read-only bookmarks and read-only tools.

## Data and commerce

Bot conversations, prompts, memories, skills, routines, local tables, run events, receipts, and folder permissions are encrypted and stored on the Mac. Downloaded model weights are stored locally. Built-in model runs do not send prompts or model output to Codelit or another model provider. If the reviewer explicitly configures and selects a user-owned API provider, that provider receives the bounded run context under its own account and terms.

The app is free, works without a Codelit account, contains no tracking SDK or advertising, and has no purchase or external-checkout path.

## Export compliance stop

This file is not an export-compliance determination. The release command remains blocked until the App Store Connect encryption questionnaire is completed and the resulting reference is provided to the release environment. France must remain unavailable until any required French declaration is cleared.
