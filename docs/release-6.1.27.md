# Fame Codex 6.1.27

- **Intel Macs are no longer supported.** macOS releases are Apple silicon (arm64) only. Existing Intel installs keep working but will not receive updates, and the installers refuse Intel Macs.
- Add **Reset embedded browser data** in Settings. It clears cookies, cache, and site data in the embedded ChatGPT browser; you sign in again and your regular browser and launcher settings are unchanged.
- The embedded browser now follows the launcher language after Fame Codex is fully quit and reopened. ChatGPT may still use its own saved language setting.
- Make reading and selecting the ChatGPT reasoning-effort menu more reliable.
- Recognise sub-agent lists in Codex environment context when recovering a chat's working folder.

Versions 6.1.25 and 6.1.26 were never published; this release supersedes them.

After updating, fully quit Fame Codex from the system tray and reopen it so the runtime restarts. Trusted Codex homes added in 6.1.24 take effect at that restart.
