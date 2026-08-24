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
6. Choose a project folder. The macOS picker grants read-only access, and removing the project revokes that access.
7. Open All activity to inspect completed work and multi-bot handoffs. The App Store build clearly identifies background routines as unavailable.
8. Open Settings > Privacy and confirm automated website inspection and computer control remain unavailable in this profile.
9. In Settings > Privacy, use `Delete local workspace` only when finished reviewing; type `DELETE` to remove app-owned local data while leaving selected project files unchanged.

## Data and commerce

Bot conversations, prompts, memories, skills, routines, local tables, run events, receipts, model files, and folder permissions are encrypted and stored on the Mac. Built-in model runs do not send prompts or model output to Codelit or another model provider. If the reviewer explicitly configures and selects a user-owned API provider, that provider receives the bounded run context under its own account and terms.

The app is free, works without a Codelit account, contains no tracking SDK or advertising, and has no purchase or external-checkout path.

## Export compliance stop

This file is not an export-compliance determination. The release command remains blocked until the App Store Connect encryption questionnaire is completed and the resulting reference is provided to the release environment. France must remain unavailable until any required French declaration is cleared.
