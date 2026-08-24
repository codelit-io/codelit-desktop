# Codelit Bots for Mac TestFlight

## Internal cohort

Use `Codelit Mac Internal` for the first signed build. Include at least one Apple Silicon Mac with 8 GB, 16 GB, 24/32 GB, and 64 GB unified memory across macOS 14 and the current macOS release where available.

## What to test

1. Create, rename, reopen, reorder, and delete disposable bots while offline.
2. Create a conversation, approved memory, skill, local table, teammate handoff, and run receipt; quit and verify every record returns.
3. Download, cancel, resume, use, and remove the built-in model with adequate and inadequate disk space.
4. Run the built-in model offline and verify no Codelit or model-provider request leaves the Mac.
5. Grant a project folder, relaunch, revoke access, move the folder, and confirm the app fails closed without reading another path.
6. Confirm automated website inspection, computer control, external subscription CLIs, and background routines remain unavailable in the App Store profile.
7. Exercise a user-owned API provider only with a disposable key and verify there is no silent fallback to another billing family.
8. Exercise VoiceOver, full keyboard navigation, increased text size, reduced motion, light mode, and dark mode.
9. Sleep and wake during a local run, interrupt a model download, fill disk space, and recover without losing the conversation.
10. Upgrade from the previous schema fixture, reject a newer unsupported schema, and verify local-only use without a network.
11. Install and update the exact candidate through TestFlight, then verify the build number and receipt after relaunch.

## External cohort

Open `Codelit Mac Local-First` only after the internal matrix passes and the App Review notes, privacy answers, screenshots, export compliance, and support page match the exact candidate build.
