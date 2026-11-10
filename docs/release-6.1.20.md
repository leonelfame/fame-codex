# Fame Codex 6.1.20

Integrates [upstream 6.1.18 and its test-stability follow-up](https://github.com/miuuyy/codex-chatgpt-web/commit/32fd3436eb6ed94898b987a3c369003bb6fb8d54).

- Recognize current ChatGPT model controls. An unrecognized interface now fails explicitly instead of overwriting a paid account's model catalog with Luna-only capability.
- Preserve current workspace roots, goal edits, task identity and completed work across partial context updates and compaction.
- Recognize previously observed ChatGPT messages when they return into view, and retain more precise stream-completion and network-error diagnostics.
- Import macOS passkey sessions only after the dedicated Chrome process exits cleanly.
- Keep session reminders above the embedded browser and improve update-error reporting and retry handling.
- Preserve Fame Codex's compact interface, Sleep/Wake, TH AI Pass, connector names and separate DEV profile.
- Adopt the upstream **Temporary Chat** setting. Existing **Save chats** preferences migrate to the equivalent setting; an explicitly configured Temporary Chat preference takes priority.

After installing, run **Setup → Install into Codex → Reinstall**, then fully quit and reopen Codex to refresh Web models. Do not delete launcher data or recreate the plugin just to refresh the model catalog.

The upstream model-selection and environment reports still under investigation are not claimed as resolved by this synchronization. Account limits and model availability still apply.
